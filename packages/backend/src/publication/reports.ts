import { workflowReadyCondition } from "./readiness.ts";
// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind, SiteLang } from "@aihot/contracts/site";
import type { ReportCitationSnapshot, ReportEnglishContent } from "@aihot/contracts/english";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { listedCondition, englishCopyCondition } from "./items.ts";
import { itemHasPage } from "./rules.ts";
import { CJK_COPY_PATTERN, hasChineseCopy } from "@aihot/contracts/copy";
import { dailyUrl, itemUrl, reportUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@aihot/industry/site";
import { englishPolicy, englishTextMode, textLocaleOf } from "./english-policy.ts";
import { englishReadyCondition } from "./readiness-en.ts";
import { sourceNameFor } from "./source-name.ts";

export type { ReportKind };

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  content_en: ReportEnglishContent | null;
  revision: number;
  revision_en: number | null;
  generated_at: Date;
}

interface Availability {
  available: boolean;
  unavailableReason?: ReportCitation["unavailableReason"];
  /** False only when the item itself is withdrawn or not public — see `citationFrom`'s struck-through branch. */
  public?: boolean;
  firstParty: boolean;
  sourceId: string | null;
  sourceIcon: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
}

/** 英文刊面只在 `revision_en = revision` 时采用；旧刊的引用文字只认自己的写时快照。 */
function englishContentOf(r: { content_en: ReportEnglishContent | null; revision_en: number | null; revision: number }): ReportEnglishContent | null {
  return r.content_en && r.revision_en === r.revision ? r.content_en : null;
}

/**
 * 一整期在 `/en` 上是不是真的英文：散文覆盖层在，且版面上每一条引用都印着英文。
 * `listReports` 的索引、前后导航与 latest 都走这一条；`loadReport` 用同一对判据回答详情门，
 * 索引先列出一期点进去又是 404 的口径从此只有一处（2026-11-23 独立审查）。
 */
function englishReportReady(kind: ReportKind, content: Record<string, any>, en: ReportEnglishContent | null): boolean {
  if (!en) return false;
  // 与 `loadReport` 的 `proseEnglish` 逐字同一条：daily 的 sections 标签不算散文，lead 被身份守卫
  // 删掉时这一期就不该被索引先列出来；周/月报的大标题与总述同理。
  const lead = content.lead ? en.lead ?? null : null;
  const headline = kind === "daily" ? null : (en.headline?.trim() ? en.headline : null);
  const overview = en.overview?.trim() ? en.overview : null;
  if (!lead && !headline && !overview) return false;
  const snaps = snapshotMap(en);
  // 引用快照必须覆盖版面上印出来的全部条目（日报含快讯）；旧刊少一条快照就按「还没有英文版」回答，
  // 读层不会为它伪造英文，索引也不该把会 404 的期次交给读者。
  return printedCitations(kind, content).every((raw) => {
    const id = raw.itemId ?? null;
    const copy = citationCopy(raw, id ? snaps.get(id) : undefined);
    return textLocaleOf(copy.title, copy.summary) === "en";
  });
}

/** 版面上真正印出来的引用：日报的分栏条目 + 快讯，周/月报的主题条目；顺序与成刊一致。 */
function printedCitations(kind: ReportKind, content: Record<string, any>): Array<Record<string, any>> {
  const grouped: Array<Record<string, any>> = kind === "daily"
    ? (content.sections ?? []).flatMap((s: any) => s.items ?? [])
    : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  return [...grouped, ...(content.flashes ?? [])];
}

/** 引用文字的取值：成刊时的英文快照优先，缺快照才用刊物自己的行文（`citationFrom` 与英文门共用）。 */
function citationCopy(raw: Record<string, any>, snap: ReportCitationSnapshot | undefined): { title: string; summary: string | null } {
  return {
    title: snap?.title?.trim() ? snap.title : String(raw.title ?? ""),
    summary: snap ? snap.summary : (raw.summary ?? null),
  };
}

function snapshotMap(content: ReportEnglishContent | null): Map<string, ReportCitationSnapshot> {
  return new Map((content?.citations ?? []).map((c) => [c.itemId, c]));
}

/** The same rule the item page itself answers with, at its two grades: a full page or a restricted
 *  preview (summary-licence source, workflow still running) both open — so a paper never strikes
 *  through a title that opens, and never links one that does not. `unavailableReason` is only set
 *  for rows with no page at all. */
async function availability(ids: string[], now = new Date(), lang: SiteLang = "zh"): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const needEnglishReady = lang === "en" && englishTextMode() === "strict" && englishPolicy().membership === "english";
  const rows = await sql<{ id: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null; workflow_ready: boolean;
    source_fulltext: boolean; has_copy: boolean; has_any_copy: boolean; english_copy_ready: boolean; english_ready: boolean; first_party: boolean; source_id: string; icon_url: string | null; story_public_id: string | null; at: Date | null }[]>`
    SELECT ${workflowReadyCondition()} AS workflow_ready, p.article_id AS id, p.visibility, s.participation_mode AS source_mode, p.selected, p.visible_after,
      s.site_fulltext AS source_fulltext, (p.title ~ ${CJK_COPY_PATTERN} AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_copy,
      (nullif(btrim(p.title), '') IS NOT NULL AND nullif(btrim(p.summary), '') IS NOT NULL) AS has_any_copy,
      (CASE WHEN ${englishCopyCondition()} THEN true ELSE false END) AS english_copy_ready,
      (CASE WHEN ${needEnglishReady ? englishReadyCondition(now) : sql`false`} THEN true ELSE false END) AS english_ready,
      p.first_party, p.source_id, s.icon_url, st.public_id::text AS story_public_id,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  const enStrict = lang === "en" && englishTextMode() === "strict";
  for (const r of rows) {
    // The page's own gate (detail.ts), both grades: a full page, or the summary-licence restricted
    // page (public, released, title+summary — the source lends no full text or English is missing).
    // In strict /en the restricted page is also the fallback page for a row without English copy, so
    // availability must not disagree with the 200 the item route serves (2026-11-23 独立审查).
    const ready = enStrict && englishPolicy().membership === "english" ? r.english_ready : r.workflow_ready;
    const canLead = enStrict ? r.has_any_copy : r.has_copy;
    const hasPage = itemHasPage({ visibility: r.visibility, sourceMode: r.source_mode, selected: r.selected, visibleAfter: r.visible_after }, now)
      && r.visibility !== "summary-only"
      && (ready || ((!r.source_fulltext || enStrict) && !!canLead));
    out.set(r.id, {
      available: hasPage,
      unavailableReason: !hasPage
        ? r.visibility === "withdrawn" ? "withdrawn" : r.visibility !== "public" || r.source_mode !== "editorial" ? "not-public" : !r.workflow_ready ? "workflow-pending" : undefined
        : undefined,
      // Why there is no page matters: a withdrawn or non-public item must not be quoted again anywhere,
      // while a public item whose source left the editorial set still owes the reader its source.
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
async function pageSets(ids: string[], now = new Date(), lang: SiteLang = "zh"): Promise<{ withPage: Set<string>; withoutPage: Set<string> }> {
  const withPage = new Set<string>();
  const withoutPage = new Set<string>();
  if (ids.length === 0) return { withPage, withoutPage };
  const avail = await availability([...new Set(ids.filter(Boolean))], now, lang);
  for (const [id, a] of avail) (a.available ? withPage : withoutPage).add(id);
  return { withPage, withoutPage };
}

/** Ids among `ids` that no longer have a reader-facing page. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  return (await pageSets(ids)).withoutPage;
}

/** Directory/feed metadata and original citation links; full report prose stays in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number, englishOnly = false) {
  // The three names below used to be one CASE-per-use inside a hand-nested jsonb expression whose
  // parenthesis count I got wrong twice while adding the weekly shape — the aggregate's ORDER BY landed
  // outside the call and every periodic read answered 503. Naming them once, and writing the aggregation
  // as two plainly nested subqueries, keeps each paren next to its partner. `kind` is a three-value union,
  // so inlining it is an enum, not user input.
  const groupedKey = kind === "daily" ? "sections" : "themes";
  const labelKey = kind === "daily" ? "label" : "heading";
  const itemsKey = kind === "daily" ? "items" : "storyRefs";
  // 英文索引的 400 期名额只数“真有英文稿”的期次，而不是先取最新 400 期再过滤：否则英文期较稀时，
  // 更早的英文刊面会被中文期次挤出窗口，永远进不了 /en 索引、导航、latest 与 sitemap。
  const englishOnlyFilter = englishOnly ? sql`AND content_en IS NOT NULL AND revision_en = revision` : sql``;
  return sql<{ key: string; content: Record<string, any>; content_en: ReportEnglishContent | null; revision_en: number | null; revision: number; generated_at: Date; window_end: Date; issue_no: number | null }[]>`
    SELECT key, generated_at, window_end, issue_no, content_en, revision_en, revision, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      'overview', content->'overview', 'periodStart', content->'periodStart', 'periodEnd', content->'periodEnd',
      -- 快讯也印在版面上：英文就绪门要与详情门同口径，索引投影里不能少了这一栏。
      'flashes', coalesce(content->'flashes', '[]'::jsonb),
      ${groupedKey}::text,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          ${labelKey}::text, grp ->> ${labelKey}::text,
          ${itemsKey}::text, coalesce((
            SELECT jsonb_agg(jsonb_build_object('itemId', item -> 'itemId', 'title', item -> 'title',
              'sourceUrl', coalesce(item ->> 'sourceUrl', item -> 'links' ->> 'original')) ORDER BY item_ord)
            FROM jsonb_array_elements(coalesce(grp -> ${itemsKey}::text, '[]'::jsonb)) WITH ORDINALITY AS cited(item, item_ord)
          ), '[]'::jsonb)
        ) ORDER BY grp_ord)
        FROM jsonb_array_elements(coalesce(content -> ${groupedKey}::text, '[]'::jsonb)) WITH ORDINALITY AS grouped(grp, grp_ord)
      ), '[]'::jsonb)
    ) AS content
    FROM reports WHERE kind = ${kind} ${englishOnlyFilter} ORDER BY key DESC LIMIT ${limit}`;
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `gone` must cover withdrawn candidates before the first public title (see {@link unavailableHeadlineIds}).
 * `lang='en'` reads the write-time English snapshot (`content_en`) and falls back to Chinese.
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>, lang: SiteLang = "zh", enContent?: ReportEnglishContent | null): string | null {
  if (lang === "en" && enContent) {
    if (kind === "daily" && enContent.lead?.title) return String(enContent.lead.title);
    const own = kind === "periodic" ? (enContent.headline?.trim() ? enContent.headline : null) : null;
    if (own) return own;
    const snaps = snapshotMap(enContent);
    const items: Array<Record<string, any>> = kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
    const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
    const snap = first?.itemId ? snaps.get(String(first.itemId)) : undefined;
    if (snap?.title) return snap.title;
  }
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

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>, lang: SiteLang = "zh", snaps: Map<string, ReportCitationSnapshot> = new Map()): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // 引用文字只认成刊时的英文快照；缺快照才回退 `content` 的中文，并用 textLocale 标记。
  const snap = lang === "en" && id ? snaps.get(id) : undefined;
  const { title, summary } = citationCopy(raw, snap);
  const sourceUrl = String(raw.sourceUrl ?? raw.links?.original ?? "");
  const rawSourceName = String(raw.sourceName ?? raw.source?.name ?? "");
  // 写时快照优先；没有快照时英文页用英文名或域名，不把中文信源名印在英文刊面上。
  const sourceName = snap?.sourceName?.trim() ? snap.sourceName : sourceNameFor(lang, rawSourceName, null, sourceUrl);
  const role = snap ? snap.role : (raw.role ?? null);
  const textLocale = textLocaleOf(title, summary);
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
      itemId: id, title, summary: null, unavailableReason: a?.unavailableReason,
      sourceName: struck ? "" : sourceName,
      sourceUrl: struck ? "" : sourceUrl,
      sourceId: struck ? null : raw.sourceId ?? a?.sourceId ?? null, sourceIconUrl: null,
      firstParty: struck ? false : raw.firstParty ?? a?.firstParty ?? false, role,
      storyPublicId: null, publishedAt: struck ? null : a?.publishedAt?.toISOString() ?? null, available: false, hasPage: false,
      textLocale,
    };
  }
  return {
    itemId: id,
    title,
    summary,
    sourceName,
    sourceUrl,
    sourceId: raw.sourceId ?? a?.sourceId ?? null,
    sourceIconUrl: a?.sourceIcon ? proxiedImage(a.sourceIcon, "avatar") : null,
    ...(a?.sourceIcon && proxiedImageSet(a.sourceIcon, "avatar") ? { sourceIconSrcSet: proxiedImageSet(a.sourceIcon, "avatar")! } : {}),
    firstParty: raw.firstParty ?? a?.firstParty ?? false,
    role,
    storyPublicId: raw.storyPublicId ?? a?.storyPublicId ?? null,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available,
    hasPage: a?.available ?? false,
    textLocale,
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
      AND p.eligible AND ${listedCondition(now)} AND p.body_mode <> 'summary'
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
async function neighbors(kind: ReportKind, key: string, lang: SiteLang = "zh"): Promise<{ prev: string | null; next: string | null }> {
  const entries = await listReports(kind, undefined, lang); // newest first
  const older = entries.filter((e) => e.key < key);   // descending, so [0] is the closest older edition
  const newer = entries.filter((e) => e.key > key);   // descending, so the last one is the closest newer
  return { prev: older[0]?.key ?? null, next: newer[newer.length - 1]?.key ?? null };
}

export async function loadReport(kind: ReportKind, key: string, lang: SiteLang = "zh"): Promise<ReportDetail | null> {
  const [r] = await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, content_en, revision, revision_en, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!r) return null;
  const en = lang === "en" ? englishContentOf(r) : null;
  const snaps = snapshotMap(en);
  const c = r.content;
  const rawItems: Array<Record<string, any>> = [
    ...(c.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(c.flashes ?? []),
    ...(c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))], new Date(), lang);
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail, lang, snaps);

  // 英文覆盖层只按位置覆盖散文（标签/摘要），成员与顺序仍从 `content` 读；
  // 引用文字只认 `content_en.citations` 的写时快照，不在读时按条目现名投影。
  const sections = kind === "daily"
    ? (c.sections ?? []).map((s: any, i: number) => {
      const overlay = en?.sections?.[i];
      return {
        label: overlay?.label?.trim() ? String(overlay.label) : String(s.label),
        summary: overlay?.summary ?? null,
        items: (s.items ?? []).map(cite),
      };
    })
    : (c.themes ?? []).map((t: any, i: number) => {
      const overlay = en?.themes?.[i];
      return {
        label: overlay?.heading?.trim() ? String(overlay.heading) : String(t.heading),
        summary: overlay?.summary ?? t.summary ?? null,
        items: (t.storyRefs ?? []).map(cite),
      };
    });
  const labelled: Array<ReportCitation & { label: string }> = sections.flatMap((s: { label: string; items: ReportCitation[] }) => s.items.map((i) => ({ ...i, label: s.label })));
  // Weekly and monthly reports carry the editor's reading order across themes.
  const order: string[] = Array.isArray(c.storyOrder) ? c.storyOrder : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const stories = order.length
    ? [...labelled].sort((a, b) => (rank.get(a.itemId ?? "") ?? order.length) - (rank.get(b.itemId ?? "") ?? order.length))
    : labelled;
  const all: ReportCitation[] = labelled;
  // 快讯也印在版面上：与 sections 一样要有写时英文快照，也要参与语种判定。
  const flashes = (c.flashes ?? []).map(cite);
  const cited = [...all, ...flashes];
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const headline = kind === "daily" ? null : (en?.headline?.trim() ? String(en.headline) : (lang === "en" ? null : periodicHeadline(c)));
  // /en 的导语与总述不拿中文兜底：缺英文时整期由 strict 门挡下，fallback 模式下也宁可不写这段。
  const lead = c.lead ? (en?.lead ?? (lang === "en" ? null : c.lead)) : null;
  const overview = en?.overview?.trim() ? en.overview : (lang === "en" ? null : (c.overview ?? null));
  const text = [lead?.leadParagraph ?? "", overview ?? "", ...cited.map((i: ReportCitation) => `${i.title}${i.summary ?? ""}`)].join("");
  // A weekly or monthly's picture comes from its first highlight and is captioned with that story.
  const leadItem = kind === "daily" ? leadItemOf(lead?.title, highlights, all) : (highlights[0] ?? all[0]);
  // 前后导航只跟随本语言能读到的期次：/en 的往期里不能再出现只有中文的报纸。
  const [{ prev, next }, picture] = await Promise.all([neighbors(kind, key, lang), leadItem?.itemId && leadItem.available ? leadCover(leadItem.itemId) : null]);
  const cover = picture && leadItem ? { ...picture, caption: kind === "daily" ? null : leadItem.title } : null;
  // The same question `readableRows` asks of an index row, answered from the citations this page already
  // resolved: `all` is exactly that row's cited set (a daily's section items, a weekly's story refs — never
  // its flashes), and `available` is the same `itemHasPage` the index's `withoutPage` set is built from.
  const readable = all.some((i: ReportCitation) => i.itemId && i.available);
  const title = kind === "daily"
    ? (lang === "en" ? `Daily · ${key}` : `${withSubject("日报")} · ${key}`)
    : (lang === "en"
      // 英文页没有英文大标题时用期名，不拿 content.title（「GEOHOT 月报 · 2026-10」）当中文兜底。
      ? (en?.headline?.trim() ? String(en.headline) : `${kind === "weekly" ? "Weekly" : "Monthly"} · ${key}`)
      : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`)));
  // 语种判定与索引门共用 `englishReportReady`：同一期在索引里能读到，点进来就不能是 404。
  const textLocale = lang === "en"
    ? (englishReportReady(kind, c, en) ? "en" : "mixed")
    : "zh";
  // strict 的 /en 不把中文报纸当英文版承诺给读者：整期不到英文就按「这一期不存在」回答。
  // 返回 null 由站点 API 交 404、由 latest-page 交空态（页面 chrome 仍全是英文）。
  if (lang === "en" && englishTextMode() === "strict" && textLocale !== "en") return null;
  return {
    kind,
    key,
    title,
    textLocale,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    readable,
    lead: lead ?? (headline ? { title: headline, leadParagraph: String(overview ?? "") } : null),
    overview,
    highlights,
    sections,
    stories,
    flashes,
    cover,
    metrics: c.metrics ?? {},
    readingMinutes: readingMinutes(text),
    prev,
    next,
    lang,
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
const indexes = new Map<string, Cached<ReportIndex>>();
interface ReportIndex {
  rows: Awaited<ReturnType<typeof reportIndexRows>>;
  gone: Set<string>;
  /** Citations of these issues that still open for a reader, and those that no longer do. */
  withPage: Set<string>;
  withoutPage: Set<string>;
}
export function reportIndex(kind: ReportKind, englishOnly = false) {
  const cacheKey = `${kind}:${englishOnly ? "en" : "all"}`;
  let entry = indexes.get(cacheKey);
  if (!entry) {
    entry = cached(async (): Promise<ReportIndex> => {
      const rows = await reportIndexRows(kind, INDEX_LIMIT, englishOnly);
      const pages = await pageSets(rows.flatMap((r) => citedItemIds(r.content, kind === "daily" ? "daily" : "periodic")));
      return { rows, gone: await unavailableHeadlineIds(rows, kind === "daily" ? "daily" : "periodic"), ...pages };
    }, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });
    indexes.set(cacheKey, entry);
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
export async function readableReports(kind: ReportKind, limit: number, before?: string | null) {
  const index = await reportIndex(kind);
  const shape = kind === "daily" ? "daily" : "periodic";
  return { index, shape, rows: readableRows(index, shape, limit, before) };
}

/**
 * The issues a reader can actually read, newest first: an edition whose every citation lost its page — the
 * gate published no pick, or everything it cited has since been withdrawn — is not a newspaper. Listing one
 * advertises 「共 8 期」 of which seven read 0 件大事 while the masthead still offers a reading time, so this
 * is the one gate every outlet shares: the site index, the feeds, the v1 lists, `latest`, the sitemap and
 * the neighbouring-page links. A *named* blank issue is still served as its own honest empty state
 * (`v1Report`/`loadReport`), it just is never advertised.
 */
function readableRows(index: ReportIndex, shape: "daily" | "periodic", limit: number, before?: string | null, accept: (r: ReportIndex["rows"][number]) => boolean = () => true) {
  // `before` is a cursor over the period key, applied **before** the slice: with ~300 dailies behind a
  // 180-row list, filtering after the slice would answer "no such issue" for every date the client had
  // already seen, which is the opposite of paging. Keys are fixed-width and zero-padded per kind, so
  // text order is chronological — the same fact `reportIndexRows`' `ORDER BY key DESC` relies on.
  return index.rows
    // 这一条**不能**改成 `withPage.has(id)`：本库没有的 id（旧引用、已删除的行）在渲染时是
    // "指向原文链接"的引用，读者不会被送到一个 404（见 tests/rss-conditional.test.ts 里
    // 「an id this database has no row for is offered its original article」）。索引要排除的是
    // `withoutPage` 那一类——**本库有这一行、但页面按发布/工作流闸门拒绝放行**的条目。
    .filter((r) => citedItemIds(r.content, shape).some((id) => !index.withoutPage.has(id)))
    // 语言门也要在 slice 之前：先截 400 期再筛英文，英文期稀疏时更早的英文刊面永远进不了索引。
    .filter(accept)
    .filter((r) => !before || r.key < before)
    .slice(0, limit);
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT, lang: SiteLang = "zh"): Promise<ReportIndexEntry[]> {
  const strictEn = lang === "en" && englishTextMode() === "strict";
  // 英文索引从「有英文稿的期次」里取 400，而不是从全部期次里取 400 再过滤。
  const index = await reportIndex(kind, strictEn);
  const shape = kind === "daily" ? "daily" : "periodic";
  const entries = readableRows(index, shape, limit, undefined,
    // strict 的 /en 索引只列真有英文刊面的期次，与 `loadReport` 那道门是同一个函数。
    (r) => !strictEn || englishReportReady(kind, r.content, englishContentOf(r)))
    .map((r) => {
      const en = lang === "en" ? englishContentOf(r) : null;
      const headline = reportHeadline(r.content, shape, index.gone, lang, en);
      // 期次标题是动态内容；缺英文时用「Daily · 2026-09-30」这种期名，不把中文 lead 标题印进 /en 的侧栏。
      const title = lang === "en" && (!headline || hasChineseCopy(headline))
        ? `${shape === "daily" ? "Daily" : kind === "weekly" ? "Weekly" : "Monthly"} · ${r.key}`
        : headline;
      return {
        key: r.key,
        title,
        generatedAt: r.generated_at.toISOString(),
        // 「本期 N 件大事」= 这份报纸真的排出来多少条：`pagesOf` 按 key 去重（头条与分栏里的同一条只算一次），
        // 并且条目页面没了也仍然印着（划掉的那一行）。以前这里筛掉 withoutPage、又不查重，
        // 于是同一期在归档里和在报头上可能是两个数（今天数据恰好一致：29 = 29）。
        count: new Set(citedItemIds(r.content, shape)).size,
        // The issue's own number, stamped at publication (migration 0048). Not derived from position:
        // past the newest-400 window a position stops meaning anything, and a number must never move.
        no: r.issue_no ?? null,
        textLocale: textLocaleOf(title, null),
      };
    });
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
export function v1Reports(kind: "daily", limit: number, before?: string | null): Promise<V1DailiesBody>;
export function v1Reports(kind: "weekly" | "monthly", limit: number, before?: string | null): Promise<V1PeriodicListBody>;
export async function v1Reports(kind: ReportKind, limit: number, before?: string | null): Promise<V1DailiesBody | V1PeriodicListBody> {
  const { index, rows } = await readableReports(kind, limit, before);
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
    SELECT kind, key, window_start, window_end, content, content_en, revision, revision_en, generated_at FROM reports WHERE kind = ${kind} AND key = ${wanted}`;
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
    const links = (i: any) => ({ aihot: i.itemId && avail.get(i.itemId)?.available ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
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
            attribution: attribution(links(i).aihot ?? url),
          })),
        })),
        flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          source: { name: String(i.sourceName ?? "") },
          links: links(i),
          publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
          attribution: attribution(links(i).aihot ?? url),
        })),
      },
    };
  }
  const raw: Array<Record<string, any>> = (c.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const links = (i: any) => ({ aihot: i.itemId && avail.get(i.itemId)?.available ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
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
        links: links(i),
        publishedAt: i.publishedAt ? new Date(i.publishedAt).toISOString() : null,
        attribution: attribution(links(i).aihot ?? url),
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
export const v1Dailies = (limit: number, before?: string | null): Promise<V1DailiesBody> => v1Reports("daily", limit, before);
export const v1Daily = (date: string | "latest"): Promise<V1DailyBody | null> => v1Report("daily", date);

export { siteUrl };

export function reportNavigation(kind: ReportKind, index: ReportIndexEntry[], key: string): ReportNavigationEntry[] {
  const at = index.findIndex((e) => e.key === key);
  return index.map((entry, n) => ({ key: entry.key, no: entry.no,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string, lang: SiteLang = "zh") {
  return reportNavigation(kind, await listReports(kind, INDEX_LIMIT, lang), key);
}

export async function loadReportMonth(kind: ReportKind, month: string, lang: SiteLang = "zh") {
  return (await listReports(kind, INDEX_LIMIT, lang)).filter((e) => e.key.startsWith(month)).map(({ key, title, textLocale }) => ({ key, title, ...(textLocale ? { textLocale } : {}) }));
}
