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
import { chineseCopyCondition } from "./items.ts";
import { FACT_MEMBER_ROLES } from "./rules.ts";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { releasedCondition, selectedCondition } from "./items.ts";
import { listReports } from "./reports.ts";
import { leaderboardUrls } from "../leaderboard/read.ts";
import { topicPageCounts } from "./topics.ts";
import { englishTextMode } from "./english-policy.ts";
import { englishReadyCondition } from "./readiness-en.ts";

async function leaderboardDetailUrls(): Promise<string[]> {
  const fixed = new Set(["/leaderboard", "/leaderboard/sources", "/leaderboard/rules"]);
  return (await leaderboardUrls()).filter((u) => !fixed.has(u) && !u.startsWith("/leaderboard/category/"));
}

const MAX_URLS = 45_000;
/** 英文内容页的单独名额：不挤占中文名额（中文内容页永远优先）。 */
const MAX_EN_URLS = 5_000;
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
  // 首页/列表卡的 lastmod 时钟。放行门（releasedCondition）一律用本构建的 readAt：同文件里 items
  // 查询已经这么用（见下），stories 曾用 `now`（= latestItem.t，最新精选条的过去时刻）——
  // visible_after 落在两者之间的故事页这轮构建不列，下一轮才列，双钟口径归一。
  const now = latestItem?.t ?? new Date();
  // 英文界面框架（apps/web routes.ts 的 /en 前缀副本路由）与这十三页一一对应，lastmod/changefreq/
  // priority 同参：这些页是界面 chrome 的英文版，始终列出。
  // 英文内容页（条目/事件/主题/日报）只在 `ENGLISH_TEXT=strict` 时另列，并且用单独名额
  // （`MAX_EN_URLS`）——`fallback` 模式的中文回退页不能当英文页承诺给爬虫。
  const staticPages: Entry[] = [
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
  ];
  entries.push(...staticPages, ...staticPages.map((e) => ({ ...e, loc: e.loc === "/" ? "/en" : `/en${e.loc}` })));
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
    SELECT public_id::text, latest_at FROM stories WHERE merged_into IS NULL AND title ~ ${CJK_COPY_PATTERN} AND EXISTS (
      SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = stories.id AND fa.role = ANY(${FACT_MEMBER_ROLES}) AND p.visibility = 'public' AND p.eligible
        AND ${releasedCondition(readAt)})
    ORDER BY latest_at DESC NULLS LAST LIMIT 500`;
  for (const s of stories) entries.push({ loc: `/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.5 });
  // Model pages exist only for models on a public top-30 board; source pages for every registered source.
  if (FEATURES.leaderboard) for (const loc of await leaderboardDetailUrls()) entries.push({ loc, changefreq: "weekly", priority: 0.4 });
  // Indexable item pages — minus anything the release gate still holds back: `indexable` is a stored
  // projection (nothing recomputes it when an embargo lifts), so the gate has to be applied here. Listing
  // an embargoed item is how a URL that answers 404 for its first three minutes gets handed to a crawler.
  // The table is aliased because `releasedCondition` qualifies its columns (`p.selected`): without the
  // alias every build threw 42P01 and /sitemap.xml answered 503 on a fresh install.
  // `MAX_URLS - entries.length` 在 entries 已经装满时会变成负数，而 PostgreSQL 拒绝负 LIMIT
  // （整份 sitemap 直接 503）。没有名额就不查，名额用 Math.max(0, …) 夹住。
  const room = Math.max(0, MAX_URLS - entries.length);
  const items = room === 0 ? [] : await sql<{ id: string; t: Date }[]>`
    SELECT p.article_id AS id, p.updated_at AS t FROM publications p
    WHERE p.visibility = 'public' AND p.indexable AND ${releasedCondition(readAt)} AND ${chineseCopyCondition()} ORDER BY p.timeline_at DESC LIMIT ${room}`;
  for (const it of items) entries.push({ loc: `/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.5 });

  // 英文内容页：只有 strict 才列。每条都按英文门验证，回退中文的页面不承诺。
  if (englishTextMode() === "strict") {
    const en: Entry[] = [];
    const enItemGate = englishReadyCondition(readAt);
    const enItems = await sql<{ id: string; t: Date }[]>`
      SELECT p.article_id AS id, p.updated_at AS t FROM publications p
      WHERE p.visibility = 'public' AND p.indexable AND ${enItemGate} ORDER BY p.timeline_at DESC LIMIT ${MAX_EN_URLS}`;
    for (const it of enItems) en.push({ loc: `/en/items/${it.id}`, lastmod: it.t, changefreq: "monthly", priority: 0.4 });
    const enStories = await sql<{ public_id: string; latest_at: Date | null }[]>`
      SELECT public_id::text, latest_at FROM stories
      WHERE merged_into IS NULL AND nullif(btrim(title_en), '') IS NOT NULL AND title_en !~ ${CJK_COPY_PATTERN} AND EXISTS (
        SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
        WHERE f.story_id = stories.id AND fa.role = ANY(${FACT_MEMBER_ROLES}) AND p.visibility = 'public' AND p.eligible
          AND ${releasedCondition(readAt)})
      ORDER BY latest_at DESC NULLS LAST LIMIT ${Math.max(0, MAX_EN_URLS - en.length)}`;
    for (const s of enStories) en.push({ loc: `/en/story/${s.public_id}`, lastmod: s.latest_at, changefreq: "daily", priority: 0.4 });
    // 英文主题页只在主题名有英文时列；计数用 en 名单（与页面同一套成员门）。
    const enCounts = new Map((await topicPageCounts(readAt, "en")).map((t) => [t.slug, t]));
    const enTopics = await sql<{ slug: string; name_en: string | null; dormant_at: Date | null }[]>`
      SELECT slug, name_en, dormant_at FROM topics WHERE nullif(btrim(name_en), '') IS NOT NULL AND dormant_at IS NULL ORDER BY position`;
    for (const t of enTopics) {
      const c = enCounts.get(t.slug);
      if (!c?.indexable) continue;
      en.push({ loc: `/en/topics/${t.slug}`, lastmod: c.latest, changefreq: "daily", priority: 0.4 });
      for (let p = 2; p <= c.pages; p++) en.push({ loc: `/en/topics/${t.slug}/page/${p}`, lastmod: c.latest, changefreq: "weekly", priority: 0.2 });
    }
    // 英文刊面直接取 `/en` 索引的门（`listReports(..., 'en')`）：它与 `loadReport` 共用同一对判据。
    // 以前这里另写一条 SQL，只查散文与快照数量；引用快照没覆盖全的旧刊会既进 sitemap 又在详情页 404。
    const [enDailies, enWeeklies, enMonthlies] = await Promise.all([
      listReports("daily", undefined, "en"),
      listReports("weekly", undefined, "en"),
      listReports("monthly", undefined, "en"),
    ]);
    const enReportKeys = new Set([
      ...enDailies.map((r) => `daily:${r.key}`),
      ...enWeeklies.map((r) => `weekly:${r.key}`),
      ...enMonthlies.map((r) => `monthly:${r.key}`),
    ]);
    for (const [kind, index] of [["daily", dailyIndex], ["weekly", weeklyIndex], ["monthly", monthlyIndex]] as const) {
      for (const r of index) {
        if (!enReportKeys.has(`${kind}:${r.key}`)) continue;
        en.push({ loc: `/en/${kind}/${r.key}`, lastmod: new Date(r.generatedAt), changefreq: kind === "daily" ? "never" : "monthly", priority: 0.4 });
      }
    }
    entries.push(...en.slice(0, MAX_EN_URLS));
  }

  const body = entries
    .slice(0, MAX_URLS + MAX_EN_URLS)
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
