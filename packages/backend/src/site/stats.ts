// Figures for the about page: how much the site covers, counted from the public read layer and kept for
// ten minutes per process (the page itself is cached for five); an older copy is served while the
// counts are read again, so no reader waits for the full-table counts.
import type { SiteLang, SiteStats } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { selectedCondition } from "../publication/items.ts";
import { listReports } from "../publication/reports.ts";
import { sourceNameFor } from "../publication/source-name.ts";

export type { SiteStats };

/** How many sources the about page's river draws, at most. */
const SAMPLE = 180;

// 统计按语言分桶：en 的精选数来自 en 名单，标题/信源名也按语言投影。
const stats = new Map<SiteLang, Cached<SiteStats>>();

export function loadSiteStats(lang: SiteLang = "zh"): Promise<SiteStats> {
  let entry = stats.get(lang);
  if (!entry) {
    entry = cached(() => querySiteStats(new Date(), lang), { freshMs: 10 * 60_000, maxStaleMs: 60 * 60_000 });
    stats.set(lang, entry);
  }
  return entry.get();
}

async function querySiteStats(now: Date, lang: SiteLang = "zh"): Promise<SiteStats> {
  const en = lang === "en";
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [[row], kinds, sample, latest, dailies] = await Promise.all([
    sql<Array<Omit<SiteStats, "sourceKinds" | "day" | "sampleSources" | "latest" | "dailies"> & { collected: number; selectedDay: number }>>`
      SELECT (SELECT count(*) FROM sources WHERE enabled)::int AS sources,
             (SELECT count(*) FROM sources WHERE enabled AND participation_mode = 'hot_signal')::int AS "heatOnlySources",
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn')::int AS items,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now, lang)})::int AS selected,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND p.discovered_at > ${dayAgo})::int AS collected,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now, lang)} AND p.timeline_at > ${dayAgo})::int AS "selectedDay"`,
    sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM sources WHERE enabled GROUP BY kind`,
    // A shuffle that holds for the day, so the river keeps its sources between visits.
    sql<{ name: string; name_en: string | null; canonical_url: string | null; kind: string; heat_only: boolean }[]>`
      SELECT name, name_en, canonical_url, kind, participation_mode = 'hot_signal' AS heat_only FROM sources WHERE enabled
      ORDER BY md5(id::text || ${now.toISOString().slice(0, 10)}) LIMIT ${SAMPLE}`,
    sql<{ id: string; title: string; title_en: string | null; source: string; source_name_en: string | null; url: string }[]>`
      SELECT p.article_id AS id, p.title, p.title_en, s.name AS source, s.name_en AS source_name_en, p.url FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE ${selectedCondition(now, lang)} ORDER BY p.timeline_at DESC LIMIT 8`,
    // 「已出 N 期」必须是读者真能翻开的期数：读层那道门（`listReports`）会跳过头排得出、但引注已经全部
    // 撤下的那几期。2026-10-06 线上实测：/about 印 12 期，同一页的归档写着「共 2 期」。
    listReports("daily"),
  ]);
  const { collected, selectedDay, ...totals } = row!;
  const value: SiteStats = {
    ...totals,
    lang,
    dailies: dailies.length,
    sourceKinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    day: { collected, selected: selectedDay },
    sampleSources: sample.map((s) => ({
      name: sourceNameFor(lang, s.name, s.name_en, s.canonical_url),
      kind: s.kind,
      heatOnly: s.heat_only,
      ...(s.name_en?.trim() ? { nameEn: s.name_en } : {}),
    })),
    latest: latest.map((l) => ({
      id: l.id,
      title: en && l.title_en?.trim() ? l.title_en : l.title,
      source: sourceNameFor(lang, l.source, l.source_name_en, l.url),
      ...(l.title_en?.trim() ? { titleEn: l.title_en } : {}),
      ...(l.source_name_en?.trim() ? { sourceNameEn: l.source_name_en } : {}),
    })),
  };
  return value;
}
