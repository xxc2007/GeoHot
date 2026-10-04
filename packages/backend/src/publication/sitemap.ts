// Sitemap from the same public metadata as pages: reports, topics and their pages,
// the latest 500 stories, leaderboard pages and indexable items. Cached ~5 minutes and rebuilt in the
// background after that (crawlers get the previous copy meanwhile); if the database fails, the last
// successful sitemap is served (never an empty one). Bounded.
import { FEATURES } from "@aihot/industry/features";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { CJK_TITLE_PATTERN, releasedCondition, selectedCondition } from "./items.ts";
import { listReports } from "./reports.ts";
import { leaderboardUrls } from "../leaderboard/read.ts";
import { topicPageCounts } from "./topics.ts";

async function leaderboardDetailUrls(): Promise<string[]> {
  const fixed = new Set(["/leaderboard", "/leaderboard/sources", "/leaderboard/rules"]);
  return (await leaderboardUrls()).filter((u) => !fixed.has(u) && !u.startsWith("/leaderboard/category/"));
}

const MAX_URLS = 45_000;
const TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "sitemap-last.xml");

let lastGood: string | null = null;

interface Entry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

async function build(readAt = new Date()): Promise<string> {
  const entries: Entry[] = [];
  // The page timestamps describe what a reader can actually open, so they come from the same predicate the
  // lists use: public, released, selected and with Chinese copy. A raw `max(timeline_at)` over every public
  // selected row stamped the front page with an item that is not on it (still waiting behind the gate, or
  // with no Chinese title), which is a lastmod a crawler can never reproduce.
  const [latestItem] = await sql<{ t: Date | null }[]>`SELECT max(p.timeline_at) AS t FROM publications p WHERE ${selectedCondition(readAt)}`;
  // Editions come through the same gate every other outlet uses. Reading the table raw advertised blank
  // issues: eight `/daily/<日期>` locs of which seven opened onto 「本期没有入选内容」.
  const [dailyIndex, weeklyIndex, monthlyIndex] = await Promise.all([
    listReports("daily"),
    listReports("weekly"),
    listReports("monthly"),
  ]);
  const latestDaily = dailyIndex[0] ? { key: dailyIndex[0].key, t: new Date(dailyIndex[0].generatedAt) } : null;
  const now = latestItem?.t ?? new Date();
  entries.push(
    { loc: "/", lastmod: now, changefreq: "hourly", priority: 1 },
    { loc: "/all", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.9 },
    { loc: "/hot", lastmod: now, changefreq: "hourly", priority: 0.9 },
    { loc: "/daily/archive", lastmod: latestDaily?.t, changefreq: "daily", priority: 0.7 },
    { loc: "/weekly", changefreq: "weekly", priority: 0.7 },
    { loc: "/monthly", changefreq: "monthly", priority: 0.6 },
    { loc: "/topics", changefreq: "daily", priority: 0.7 },
    { loc: "/agent", lastmod: now, changefreq: "weekly", priority: 0.7 },
    { loc: "/about", changefreq: "monthly", priority: 0.5 },
    { loc: "/terms", changefreq: "monthly", priority: 0.4 },
    { loc: "/privacy", changefreq: "monthly", priority: 0.4 },
    { loc: "/changelog", lastmod: now, changefreq: "weekly", priority: 0.5 },
  );
  if (FEATURES.leaderboard) {
    entries.push(
      { loc: "/leaderboard", changefreq: "daily", priority: 0.8 },
      { loc: "/leaderboard/sources", changefreq: "weekly", priority: 0.5 },
      { loc: "/leaderboard/rules", changefreq: "monthly", priority: 0.4 },
    );
    for (const board of ["coding", "reasoning", "knowledge", "professional"]) entries.push({ loc: `/leaderboard/category/${board}`, changefreq: "daily", priority: 0.6 });
  }
  if (FEATURES.codexResetMonitor) entries.push({ loc: "/codex-reset", changefreq: "hourly", priority: 0.6 });
  for (const r of [
    ...dailyIndex.map((e) => ({ kind: "daily" as const, key: e.key, at: e.generatedAt })),
    ...weeklyIndex.map((e) => ({ kind: "weekly" as const, key: e.key, at: e.generatedAt })),
    ...monthlyIndex.map((e) => ({ kind: "monthly" as const, key: e.key, at: e.generatedAt })),
  ]) {
    entries.push({ loc: `/${r.kind}/${r.key}`, lastmod: new Date(r.at), changefreq: r.kind === "daily" ? "never" : "monthly", priority: 0.6 });
  }
  for (const t of await topicPageCounts()) {
    if (!t.indexable) continue;
    entries.push({ loc: `/topics/${t.slug}`, lastmod: t.latest, changefreq: "daily", priority: 0.6 });
    for (let p = 2; p <= t.pages; p++) entries.push({ loc: `/topics/${t.slug}/page/${p}`, lastmod: t.latest, changefreq: "weekly", priority: 0.3 });
  }
  // Stories with reports of their own; pages that only gather reports grouped elsewhere (imported story
  // levels, regrouped history) are reachable but not listed. `title ~ CJK` narrows "listed" to what the site
  // can hand a crawler in Chinese: 2026-10-04 晚 measured 474 English-only story pages, and the page gate for
  // them was tried and reverted (see `events/story-reports.ts` and `docs/known-issues.md`) — a page may stay
  // reachable, but this list is the one place that *promises* content to search engines.
  const stories = await sql<{ public_id: string; latest_at: Date | null }[]>`
    SELECT public_id::text, latest_at FROM stories WHERE merged_into IS NULL AND title ~ ${CJK_TITLE_PATTERN} AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND fa.role IN ('primary', 'report') AND p.visibility = 'public' AND p.eligible)
    ORDER BY latest_at DESC NULLS LAST LIMIT 500`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.5 });
  // Model pages exist only for models on a public top-30 board; source pages for every registered source.
  if (FEATURES.leaderboard) for (const loc of await leaderboardDetailUrls()) entries.push({ loc, changefreq: "weekly", priority: 0.4 });
  // Indexable item pages — minus anything the release gate still holds back: `indexable` is a stored
  // projection (nothing recomputes it when an embargo lifts), so the gate has to be applied here. Listing
  // an embargoed item is how a URL that answers 404 for its first three minutes gets handed to a crawler.
  // The table is aliased because `releasedCondition` qualifies its columns (`p.selected`): without the
  // alias every build threw 42P01 and /sitemap.xml answered 503 on a fresh install.
  const items = await sql<{ id: string; t: Date }[]>`
    SELECT p.article_id AS id, p.updated_at AS t FROM publications p
    WHERE p.visibility = 'public' AND p.indexable AND ${releasedCondition(readAt)} ORDER BY p.timeline_at DESC LIMIT ${MAX_URLS - entries.length}`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.5 });

  const body = entries
    .slice(0, MAX_URLS)
    .map((e) => {
      const parts = [`<loc>${escapeXml(siteUrl(e.loc))}</loc>`];
      if (e.lastmod) parts.push(`<lastmod>${e.lastmod.toISOString()}</lastmod>`);
      if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
      if (e.priority !== undefined) parts.push(`<priority>${e.priority}</priority>`);
      return `<url>\n${parts.join("\n")}\n</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

const sitemap = cached(refreshSitemap, { freshMs: TTL_MS, maxStaleMs: 60 * 60_000 });

export function sitemapXml(): Promise<string> {
  return sitemap.get();
}

async function refreshSitemap(): Promise<string> {
  try {
    const xml = await build();
    lastGood = xml;
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    // A read-only data directory is a real deployment state (the container mounts it ro), and the sitemap
    // still serves from memory, so this must not fail the build. It must not be invisible either: the file
    // is the fallback for the next restart, and a silently missing one is discovered at the worst time.
    await writeFile(CACHE_FILE, xml).catch((error) => {
      console.log(JSON.stringify({ level: "warn", msg: `sitemap cache file not written: ${CACHE_FILE}`, error: String(error) }));
    });
    return xml;
  } catch (error) {
    if (lastGood) return lastGood;
    const last = await readFile(CACHE_FILE, "utf8").catch(() => null);
    if (last) return last;
    throw error;
  }
}
