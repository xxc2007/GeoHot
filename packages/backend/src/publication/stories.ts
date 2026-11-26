// Stories (events) and the hot ranking through the public read layer. The website sees heat values;
// v1 / MCP / Skill only see ranks and counts.
import type { HeatPoint, HotResponse, SiteLang, StoryDetail, StoryReportView } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { latestHotRanking, rankingExtras } from "../events/hot-read.ts";
import { behindSources, sourceClocks } from "../events/hot.ts";
import { storyReports, type StoryReport } from "../events/story-reports.ts";
import { storyStatusFor } from "../events/digest.ts";
import { itemUrl, storyApiUrl, storyUrl } from "./links.ts";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { releasedCondition } from "./items.ts";
import { englishTextMode, textLocaleOf } from "./english-policy.ts";
import { sourceNameFor } from "./source-name.ts";
import { SITE } from "@aihot/industry/site";
import { UUID_PATTERN } from "@aihot/contracts/taxonomy";

export type StoryLookup = { kind: "found"; storyId: number; publicId: string } | { kind: "merged"; target: string } | { kind: "not_found" };

export async function resolveStory(publicId: string): Promise<StoryLookup> {
  if (!UUID_PATTERN.test(publicId)) return { kind: "not_found" };
  const [s] = await sql<{ id: number; merged_into: number | null }[]>`SELECT id, merged_into FROM stories WHERE public_id = ${publicId}`;
  let targetId: number | null = s ? (s.merged_into ?? null) : null;
  if (!s) {
    const [alias] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_aliases WHERE public_id = ${publicId}`;
    if (!alias) return { kind: "not_found" };
    targetId = alias.story_id;
  }
  if (targetId) {
    // Follow merge chains to the surviving story.
    for (let i = 0; i < 10; i++) {
      const rows: Array<{ id: number; public_id: string; merged_into: number | null }> = await sql`SELECT id, public_id::text, merged_into FROM stories WHERE id = ${targetId}`;
      const t = rows[0];
      if (!t) return { kind: "not_found" };
      if (!t.merged_into) return { kind: "merged", target: t.public_id };
      targetId = t.merged_into;
    }
    return { kind: "not_found" };
  }
  return { kind: "found", storyId: s!.id, publicId };
}

/** The page's own shape for one report; the query behind it is shared with the worker (see `storyContent`). */
function reportView(r: StoryReport, lang: SiteLang = "zh"): StoryReportView {
  const en = lang === "en";
  // /en 的报道标题：有英文稿用英文稿，否则用信源原题（若原题本来不是中文）；两者都没有就留空，
  // 由 loadStoryDetail 从英文时间线里过滤掉，不拿中文整理标题兜底。
  const title = en ? (r.titleEn?.trim() || (r.originalTitle && !hasChineseCopy(r.originalTitle) ? r.originalTitle.trim() : "")) : r.title;
  // 英文页没有英文摘要就不显示摘要：中文回退只属于 fallback 模式，strict 下这条报道不该在英文时间线里夹中文。
  const summary = en ? (r.summaryEn?.trim() ? r.summaryEn : null) : r.summary;
  const sourceName = sourceNameFor(lang, r.sourceName, r.sourceNameEn, r.url);
  return {
    id: r.id,
    title,
    summary,
    source: { id: r.sourceId, name: sourceName, kind: r.sourceKind as never, firstParty: r.firstParty, iconUrl: proxiedImage(r.iconUrl, "avatar"), nameLocale: en ? "en" : "zh" },
    publishedAt: r.at.toISOString(),
    originalUrl: r.url,
    selected: r.selected,
    factId: r.factPublicId,
    textLocale: textLocaleOf(title, summary),
  };
}

/**
 * The event page and the worker read the same query (`events/story-reports.ts`): the 综述 and the event
 * title's identity guard are written from exactly what this timeline lists, and the 报道数 on the page, in
 * the ranking and on the share card is one number. It arrives oldest first (the order a digest is written
 * in); the page reads it newest first.
 */
async function storyContent(storyId: number, now: Date, lang: SiteLang = "zh") {
  const en = lang === "en";
  const [s] = await sql<{ public_id: string; title: string; title_en: string | null; summary: string | null; summary_en: string | null; first_report_at: Date | null; latest_at: Date | null; digest: string | null; digest_en: string | null; digest_updated_at: Date | null; latest: string | null; latest_en: string | null }[]>`
    SELECT public_id::text, title, title_en, summary, summary_en, first_report_at, latest_at, digest, digest_en, digest_updated_at, latest, latest_en
      FROM stories WHERE id = ${storyId}`;
  if (!s) return null;
  const reports = await storyReports(storyId, now);
  if (reports.length === 0) return null;
  reports.sort((a, b) => b.at.getTime() - a.at.getTime());

  const byFact = new Map<number, StoryReport[]>();
  for (const r of reports) byFact.set(r.factId, [...(byFact.get(r.factId) ?? []), r]);
  const facts = await sql<{ id: number; public_id: string; title: string; title_en: string | null; occurred_at: Date | null; created_at: Date }[]>`
    SELECT id, public_id, title, title_en, occurred_at, created_at FROM facts WHERE story_id = ${storyId}`;
const developments = facts
    .filter((f) => byFact.has(f.id))
    .map((f) => {
      const members = byFact.get(f.id)!;
      const rep = [...members].sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || Number(b.selected) - Number(a.selected) || a.at.getTime() - b.at.getTime())[0]!;
      const first = members.reduce((m, r) => (r.at < m ? r.at : m), members[0]!.at);
      const title = en && f.title_en?.trim() ? f.title_en : f.title;
      return { factId: f.public_id, title, occurredAt: f.occurred_at?.toISOString() ?? null, firstReportAt: first.toISOString(), reportCount: members.length, representative: rep };
    })
    // 英文页只列有英文标题的进展；没有英文的进展留在时间线里（报道本身还有英文标题），
    // 但不在「事件进展」那一栏夹一行中文。
    .filter((d) => !en || !hasChineseCopy(d.title))
    .sort((a, b) => Date.parse(b.firstReportAt) - Date.parse(a.firstReportAt));

  return { s: {
    ...s,
    title: en && s.title_en?.trim() ? s.title_en : s.title,
    summary: en ? (s.summary_en?.trim() ? s.summary_en : null) : s.summary,
    digest: en ? (s.digest_en?.trim() ? s.digest_en : s.digest) : s.digest,
    latest: en ? (s.latest_en?.trim() ? s.latest_en : null) : s.latest,
  }, reports, developments };
}

async function relatedStories(storyId: number, lang: SiteLang = "zh") {
  return sql<{ public_id: string; title: string; title_en: string | null; relation: "storyline" | "related"; latest_at: Date | null }[]>`
    SELECT st.public_id::text, st.title, st.title_en, l.relation, st.latest_at FROM story_links l JOIN stories st ON st.id = l.other_id
    WHERE l.story_id = ${storyId} AND st.merged_into IS NULL ORDER BY st.latest_at DESC NULLS LAST LIMIT 8`;
}

export async function loadStoryDetail(storyId: number, now = new Date(), lang: SiteLang = "zh"): Promise<StoryDetail | null> {
  const content = await storyContent(storyId, now, lang);
  if (!content) return null;
  const { s, reports, developments } = content;
  const [why] = await sql<{ p48: number; p6: number; r24: number }[]>`
    SELECT count(DISTINCT participant_key) FILTER (WHERE observed_at > ${now}::timestamptz - interval '48 hours') AS p48,
           count(DISTINCT participant_key) FILTER (WHERE observed_at > ${now}::timestamptz - interval '6 hours'
             AND participant_key NOT IN (SELECT participant_key FROM story_signals x WHERE x.story_id = ${storyId} AND x.observed_at <= ${now}::timestamptz - interval '6 hours')) AS p6,
           count(*) FILTER (WHERE kind = 'editorial' AND observed_at > ${now}::timestamptz - interval '24 hours') AS r24
    FROM story_signals WHERE story_id = ${storyId} AND observed_at <= ${now}`;
  const ranking = await latestHotRanking();
  const entry = ranking?.entries.find((e) => e.storyId === storyId) ?? null;
  // Only hours observed in full are drawn (the chart leaves a gap otherwise).
  const heat = await sql<{ hour: Date; heat: number; participants: number }[]>`
    SELECT hour, heat, participants FROM story_heat_hourly WHERE story_id = ${storyId} AND complete AND hour > ${now}::timestamptz - interval '7 days' ORDER BY hour`;
  // Complete when none of the sources behind the last 48 hours' participants is behind on collection.
  const behind = behindSources(await sourceClocks(), now.getTime(), true);
  const [partial] = behind.length
    ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM story_signals WHERE story_id = ${storyId} AND source_id = ANY(${behind}::text[])
                                  AND observed_at > ${now}::timestamptz - interval '48 hours' AND observed_at <= ${now}`
    : [{ n: 0 }];
  const related = await relatedStories(storyId, lang);
  const en = lang === "en";
  // /en 的时间线只列有英文标题的报道；中文整理标题不再兜底（没有英文的报道仍可在中文页看到）。
  const visibleReports = en ? reports.filter((r) => !!reportView(r, lang).title) : reports;
  const visibleViews = visibleReports.map((r) => reportView(r, lang));
  const latestAt = s.latest_at ?? visibleReports[0]?.at ?? reports[0]!.at;
  const storyLocale = textLocaleOf(s.title, s.digest?.trim() ? s.digest : s.summary ?? null);
  // strict 的 /en 只把真有英文标题与英文综述的事件当英文页；否则读者看到的会是一条中文事件
  // 挂着英文 chrome（2026-11-23 验收：/en/story/… 全英文正文上仍说「这一页还没有英文版」）。
  if (en && englishTextMode() === "strict" && storyLocale !== "en") return null;
  // Without a digest or a summary of its own, the story opens with its first development's representative report.
  const origin = developments[developments.length - 1]?.representative;
  const visibleDevelopments = developments.filter((d) => !en || !!reportView(d.representative, lang).title);
  const excerptText = origin ? (en ? (origin.summaryEn?.trim() || (origin.summary && !hasChineseCopy(origin.summary) ? origin.summary : null)) : origin.summary) : null;
  return {
    publicId: s.public_id,
    title: s.title,
    textLocale: storyLocale,
    lang,
    // 中文页仍用中文标题作索引承诺；`/en` 看英文标题是否真的存在。
    indexable: en ? !!s.title_en?.trim() && !hasChineseCopy(s.title_en) : hasChineseCopy(s.title),
    status: storyStatusFor(latestAt, now.getTime()),
    reportCount: visibleReports.length,
    sourceCount: new Set(visibleReports.map((r) => r.sourceId)).size,
    firstReportAt: (s.first_report_at ?? visibleReports[visibleReports.length - 1]?.at ?? reports[reports.length - 1]!.at).toISOString(),
    latestAt: latestAt.toISOString(),
    digest: s.digest,
    digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
    summary: s.summary,
    excerpt: !s.digest && !s.summary && excerptText && origin
      ? {
        text: excerptText,
        sourceName: sourceNameFor(lang, origin.sourceName, origin.sourceNameEn, origin.url),
      }
      : null,
    latest: s.latest,
    whyHot: {
      participants48h: Number(why?.p48 ?? 0),
      newParticipants6h: Number(why?.p6 ?? 0),
      recentReports24h: Number(why?.r24 ?? 0),
      observationComplete: !partial?.n,
      rank: entry?.rank ?? null,
      heat: entry?.heat ?? null,
    },
    developments: visibleDevelopments.map((d) => ({ ...d, textLocale: textLocaleOf(d.title, null), representative: reportView(d.representative, lang) })),
    officialReports: visibleReports.filter((r) => r.firstParty).slice(0, 12).map((r) => reportView(r, lang)),
    timeline: visibleViews.slice(0, 100),
    heat: heat.map((h): HeatPoint => ({ hour: h.hour.toISOString(), heat: Number(h.heat), participants: h.participants })),
    related: related.map((r) => ({ publicId: r.public_id, title: lang === "en" && r.title_en?.trim() ? r.title_en : r.title, relation: r.relation, latestAt: r.latest_at?.toISOString() ?? null }))
      // 相关事件没有英文标题就不在英文页露出来（中文页照旧）。
      .filter((r) => lang !== "en" || !hasChineseCopy(r.title)),
  };
}

const SPARK_HOURS = 24;

/** Hourly heat of the ranked stories over the day before the ranking, one slot per hour. */
async function sparklines(storyIds: number[], at: Date): Promise<Map<number, Array<number | null>>> {
  const end = Math.floor(at.getTime() / 3600000) * 3600000;
  const start = end - SPARK_HOURS * 3600000;
  const rows = storyIds.length
    ? await sql<{ story_id: number; hour: Date; heat: string }[]>`
        SELECT story_id, hour, heat FROM story_heat_hourly
        WHERE story_id = ANY(${storyIds}::bigint[]) AND complete AND hour >= ${new Date(start)} AND hour <= ${new Date(end)}`
    : [];
  const out = new Map<number, Array<number | null>>(storyIds.map((id) => [id, Array.from({ length: SPARK_HOURS + 1 }, () => null)]));
  for (const r of rows) {
    const slot = Math.round((r.hour.getTime() - start) / 3600000);
    const line = out.get(Number(r.story_id));
    if (line && slot >= 0 && slot <= SPARK_HOURS) line[slot] = Number(r.heat);
  }
  return out;
}

// Pictures for a ranking change only with the ranking, so they are read once per ranking.
type HotCoverMap = Map<number, { url: string; width: number | null; height: number | null }>;
let coversCache: { rankingId: number; covers: HotCoverMap } | null = null;
const coversPending = new Map<number, Promise<HotCoverMap>>();

/** A picture per story from its public full-text reports, the representative first, wide enough for a card. */
async function hotCovers(rankingId: number, entries: Array<{ storyId: number; representativeItemId: string | null }>, at: Date) {
  if (coversCache?.rankingId === rankingId) return coversCache.covers;
  const pending = coversPending.get(rankingId);
  if (pending) return pending;
  const load = queryHotCovers(entries, at);
  coversPending.set(rankingId, load);
  try {
    const covers = await load;
    coversCache = { rankingId, covers };
    return covers;
  } finally { coversPending.delete(rankingId); }
}

async function queryHotCovers(entries: Array<{ storyId: number; representativeItemId: string | null }>, at: Date) {
  const ids = entries.map((e) => e.storyId);
  const reps = entries.map((e) => e.representativeItemId).filter((id): id is string => !!id);
  const rows = await sql<{ story_id: number; m: { url: string; width?: number; height?: number } }[]>`
    SELECT DISTINCT ON (p.story_id) p.story_id, img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE p.story_id = ANY(${ids}::bigint[]) AND p.visibility = 'public' AND p.eligible AND p.body_mode <> 'summary'
      AND ${releasedCondition(at)}
    ORDER BY p.story_id, (p.article_id::text = ANY(${reps}::text[])) DESC, p.first_party DESC, p.selected DESC, coalesce(p.score, 0) DESC, p.article_id`;
  const covers = new Map(rows.map((c) => [Number(c.story_id), { url: c.m.url, width: typeof c.m.width === "number" ? c.m.width : null, height: typeof c.m.height === "number" ? c.m.height : null }]));
  return covers;
}

export async function loadHot(lang: SiteLang = "zh"): Promise<HotResponse> {
  const ranking = await latestHotRanking(lang);
  if (!ranking) {
    // A successful empty computation still has a cut-off time. Do not publish stale entries,
    // and do not turn an empty result into the indistinguishable "never computed" state.
    const [latest] = await sql<{ computed_at: Date; rule_version: string }[]>`
      SELECT computed_at, rule_version FROM hot_rankings ORDER BY computed_at DESC LIMIT 1`;
    return { computedAt: latest?.computed_at.toISOString() ?? null, ruleVersion: latest?.rule_version ?? null, windowHours: 48, entries: [], lang };
  }
  const at = new Date(ranking.computedAt);
  const [sparks, covers, extras] = await Promise.all([
    sparklines(
      ranking.entries.map((e) => e.storyId),
      at,
    ),
    hotCovers(ranking.id, ranking.entries, at),
    rankingExtras(ranking, lang),
  ]);
  return {
    computedAt: ranking.computedAt,
    ruleVersion: ranking.ruleVersion,
    windowHours: 48,
    entries: ranking.entries
      // 英文页（strict）只保留真有英文事件名的行：缺英文的事件会退回中文标题——2026-11-27 站长
      // 截图里 /en 的 Trending 与 /en/hot 就是这样混进中文的。rank 仍按榜单原值，看得出被略过的位次。
      // `ENGLISH_TEXT=fallback` 时保持旧行为（回退中文），那是这个开关本来的意义。
      .filter((e) => lang !== "en" || englishTextMode() !== "strict" || !!extras.text(e).title)
      .map((e) => {
      const picture = covers.get(e.storyId);
      const coverUrl = picture ? proxiedImage(picture.url, "full") : null;
      const text = extras.text(e);
      return {
        rank: e.rank,
        story: { publicId: e.storyPublicId, title: text.title },
        heat: e.heat,
        trend: e.trend,
        trendPct: e.trendPct,
        badges: e.badges,
        participantCount: e.participantCount,
        sourceCount: e.sourceCount,
        signalCount: e.signalCount,
        reportCount: e.reportCount,
        sourceNames: extras.sourceNames(e),
        sourceNamesEn: extras.sourceNamesEn(e),
        latestAt: e.latestAt,
        firstReportAt: e.firstReportAt,
        representative: e.representativeItemId ? { id: e.representativeItemId, url: e.representativeUrl ?? "", sourceName: extras.sourceName(e.representativeSource ?? "") } : null,
        participants: extras.participants(e),
        spark: sparks.get(e.storyId) ?? [],
        summary: text.summary,
        latest: text.latest,
        cover: picture && coverUrl ? { url: coverUrl, srcSet: proxiedImageSet(picture.url, "hero") ?? undefined, width: picture.width, height: picture.height } : null,
        textLocale: text.textLocale,
      };
    }),
    lang,
  };
}

// ---------------------------------------------------------------------------
// v1 shapes (ranks and counts only; no heat values)
// ---------------------------------------------------------------------------

export async function v1HotTopics() {
  const ranking = await latestHotRanking();
  const items = (ranking?.entries ?? []).map((e) => ({
    rank: e.rank,
    id: e.representativeItemId ?? e.storyPublicId,
    title: e.title,
    source: { name: e.representativeSource ?? e.sourceNames[0] ?? SITE.name },
    links: {
      aihot: e.representativeItemId ? itemUrl(e.representativeItemId) : storyUrl(e.storyPublicId),
      original: e.representativeUrl ?? storyUrl(e.storyPublicId),
      story: storyUrl(e.storyPublicId),
    },
    sourceCount: e.sourceCount,
    signalCount: e.signalCount,
    participantCount: e.participantCount,
    sourceNames: e.sourceNames,
    latestAt: new Date(e.latestAt).toISOString(),
  }));
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Story(storyId: number) {
  const now = new Date();
  const content = await storyContent(storyId, now);
  if (!content) return null;
  const { s, reports, developments } = content;
  const latestAt = s.latest_at ?? reports[0]!.at;
  const neighbors = (await relatedStories(storyId)).map((r) => ({ publicId: r.public_id, title: r.title, relation: r.relation, links: { aihot: storyUrl(r.public_id), api: storyApiUrl(r.public_id) } }));
  return {
    schemaVersion: 1 as const,
    story: {
      publicId: s.public_id,
      title: s.title,
      status: storyStatusFor(latestAt, now.getTime()) === "settled" ? ("settled" as const) : ("active" as const),
      sourceCount: new Set(reports.map((r) => r.sourceId)).size,
      reportCount: reports.length,
      firstReportAt: (s.first_report_at ?? reports[reports.length - 1]!.at).toISOString(),
      latestAt: latestAt.toISOString(),
      latest: s.latest ?? developments[0]?.title ?? s.title,
      digest: s.digest,
      digestUpdatedAt: s.digest_updated_at?.toISOString() ?? null,
      links: { aihot: storyUrl(s.public_id) },
      reports: reports.slice(0, 50).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        source: { name: r.sourceName, firstParty: r.firstParty },
        publishedAt: r.at.toISOString(),
        links: { aihot: itemUrl(r.id), original: r.url },
      })),
      storyline: neighbors.filter((n) => n.relation === "storyline"),
      related: neighbors.filter((n) => n.relation === "related"),
    },
  };
}
