// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { releasedCondition } from "./items.ts";
import { itemHasPage } from "./rules.ts";
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
  /** False only when the item itself is withdrawn or not public — see `citationFrom`'s struck-through branch. */
  public?: boolean;
  firstParty: boolean;
  sourceId: string | null;
  sourceIcon: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
}

/** The same rule the item page itself answers with (rules.itemHasPage), so a paper never strikes through
 *  a title that opens, and never links one that does not. */
async function availability(ids: string[], now = new Date()): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null;
    first_party: boolean; source_id: string; icon_url: string | null; story_public_id: string | null; at: Date | null }[]>`
    SELECT p.article_id AS id, p.visibility, s.participation_mode AS source_mode, p.selected, p.visible_after,
      p.first_party, p.source_id, s.icon_url, st.public_id::text AS story_public_id,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: itemHasPage({ visibility: r.visibility, sourceMode: r.source_mode, selected: r.selected, visibleAfter: r.visible_after }, now),
      // Why there is no page matters: a withdrawn or non-public item must not be quoted again anywhere,
      // while a public item whose source simply left the editorial set still owes the reader its source.
      public: r.visibility === "public",
      firstParty: r.first_party,
      sourceId: r.source_id,
      sourceIcon: r.icon_url,
      storyPublicId: r.story_public_id,
      publishedAt: r.at,
    });
  }
  return out;
}

/**
 * Which of `ids` still open for a reader. Ids absent from this database are in neither set: they stay
 * cited as published (an imported issue quotes items older than the imported window), but nothing links a
 * page that does not exist — see `tocHtml`, which falls back to the original article for those.
 */
async function pageSets(ids: string[], now = new Date()): Promise<{ withPage: Set<string>; withoutPage: Set<string> }> {
  const withPage = new Set<string>();
  const withoutPage = new Set<string>();
  if (ids.length === 0) return { withPage, withoutPage };
  const avail = await availability([...new Set(ids.filter(Boolean))], now);
  for (const [id, a] of avail) (a.available ? withPage : withoutPage).add(id);
  return { withPage, withoutPage };
}

/** Ids among `ids` that no longer have a reader-facing page. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  return (await pageSets(ids)).withoutPage;
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
  return sql<{ key: string; content: Record<string, any>; generated_at: Date; issue_no: number | null }[]>`
    SELECT key, generated_at, issue_no, jsonb_build_object(
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
  const own = kind === "periodic" ? periodicHeadline(content) : null;
  if (own) return own;
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
    // No page to open any more. Two different reasons, two different answers:
    //  · the item itself is withdrawn or not public — quoting it again anywhere re-exposes what was pulled,
    //    so the reader sees a struck-through title and nothing else (tests/publication.test.ts pins this);
    //  · the item is public but its source left the editorial set — there is no site page, yet the paper
    //    still has to say where the claim came from, so title, source name and original address stay.
    const struck = a?.public === false;
    return {
      itemId: id, title: String(raw.title ?? ""), summary: null,
      sourceName: struck ? "" : String(raw.sourceName ?? raw.source?.name ?? ""),
      sourceUrl: struck ? "" : String(raw.sourceUrl ?? raw.links?.original ?? ""),
      sourceId: struck ? null : raw.sourceId ?? a?.sourceId ?? null, sourceIconUrl: null,
      firstParty: struck ? false : raw.firstParty ?? a?.firstParty ?? false, role: raw.role ?? null,
      storyPublicId: null, publishedAt: struck ? null : a?.publishedAt?.toISOString() ?? null, available: false,
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
 * report of the same event (first-hand first). Items shown as summaries only lend no pictures, and an
 * item still behind the release gate lends none either — its own page hides it, so its picture must too.
 */
async function leadCover(itemId: string, now = new Date()): Promise<{ url: string; srcSet?: string; width: number | null; height: number | null } | null> {
  const [row] = await sql<{ m: { url: string; width?: number; height?: number } }[]>`
    SELECT img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE (p.article_id = ${itemId} OR p.story_id = (SELECT story_id FROM publications WHERE article_id = ${itemId}))
      AND p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)} AND p.body_mode <> 'summary'
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
  // The same question `readableRows` asks of an index row, answered from the citations this page already
  // resolved: `all` is exactly that row's cited set (a daily's section items, a weekly's story refs — never
  // its flashes), and `available` is the same `itemHasPage` the index's `withoutPage` set is built from.
  const readable = all.some((i: ReportCitation) => i.itemId && i.available);
  const title = kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    readable,
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
 * The newest 400 issues of a kind, with everything every outlet needs to decide what a reader can turn to:
 * the withdrawn headline candidates, and which citations still have a page. Every archive, navigation,
 * feed and v1 list of that kind reads this one gate; it is rebuilt at most once a minute per process (a new
 * issue or a withdrawal shows within a minute, like the pages' own caches). The page sets are part of the
 * cached payload rather than read per request because an index of 400 issues cites thousands of items, and
 * a report page used to ask it on every view (and again in `neighbors`, which reads this same index).
 */
const INDEX_LIMIT = 400;
const indexes = new Map<ReportKind, Cached<ReportIndex>>();
interface ReportIndex {
  rows: Awaited<ReturnType<typeof reportIndexRows>>;
  gone: Set<string>;
  /** Citations of these issues that still open for a reader, and those that no longer do. */
  withPage: Set<string>;
  withoutPage: Set<string>;
}
export function reportIndex(kind: ReportKind) {
  let entry = indexes.get(kind);
  if (!entry) {
    entry = cached(async (): Promise<ReportIndex> => {
      const rows = await reportIndexRows(kind, INDEX_LIMIT);
      const pages = await pageSets(rows.flatMap((r) => citedItemIds(r.content, kind === "daily" ? "daily" : "periodic")));
      return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic"), ...pages };
    }, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });
    indexes.set(kind, entry);
  }
  return entry.get();
}

/** The items an index row cites: a daily's section items, a weekly or monthly's story refs. */
function citedItemIds(content: Record<string, any>, shape: "daily" | "periodic"): string[] {
  return (shape === "daily"
    ? (content.sections ?? []).flatMap((s: any) => s.items ?? [])
    : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []))
    .map((i: any) => i.itemId).filter(Boolean) as string[];
}

/**
 * An index and the issues of it a reader can read, in one call: the feeds and the v1 lists take their
 * rows, their headline candidates and their citation page sets from here, so no outlet can apply a second,
 * looser gate than the site index does (`listReports` below is the same filter with the counts attached).
 */
export async function readableReports(kind: ReportKind, limit: number) {
  const index = await reportIndex(kind);
  const shape = kind === "daily" ? "daily" : "periodic";
  return { index, shape, rows: readableRows(index, shape, limit) };
}

/**
 * The issues a reader can actually read, newest first: an edition whose every citation lost its page — the
 * gate published no pick, or everything it cited has since been withdrawn — is not a newspaper. Listing one
 * advertises 「共 8 期」 of which seven read 0 件大事 while the masthead still offers a reading time, so this
 * is the one gate every outlet shares: the site index, the feeds, the v1 lists, `latest`, the sitemap and
 * the neighbouring-page links. A *named* blank issue is still served as its own honest empty state
 * (`v1Report`/`loadReport`), it just is never advertised.
 */
function readableRows(index: ReportIndex, shape: "daily" | "periodic", limit: number) {
  return index.rows
    .filter((r) => citedItemIds(r.content, shape).some((id) => !index.withoutPage.has(id)))
    .slice(0, limit);
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT): Promise<ReportIndexEntry[]> {
  const index = await reportIndex(kind);
  const shape = kind === "daily" ? "daily" : "periodic";
  const entries = readableRows(index, shape, limit).map((r) => ({
    key: r.key,
    title: reportHeadline(r.content, shape, index.gone),
    generatedAt: r.generated_at.toISOString(),
    // 「本期 N 件大事」= 这份报纸真的排出来多少条：`pagesOf` 按 key 去重（头条与分栏里的同一条只算一次），
    // 并且条目页面没了也仍然印着（划掉的那一行）。以前这里筛掉 withoutPage、又不查重，
    // 于是同一期在归档里和在报头上可能是两个数（今天数据恰好一致：29 = 29）。
    count: new Set(citedItemIds(r.content, shape)).size,
    // The issue's own number, stamped at publication (migration 0048). Not derived from position:
    // past the newest-400 window a position stops meaning anything, and a number must never move.
    no: r.issue_no ?? null,
  }));
  return entries;
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
 * The newest readable issues of a kind; dailies keep the field names they have always sent. The rows come
 * from {@link readableReports} — the one gate every outlet shares — never from a second, looser test of
 * the raw citation count, so no exit can advertise a paper whose table of contents is empty.
 */
export function v1Reports(kind: "daily", limit: number): Promise<V1DailiesBody>;
export function v1Reports(kind: "weekly" | "monthly", limit: number): Promise<V1PeriodicListBody>;
export async function v1Reports(kind: ReportKind, limit: number): Promise<V1DailiesBody | V1PeriodicListBody> {
  const { index, rows } = await readableReports(kind, limit);
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
  // "latest" is the newest edition the shared gate still calls readable — the same answer the site index,
  // the feeds and the sitemap give. A period the gate left empty must not become "latest" and serve a blank
  // paper to every machine consumer.
  const wanted = key === "latest" ? (await listReports(kind, 1))[0]?.key ?? null : key;
  if (!wanted) return null;
  const [r] = await sql<ReportRow[]>`
    SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} AND key = ${wanted}`;
  if (!r) return null;
  // A *named* blank issue answers with an honest empty state (200 + 「本期没有入选内容」的版面), not 404 and
  // never a 500 — that is a deliberate choice from the round that added these routes (tests/publication.test.ts
  // 「a named blank issue is an honest empty state, not a 500」). What must not happen is an outlet *advertising*
  // one: lists, latest, feeds and the sitemap all go through the `count > 0` gate instead. MCP's by-week tool is
  // the exception to the exception: it refuses a blank issue outright, because an agent cannot tell an empty
  // shell from content (apps/api/src/routes/mcp.ts).
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
  return index.map((entry, n) => ({ key: entry.key, no: entry.no,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string) {
  return reportNavigation(kind, await listReports(kind), key);
}

export async function loadReportMonth(kind: ReportKind, month: string) {
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, title }) => ({ key, title }));
}
