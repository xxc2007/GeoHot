// Figures for the about page: how much the site covers, counted from the public read layer and kept for
// ten minutes per process (the page itself is cached for five); an older copy is served while the
// counts are read again. That grace ends an hour after the last successful read (`lib/cache.ts:37-42`),
// after which a reader waits for the count — so the count still has to finish: see the safety net below.
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

/**
 * 2026-11-27：这条 6 个 `count(*)` 的查询里，`items` 与 `collected` 是 publications 全表（13.4 万行）扫描，
 * 生产实测单独一条 count 就要 36–60 秒，整条被采样到 72 秒。它此前既没有 statement_timeout、也没有并发闸
 * （`apps/api/src/routes/site.ts:424` 直接 await `loadSiteStats`），只靠 10 分钟进程缓存顶着；下面的
 * 90 秒预算就是给它补的安全网。
 *
 * 预算取 90 秒，**高于**上面那两个实测值，理由是这条预算只当安全网：读得完就照旧成功、把缓存续上；
 * 只有比实测还慢一个量级时才 57014。不要把它收紧到 12–20 秒——`cached` 的兜底是
 * 「age < maxStaleMs 才发旧值」（lib/cache.ts:37-42），stats 的 maxStaleMs 只有 1 小时；预算一低于常态耗时，
 * 一小时之后就变成「每次请求都等满预算再 503」，比现在的「等 36–72 秒然后成功」更差。
 *
 * 只包这一条：同一条 Promise.all 里的信源分组、180 条抽样、最新 8 条都是走索引的小读（sources 全表
 * 几十行、LIMIT 8/180），把它们塞进同一个事务会把并发（max）变成串行（sum），墙钟更容易变长——它们
 * 仍然没有 statement_timeout，这里明确记下来，别当成「stats 已经全都有预算了」。
 */
const STATS_COUNT_BUDGET = "90s";

async function boundedStats<T>(read: (db: typeof sql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout', ${STATS_COUNT_BUDGET}, true), set_config('lock_timeout', '1500ms', true)`;
    return read(tx as unknown as typeof sql) as Promise<T>;
  }) as T;
}

async function querySiteStats(now: Date, lang: SiteLang = "zh"): Promise<SiteStats> {
  const en = lang === "en";
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  // 只有第一条带预算，其余四条保持并发（见上面 STATS_COUNT_BUDGET 的说明）。
  // `listReports("daily")` 走的是另一套读层（reports 表按 kind/key 有索引、只取最近若干期），同样没有
  // statement_timeout——它不在这次慢路径的采样里，但也不该被误认为已经收进预算。
  const [[row], kinds, sample, latest, dailies] = await Promise.all([
    boundedStats<Array<Omit<SiteStats, "sourceKinds" | "day" | "sampleSources" | "latest" | "dailies"> & { collected: number; selectedDay: number }>>((db) => db`
      SELECT (SELECT count(*) FROM sources WHERE enabled)::int AS sources,
             (SELECT count(*) FROM sources WHERE enabled AND participation_mode = 'hot_signal')::int AS "heatOnlySources",
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn')::int AS items,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now, lang)})::int AS selected,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND p.discovered_at > ${dayAgo})::int AS collected,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now, lang)} AND p.timeline_at > ${dayAgo})::int AS "selectedDay"`),
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
