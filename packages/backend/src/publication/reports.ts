// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { dailyUrl, itemUrl, reportUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@aihot/industry/site";

export type { ReportKind };

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  generated_at: Date;
  revision: number;
}

interface Availability {
  available: boolean;
  firstParty: boolean;
  sourceId: string | null;
  sourceIcon: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
}

async function availability(ids: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; eligible: boolean; first_party: boolean; source_id: string; icon_url: string | null; story_public_id: string | null; at: Date | null }[]>`
    SELECT p.article_id AS id, p.visibility, p.eligible, p.first_party, p.source_id, s.icon_url, st.public_id::text AS story_public_id,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: r.visibility === "public" && r.eligible,
      firstParty: r.first_party,
      sourceId: r.source_id,
      sourceIcon: r.icon_url,
      storyPublicId: r.story_public_id,
      publishedAt: r.at,
    });
  }
  return out;
}

/** Ids among `ids` that are no longer public. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  const rows = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications
    WHERE article_id = ANY(${unique}::text[]) AND (visibility <> 'public' OR NOT eligible)`;
  return new Set(rows.map((r) => r.id));
}

/** Directory/feed metadata only: citation summaries and full report prose stay in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  // The three names below used to be one CASE-per-use inside a hand-nested jsonb expression whose
  // parenthesis count I got wrong twice while adding the weekly shape — the aggregate's ORDER BY landed
  // outside the call and every periodic read answered 503. Naming them once, and writing the aggregation
  // as two plainly nested subqueries, keeps each paren next to its partner. `kind` is a three-value union,
  // so inlining it is an enum, not user input.
  const groupedKey = kind === "daily" ? "sections" : "themes";
  const labelKey = kind === "daily" ? "label" : "heading";
  const itemsKey = kind === "daily" ? "items" : "storyRefs";
  return sql<{ key: string; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key, generated_at, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      'overview', content->'overview', 'periodStart', content->'periodStart', 'periodEnd', content->'periodEnd',
      ${groupedKey}::text,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          ${labelKey}::text, grp ->> ${labelKey}::text,
          ${itemsKey}::text, coalesce((
            SELECT jsonb_agg(jsonb_build_object('itemId', item -> 'itemId', 'title', item -> 'title') ORDER BY item_ord)
            FROM jsonb_array_elements(coalesce(grp -> ${itemsKey}::text, '[]'::jsonb)) WITH ORDINALITY AS cited(item, item_ord)
          ), '[]'::jsonb)
        ) ORDER BY grp_ord)
        FROM jsonb_array_elements(coalesce(content -> ${groupedKey}::text, '[]'::jsonb)) WITH ORDINALITY AS grouped(grp, grp_ord)
      ), '[]'::jsonb)
    ) AS content
    FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT ${limit}`;
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `gone` must cover withdrawn candidates before the first public title (see {@link unavailableHeadlineIds}).
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): string | null {
  if (kind === "daily" && content.lead?.title) return String(content.lead.title);
  if (kind === "periodic" && periodicHeadline(content)) return periodicHeadline(content);
  const items: Array<Record<string, any>> = kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
  return first?.title ?? null;
}

/** A weekly or monthly's own headline; the composer's "<site> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  return text && !/^.+ [周月]报 · \d{4}-/.test(text) ? text : null;
}

/** Check only the first possible headline of each report; advance reports whose candidate was withdrawn. */
export async function unavailableHeadlineIds(rows: Array<{ content: Record<string, any> }>, kind: "daily" | "periodic"): Promise<Set<string>> {
  const reports = rows
    .filter((r) => (kind === "daily" ? !r.content.lead?.title : !periodicHeadline(r.content)))
    .map((r): Array<{ itemId?: string | null }> => kind === "daily"
      ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? [])
      : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []));
  const gone = new Set<string>();
  const checked = new Set<string>();
  while (true) {
    const candidates = reports.map((items) => items.find((i) => !i.itemId || !gone.has(i.itemId))?.itemId)
      .filter((id): id is string => !!id && !checked.has(id));
    if (!candidates.length) return gone;
    for (const id of await unavailableIds(candidates)) gone.add(id);
    for (const id of candidates) checked.add(id);
  }
}

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // Items absent from this database (older than the imported window) stay cited as they were published.
  const available = id ? (a ? a.available : true) : true;
  if (!available) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id, title: String(raw.title ?? ""), summary: null, sourceName: "", sourceUrl: "", sourceId: null, sourceIconUrl: null,
      firstParty: false, role: raw.role ?? null, storyPublicId: null, publishedAt: null, available: false,
    };
  }
  return {
    itemId: id,
    title: String(raw.title ?? ""),
    summary: raw.summary ?? null,
    sourceName: String(raw.sourceName ?? raw.source?.name ?? ""),
    sourceUrl: String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceId: raw.sourceId ?? a?.sourceId ?? null,
    sourceIconUrl: a?.sourceIcon ? proxiedImage(a.sourceIcon, "avatar") : null,
    ...(a?.sourceIcon && proxiedImageSet(a.sourceIcon, "avatar") ? { sourceIconSrcSet: proxiedImageSet(a.sourceIcon, "avatar")! } : {}),
    firstParty: raw.firstParty ?? a?.firstParty ?? false,
    role: raw.role ?? null,
    storyPublicId: raw.storyPublicId ?? a?.storyPublicId ?? null,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available,
  };
}

const bigrams = (text: string) => {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}]/gu, "")];
  return new Set(chars.slice(1).map((ch, i) => chars[i] + ch));
};

/**
 * The item a daily's front page leads with. Without an editors' lead it is the first highlight (else
 * the first story), as the page sets it. The editors' lead is written about one of the items, so it is
 * the item whose title shares most of the lead's character pairs, if most of them are shared; a lead
 * that matches no item clearly has none.
 */
export function leadItemOf(leadTitle: string | undefined, highlights: ReportCitation[], all: ReportCitation[]): ReportCitation | undefined {
  if (!leadTitle) return highlights[0] ?? all[0];
  const want = bigrams(leadTitle);
  if (want.size === 0) return undefined;
  let best: { c: ReportCitation; share: number } | undefined;
  for (const c of all) {
    const have = bigrams(c.title);
    const share = [...want].filter((b) => have.has(b)).length / want.size;
    if (!best || share > best.share) best = { c, share };
  }
  return best && best.share >= 0.5 ? best.c : undefined;
}

/**
 * A picture for the front page's lead item: its own first sizeable image, else one from another public
 * report of the same event (first-hand first). Items shown as summaries only lend no pictures.
 */
async function leadCover(itemId: string): Promise<{ url: string; srcSet?: string; width: number | null; height: number | null } | null> {
  const [row] = await sql<{ m: { url: string; width?: number; height?: number } }[]>`
    SELECT img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE (p.article_id = ${itemId} OR p.story_id = (SELECT story_id FROM publications WHERE article_id = ${itemId}))
      AND p.visibility = 'public' AND p.eligible AND p.body_mode <> 'summary'
    ORDER BY (p.article_id = ${itemId}) DESC, p.first_party DESC, coalesce(p.score, 0) DESC, p.article_id
    LIMIT 1`;
  if (!row) return null;
  const url = proxiedImage(row.m.url, "full");
  if (!url) return null;
  return { url, ...(proxiedImageSet(row.m.url, "hero") ? { srcSet: proxiedImageSet(row.m.url, "hero")! } : {}), width: typeof row.m.width === "number" ? row.m.width : null, height: typeof row.m.height === "number" ? row.m.height : null };
}

/** An edition with no prose reads in zero minutes; callers hide the claim rather than say 「约 1 分钟」. */
function readingMinutes(text: string): number {
  const chars = [...text].length;
  return chars === 0 ? 0 : Math.max(1, Math.round(chars / 450));
}

/**
 * The editions a reader can actually turn to. The raw table also holds blank issues (the gate published
 * nothing that day, or every citation has since been withdrawn) — /daily/2026-10-02 used to offer 「前一日 ·
 * 10月1日」 pointing at one of those, while the archive listed a single issue. Blank editions stay reachable
 * by their own URL (they say so honestly), they just stop being advertised as neighbouring pages.
 */
async function neighbors(kind: ReportKind, key: string): Promise<{ prev: string | null; next: string | null }> {
  const entries = await listReports(kind); // newest first
  const older = entries.filter((e) => e.key < key);   // descending, so [0] is the closest older edition
  const newer = entries.filter((e) => e.key > key);   // descending, so the last one is the closest newer
  return { prev: older[0]?.key ?? null, next: newer[newer.length - 1]?.key ?? null };
}

export async function loadReport(kind: ReportKind, key: string): Promise<ReportDetail | null> {
  const [r] = await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!r) return null;
  const c = r.content;
  const rawItems: Array<Record<string, any>> = [
    ...(c.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(c.flashes ?? []),
    ...(c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))]);
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail);

  const sections = kind === "daily"
    ? (c.sections ?? []).map((s: any) => ({ label: String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
    : (c.themes ?? []).map((t: any) => ({ label: String(t.heading), summary: t.summary ?? null, items: (t.storyRefs ?? []).map(cite) }));
  const labelled: Array<ReportCitation & { label: string }> = sections.flatMap((s: { label: string; items: ReportCitation[] }) => s.items.map((i) => ({ ...i, label: s.label })));
  // Weekly and monthly reports carry the editor's reading order across themes.
  const order: string[] = Array.isArray(c.storyOrder) ? c.storyOrder : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const stories = order.length
    ? [...labelled].sort((a, b) => (rank.get(a.itemId ?? "") ?? order.length) - (rank.get(b.itemId ?? "") ?? order.length))
    : labelled;
  const all: ReportCitation[] = labelled;
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const text = [c.lead?.leadParagraph ?? "", c.overview ?? "", ...all.map((i: ReportCitation) => `${i.title}${i.summary ?? ""}`)].join("");
  // A weekly or monthly's picture comes from its first highlight and is captioned with that story.
  const leadItem = kind === "daily" ? leadItemOf(c.lead?.title, highlights, all) : (highlights[0] ?? all[0]);
  const [{ prev, next }, picture] = await Promise.all([neighbors(kind, key), leadItem?.itemId && leadItem.available ? leadCover(leadItem.itemId) : null]);
  const cover = picture && leadItem ? { ...picture, caption: kind === "daily" ? null : leadItem.title } : null;
  const headline = kind === "daily" ? null : periodicHeadline(c);
  const title = kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    lead: c.lead ?? (headline ? { title: headline, leadParagraph: String(c.overview ?? "") } : null),
    overview: c.overview ?? null,
    highlights,
    sections,
    stories,
    flashes: (c.flashes ?? []).map(cite),
    cover,
    metrics: c.metrics ?? {},
    readingMinutes: readingMinutes(text),
    prev,
    next,
  };
}

/**
 * The newest 400 issues of a kind with their withdrawn headline candidates. Every archive, navigation
 * and feed of that kind reads this; it is rebuilt at most once a minute per process (a new issue or a
 * withdrawal shows within a minute, like the pages' own caches).
 */
const INDEX_LIMIT = 400;
const indexes = new Map<ReportKind, Cached<{ rows: Awaited<ReturnType<typeof reportIndexRows>>; gone: Set<string> }>>();
export function reportIndex(kind: ReportKind) {
  let entry = indexes.get(kind);
  if (!entry) {
    entry = cached(async () => {
      const rows = await reportIndexRows(kind, INDEX_LIMIT);
      return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic") };
    }, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });
    indexes.set(kind, entry);
  }
  return entry.get();
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT): Promise<ReportIndexEntry[]> {
  const index = await reportIndex(kind);
  const shape = kind === "daily" ? "daily" : "periodic";
  const gone = index.gone;
  const idsOf = (content: Record<string, any>): string[] =>
    (kind === "daily"
      ? (content.sections ?? []).flatMap((s: any) => s.items ?? [])
      : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []))
      .map((i: any) => i.itemId).filter(Boolean);
  // A citation whose item has since been withdrawn is not something a reader can read, so one query over
  // the whole index decides every edition's count. Counting raw citations kept blank editions listed:
  // /daily/archive said 「共 8 期」, 归档写「N 件大事」, and the page behind it was a row of struck-through titles.
  const hidden = await unavailableIds(index.rows.flatMap((r) => idsOf(r.content)));
  const entries = index.rows.map((r) => {
    const ids = idsOf(r.content);
    return {
      key: r.key,
      title: reportHeadline(r.content, shape, gone),
      generatedAt: r.generated_at.toISOString(),
      count: ids.filter((id) => !hidden.has(id)).length,
    };
  });
  // An edition with nothing left to read — the gate published no pick, or every citation has since been
  // withdrawn — is not a newspaper. Listing one advertises 「共 8 期」 of which seven read 0 件大事 while the
  // masthead still offers a reading time, so the index carries only the editions a reader can read.
  return entries.filter((e) => e.count > 0).slice(0, limit);
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

const attribution = (url: string) => ({ name: SITE.name, url });

/**
 * How many weekly/monthly issues the public exits advertise: the retention of their RSS feeds and the
 * default limit of their v1 lists. One number, not one copy per exit.
 */
export const PERIOD_FEED_LIMIT = 12;

interface V1Attribution { name: string; url: string }
interface V1ContentLinks { aihot: string | null; original: string }
interface V1PeriodicEntryFields {
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string;
  headline: string | null;
  links: { aihot: string };
  attribution: V1Attribution;
}
interface V1PeriodicItem {
  title: string;
  summary: string;
  source: { name: string };
  links: V1ContentLinks;
  publishedAt: string | null;
  attribution: V1Attribution;
}
interface V1PeriodicReportFields extends V1PeriodicEntryFields {
  windowStart: string;
  windowEnd: string;
  overview: string | null;
  sections: Array<{ label: string; summary: string | null; items: V1PeriodicItem[] }>;
}
/** The dailies list body, field-for-field as it has always shipped. */
export interface V1DailiesBody {
  schemaVersion: 1;
  count: number;
  items: Array<{ date: string; generatedAt: string; leadTitle: string | null; leadParagraph: string | null; links: { aihot: string }; attribution: V1Attribution }>;
}
export interface V1DailyBody {
  schemaVersion: 1;
  report: {
    date: string;
    generatedAt: string;
    windowStart: string;
    windowEnd: string;
    links: { aihot: string };
    attribution: V1Attribution;
    lead: { title: string; leadParagraph: string } | null;
    sections: Array<{ label: string; items: Array<{ title: string; summary: string; source: { name: string }; links: V1ContentLinks; attribution: V1Attribution }> }>;
    flashes: Array<{ title: string; source: { name: string }; links: V1ContentLinks; publishedAt: string; attribution: V1Attribution }>;
  };
}
export interface V1PeriodicListBody {
  schemaVersion: 1;
  count: number;
  items: Array<({ week: string } | { month: string }) & V1PeriodicEntryFields>;
}
export interface V1WeeklyBody { schemaVersion: 1; report: { week: string } & V1PeriodicReportFields }
export interface V1MonthlyBody { schemaVersion: 1; report: { month: string } & V1PeriodicReportFields }

/**
 * An edition a reader can actually read: at least one item survived the visibility filter. The same
 * predicate gates the site index, the v1 lists, the v1 "latest" and the report feeds, so no public
 * exit advertises a blank newspaper.
 */
export function hasReadableItems(content: Record<string, any>, kind: ReportKind): boolean {
  const items = kind === "daily"
    ? (content.sections ?? []).flatMap((s: any) => s.items ?? [])
    : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  return items.length > 0;
}

/** The newest readable issues of a kind; dailies keep the field names they have always sent. */
export function v1Reports(kind: "daily", limit: number): Promise<V1DailiesBody>;
export function v1Reports(kind: "weekly" | "monthly", limit: number): Promise<V1PeriodicListBody>;
export async function v1Reports(kind: ReportKind, limit: number): Promise<V1DailiesBody | V1PeriodicListBody> {
  const index = await reportIndex(kind);
  const rows = index.rows.filter((r) => hasReadableItems(r.content, kind)).slice(0, limit);
  const gone = index.gone;
  if (kind === "daily") {
    const items = rows.map((r) => {
      const url = dailyUrl(r.key);
      return {
        date: r.key,
        generatedAt: r.generated_at.toISOString(),
        leadTitle: reportHeadline(r.content, "daily", gone),
        leadParagraph: r.content.lead?.leadParagraph ?? null,
        links: { aihot: url },
        attribution: attribution(url),
      };
    });
    return { schemaVersion: 1 as const, count: items.length, items };
  }
  const items = rows.map((r) => {
    const url = reportUrl(kind, r.key);
    const fields: V1PeriodicEntryFields = {
      periodStart: r.content.periodStart ?? null,
      periodEnd: r.content.periodEnd ?? null,
      generatedAt: r.generated_at.toISOString(),
      headline: reportHeadline(r.content, "periodic", gone),
      links: { aihot: url },
      attribution: attribution(url),
    };
    return kind === "weekly" ? { week: r.key, ...fields } : { month: r.key, ...fields };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

/** One issue by key, or the newest readable one for "latest"; null when no such issue exists. */
export function v1Report(kind: "daily", key: string): Promise<V1DailyBody | null>;
export function v1Report(kind: "weekly", key: string): Promise<V1WeeklyBody | null>;
export function v1Report(kind: "monthly", key: string): Promise<V1MonthlyBody | null>;
export function v1Report(kind: "weekly" | "monthly", key: string): Promise<V1WeeklyBody | V1MonthlyBody | null>;
export async function v1Report(kind: ReportKind, key: string): Promise<V1DailyBody | V1WeeklyBody | V1MonthlyBody | null> {
  const rows = key === "latest"
    // The newest row is not necessarily the newest edition with something in it; a period the gate left
    // empty must not become "latest" and serve a blank paper to every machine consumer.
    ? (await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} ORDER BY key DESC LIMIT 20`).filter((x) => hasReadableItems(x.content, kind))
    : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} AND key = ${key}`;
  const [r] = rows;
  if (!r) return null;
  const c = r.content;
  const url = kind === "daily" ? dailyUrl(r.key) : reportUrl(kind, r.key);
  if (kind === "daily") {
    const raw = [...(c.sections ?? []).flatMap((s: any) => s.items ?? []), ...(c.flashes ?? [])];
    const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
    const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
    const links = (i: any) => ({ aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
    return {
      schemaVersion: 1 as const,
      report: {
        date: r.key,
        generatedAt: r.generated_at.toISOString(),
        windowStart: r.window_start.toISOString(),
        windowEnd: r.window_end.toISOString(),
        links: { aihot: url },
        attribution: attribution(url),
        lead: c.lead ? { title: String(c.lead.title), leadParagraph: String(c.lead.leadParagraph) } : null,
        sections: (c.sections ?? []).map((s: any) => ({
          label: String(s.label),
          items: (s.items ?? []).filter(ok).map((i: any) => ({
            title: String(i.title),
            summary: String(i.summary ?? ""),
            source: { name: String(i.sourceName ?? "") },
            links: links(i),
            attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
          })),
        })),
        flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          source: { name: String(i.sourceName ?? "") },
          links: links(i),
          publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
          attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
        })),
      },
    };
  }
  const raw: Array<Record<string, any>> = (c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  // The headline fallback sees this issue's own withdrawn candidates, the way the list sees the index's.
  const gone = await unavailableHeadlineIds([r], "periodic");
  const fields: V1PeriodicReportFields = {
    periodStart: c.periodStart ?? null,
    periodEnd: c.periodEnd ?? null,
    generatedAt: r.generated_at.toISOString(),
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    links: { aihot: url },
    attribution: attribution(url),
    headline: reportHeadline(c, "periodic", gone),
    overview: c.overview ?? null,
    sections: (c.themes ?? []).map((t: any) => ({
      label: String(t.heading ?? ""),
      summary: t.summary ?? null,
      items: (t.storyRefs ?? []).filter(ok).map((i: any) => ({
        title: String(i.title),
        summary: String(i.summary ?? ""),
        source: { name: String(i.sourceName ?? "") },
        links: { aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") },
        publishedAt: i.publishedAt ? new Date(i.publishedAt).toISOString() : null,
        attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
      })),
    })),
  };
  // Two shapes, not one ternary inside a literal: TypeScript resolves the contextual type of a conditional
  // expression against a union return type by picking a member, so `{ month: … }` was checked against
  // `V1WeeklyBody` and the monthly branch would not compile.
  if (kind === "weekly") return { schemaVersion: 1 as const, report: { week: r.key, ...fields } };
  return { schemaVersion: 1 as const, report: { month: r.key, ...fields } };
}

// Call sites (the routes, the MCP server) keep reading these names; they are thin wrappers now.
export const v1Dailies = (limit: number): Promise<V1DailiesBody> => v1Reports("daily", limit);
export const v1Daily = (date: string | "latest"): Promise<V1DailyBody | null> => v1Report("daily", date);

export { siteUrl };

export function reportNavigation(kind: ReportKind, index: ReportIndexEntry[], key: string): ReportNavigationEntry[] {
  const at = index.findIndex((e) => e.key === key);
  return index.map((entry, n) => ({ key: entry.key,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string) {
  return reportNavigation(kind, await listReports(kind), key);
}

export async function loadReportMonth(kind: ReportKind, month: string) {
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, title }) => ({ key, title }));
}
