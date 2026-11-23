// First-party site API (/api/site/*). Not a public API: it may evolve with the website,
// but it is served from the same public read layer as v1, RSS and MCP.
import type { CategoryKey, ChannelKey } from "./taxonomy.ts";

export type SourceKind = "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";

/** 站点读取语言：显式 `?lang=en`，缺省 zh。 */
export type SiteLang = "zh" | "en";
/** 一段读者文本的实际语言：标题与摘要都英文才是 en，任一中文/回退是 mixed。 */
export type TextLocale = "zh" | "en" | "mixed";

export interface SourceRef {
  id: string;
  name: string;
  kind: SourceKind;
  firstParty: boolean;
  iconUrl: string | null;
  iconSrcSet?: string;
  /** 信源名 `name` 实际来自哪个语言列；英文缺失而回退中文时为 zh。 */
  nameLocale?: "zh" | "en";
}

export interface MediaView {
  kind: "image" | "video";
  url: string;
  /** Full image for an on-demand viewer; list previews stay small. */
  fullUrl?: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  poster: string | null;
  srcSet?: string;
}

export interface XPostView {
  authorName: string;
  handle: string;
  avatarUrl: string | null;
  avatarSrcSet?: string;
  text: string;
  translation: string | null;
  /**
   * translation: 被引用帖的译文，与原文不同才给。`translationLocale` 说明它的实际语言：
   * `/en` 优先 `quote_translations_en`，缺英文改用中文译文时标记为 `zh`（回退，不是英文）。
   */
  quoted: { authorName: string; handle: string; text: string; url: string; translation: string | null; translationLocale?: "zh" | "en" } | null;
  media: MediaView[];
}

export interface StoryRef {
  publicId: string;
  title: string;
}

export interface ItemSummary {
  id: string;
  revision: number;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  reason: string | null;
  source: SourceRef;
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  timelineAt: string;
  category: CategoryKey | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  story: StoryRef | null;
  x: XPostView | null;
  /** 这条卡片实际发出的是英文、中文，还是中英混合（英文缺失时的回退）。 */
  textLocale?: TextLocale;
}

/** The fields rendered by a site feed card; full original text lives in the item detail. */
export interface FeedItemSummary extends Pick<ItemSummary, "id" | "title" | "summary" | "reason" | "publishedAt" | "timelineAt" | "category" | "tags" | "score" | "selected" | "channel" | "textLocale"> {
  source: Pick<SourceRef, "name" | "nameLocale">;
  /**
   * The source's own headline as collected — English for most international sources, the original
   * wording when the model paraphrased or translated it into the Chinese `title`. Null when the
   * published title already is the source headline verbatim (a Chinese source adopted as-is).
   * English list pages prefer it over the model-written Chinese `title`; Chinese pages never read it.
   */
  originalTitle: string | null;
  /**
   * The same licence {@link ItemDetail.media} lends under: only a video source's own still, at most
   * three and sized for the list, with `fullUrl` for a lightbox. A text source lends its summary, not
   * its photographs; an X post keeps its media in `x.media` and adds none here.
   */
  media?: MediaView[];
  x: (Pick<XPostView, "authorName" | "handle" | "avatarUrl" | "avatarSrcSet" | "media"> & {
    quoted: Omit<NonNullable<XPostView["quoted"]>, "url"> | null;
  }) | null;
}

export interface GroupInfo {
  factId: string;
  story: StoryRef | null;
  /** Other public sources of the fact the card represents (same set as the expandable reports). */
  additionalSourceCount: number;
  /** Distinct public reports across the group's facts. */
  reportCount: number;
  /**
   * Facts of the group (the card's own included) with at least one selected item under the current filters —
   * exactly the rows the "展开 N 条进展" list then shows, which is why the card's own fact is inside the count.
   * Defined once, in `publication/timeline.ts`; the item detail page has no development list and so does not
   * compute it (see {@link ItemDetailGroup}).
   */
  developmentCount: number;
  /** The newest development when it is not the card's own fact: why the card sits where it does. */
  latestDevelopment?: { factId: string; title: string; at: string } | null;
}

/** The group as an item detail page shows it: only "另有 N 家信源报道" is rendered there, so no development count exists to agree or disagree with. */
export type ItemDetailGroup = Omit<GroupInfo, "developmentCount" | "latestDevelopment">;

export interface TimelineCard {
  key: string;
  anchorAt: string;
  item: FeedItemSummary;
  group: GroupInfo | null;
}

export interface HotStripEntry {
  rank: number;
  title: string;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  storyPublicId: string | null;
  itemId: string | null;
  participants: HotParticipant[];
  participantCount: number;
  textLocale?: TextLocale;
}

export interface TimelineFilters {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
  topic?: string | null;
  /** 读取语言；缺省按 zh。 */
  lang?: SiteLang;
}

export interface TimelineResponse {
  filters: TimelineFilters;
  cards: TimelineCard[];
  nextCursor: string | null;
  /** Absolute time when a pending item in this scope becomes visible; the page re-checks then. */
  refreshAt: string | null;
  hot: HotStripEntry[] | null;
  /** Cut-off time of the board behind `hot` — the strip can be yesterday's last board with events in it, so the block says which hour it is from. */
  hotAsOf: string | null;
  dayCounts: Record<string, number>;
  generatedAt: string;
  /** 实际读取语言（显式 `?lang=en`，缺省 zh）。 */
  lang?: SiteLang;
}

export interface PoolResponse {
  filters: TimelineFilters & { q: string | null; tab: "time" | "relevance" };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  total: number;
  todayCount: number;
  freshness: string;
  generatedAt: string;
  lang?: SiteLang;
}

export interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

export interface ItemDetail extends ItemSummary {
  /**
   * How much of the item this page may show:
   *  · `full` — the complete reading page (workflow-verified body, licence allows full text);
   *  · `summary-licence` — the source lends no full text: title, AI summary, source and original link
   *    only. Same layout as `full`; the page states why the body is absent, and nothing pretends
   *    to be the article.
   */
  readingMode: "full" | "summary-licence";
  author: string | null;
  language: string | null;
  /**
   * Chinese body (translation or Chinese original) and original body, whitelisted HTML.
   * `truncated` says the shown text is only the leading part of a body longer than the reader cap —
   * the page must say so instead of silently ending (a journal article can run past 400,000 characters).
   */
  body: {
    zh: string | null; original: string | null; zhKind: "translation" | "original" | null; complete: boolean;
    /** 当前 revision 的英文正文（`translations.lang='en'`）；源文本身是英文时英文在 `original`。 */
    en?: string | null;
    truncated?: boolean; shownChars?: number; totalChars?: number;
  } | null;
  outline: OutlineEntry[];
  relatedStories: StoryRef[];
  indexable: boolean;
  markdownAvailable: boolean;
  group: ItemDetailGroup | null;
  /**
   * A video source's own still (a YouTube channel's frame), rendered as one tile that opens the platform.
   * Deliberately only video: a text source lends its summary to this site, not its photographs, so an
   * article page keeps showing no pictures while a video page shows the one picture the platform itself
   * uses to name that video.
   */
  media?: MediaView[];
  /**
   * The topics this item belongs to, matched back with the same semantics a topic page matches forward
   * (`topicMatchTags`: a company topic via its entity subject tag, field and genre topics via their own
   * tags), against the item's raw tags. Optional — responses written before the field existed stay valid.
   */
  topics?: Array<{ slug: string; name: string }>;
}

export interface GroupReport {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  timelineAt: string;
  originalUrl: string;
  selected: boolean;
  /** 标题/摘要/信源名实际发出的语言。 */
  textLocale?: TextLocale;
}

export interface GroupReportsResponse {
  factId: string;
  revision: string;
  reports: GroupReport[];
  nextCursor: string | null;
  lang?: SiteLang;
}

export interface Development {
  factId: string;
  title: string;
  occurredAt: string | null;
  representative: ItemSummary;
  reportCount: number;
  textLocale?: TextLocale;
}

export interface DevelopmentsResponse {
  story: StoryRef;
  revision: string;
  developments: Development[];
  nextCursor: string | null;
  lang?: SiteLang;
}

// ---------------------------------------------------------------------------
// Hot ranking and stories
// ---------------------------------------------------------------------------

export interface HotParticipant {
  name: string;
  kind: "editorial" | "signal";
  /** The source's icon, or for an X account its latest collected avatar (proxied). */
  iconUrl: string | null;
  iconSrcSet?: string;
  /** 英文信源名；旧快照没有英文时缺省，`name` 保持中文回退。 */
  nameEn?: string;
}


export interface HotEntryView {
  rank: number;
  story: StoryRef;
  heat: number;
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  /** 英文信源名，按 `sourceNames` 顺序；`lang=en` 时 `sourceNames` 也按它投影。 */
  sourceNamesEn?: string[];
  latestAt: string;
  firstReportAt: string;
  representative: { id: string; url: string; sourceName: string } | null;
  participants: HotParticipant[];
  /** Hourly heat over the 24 hours up to the ranking, oldest first; null where no comparable snapshot exists. */
  spark: Array<number | null>;
  /** The story's AI digest, else its fact statement. */
  summary: string | null;
  /** The latest development, one line. */
  latest: string | null;
  /** A picture from the story's public reports (the representative first), for the leading cards. */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null } | null;
  /** 标题/摘要/最新进展实际发出的语言。 */
  textLocale?: TextLocale;
}

export interface HotResponse {
  computedAt: string | null;
  ruleVersion: string | null;
  windowHours: number;
  entries: HotEntryView[];
  lang?: SiteLang;
}

export interface HeatPoint {
  hour: string;
  heat: number;
  participants: number;
}

export interface StoryReportView {
  id: string;
  title: string;
  summary: string | null;
  source: SourceRef;
  publishedAt: string;
  originalUrl: string;
  selected: boolean;
  factId: string;
  textLocale?: TextLocale;
}

export interface StoryFactView {
  factId: string;
  title: string;
  occurredAt: string | null;
  firstReportAt: string;
  reportCount: number;
  representative: StoryReportView;
  textLocale?: TextLocale;
}

export interface StoryDetail {
  publicId: string;
  title: string;
  textLocale?: TextLocale;
  lang?: SiteLang;
  /**
   * Whether this page makes a promise a crawler can keep: the event's own title is Chinese, i.e. someone
   * wrote this event up. An event whose title is still the source's original language keeps its page (the
   * reports under it are the record) but is `noindex` and stays out of sitemap.xml — the same pair the item
   * pages use, where `itemHasPage` decides "can it be opened" and `indexable` decides "may it be promised".
   */
  indexable: boolean;
  status: "active" | "watching" | "settled";
  reportCount: number;
  sourceCount: number;
  firstReportAt: string | null;
  latestAt: string | null;
  digest: string | null;
  digestUpdatedAt: string | null;
  /** The story's own factual summary, when it has one. */
  summary: string | null;
  /** Without a digest or summary: the summary of the report the story started from. */
  excerpt: { text: string; sourceName: string } | null;
  latest: string | null;
  whyHot: {
    participants48h: number;
    newParticipants6h: number;
    recentReports24h: number;
    observationComplete: boolean;
    rank: number | null;
    heat: number | null;
  };
  developments: StoryFactView[];
  officialReports: StoryReportView[];
  timeline: StoryReportView[];
  heat: HeatPoint[];
  related: Array<StoryRef & { relation: "storyline" | "related"; latestAt: string | null }>;
}

// ---------------------------------------------------------------------------
// Reports (daily / weekly / monthly)
// ---------------------------------------------------------------------------

export type ReportKind = "daily" | "weekly" | "monthly";

export interface ReportCitation {
  itemId: string | null;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
  sourceId: string | null;
  sourceIconUrl: string | null;
  sourceIconSrcSet?: string;
  firstParty: boolean;
  role: string | null;
  storyPublicId: string | null;
  /** When the cited report was published, if it is still in the database. */
  publishedAt: string | null;
  /** False once the item was withdrawn; the citation then shows as removed. */
  available: boolean;
  unavailableReason?: "withdrawn" | "source-restricted" | "workflow-pending" | "not-public";
  /** False for preserved citations with no reader-facing item page; link to sourceUrl instead. */
  hasPage?: boolean;
  /** 这条引用实际发出的标题/摘要/来源名是英文、中文还是混合。 */
  textLocale?: TextLocale;
}

export interface ReportDetail {
  kind: ReportKind;
  key: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  revision: number;
  /**
   * Does this edition carry anything a reader can open? The read layer's one gate (`readableRows`) says an
   * issue whose every citation lost its page is not a newspaper, and hides it from the archive, the feeds
   * and the neighbouring-page links — but a *named* blank issue is still served, honestly, as its own empty
   * state. The masthead needs this flag to keep its promise: a day the archive calls 「未出刊」 must not open
   * by claiming 「每天 08:00 出刊」.
   */
  readable: boolean;
  lead: { title: string; leadParagraph: string } | null;
  overview: string | null;
  highlights: ReportCitation[];
  /** As edited: daily categories, weekly and monthly themes. */
  sections: Array<{ label: string; summary: string | null; items: ReportCitation[] }>;
  /** Reading order: every section item once, labelled with its section. */
  stories: Array<ReportCitation & { label: string }>;
  flashes: ReportCitation[];
  /**
   * The front page's picture: from the lead item (a daily's lead, a weekly or monthly's first highlight),
   * else from another public report of that event. Captioned with the story when it is not the lead's own.
   */
  cover: { url: string; srcSet?: string; width: number | null; height: number | null; caption: string | null } | null;
  metrics: Record<string, number>;
  readingMinutes: number;
  prev: string | null;
  next: string | null;
  /** 刊面散文实际发出的语言。 */
  textLocale?: TextLocale;
  lang?: SiteLang;
}

export interface ReportIndexEntry {
  key: string;
  title: string | null;
  generatedAt: string;
  count: number;
  /** 「第 N 期」: stamped at publication (`reports.issue_no`). Null for a blank issue — one with no
   *  citations never consumed a number — and for a row composed before the column existed. */
  no: number | null;
  textLocale?: TextLocale;
}

/** Figures and samples for the about page (site-only; not part of v1). */
export interface SiteStats {
  /** Sources collected from now. */
  sources: number;
  /** Enabled sources by kind: x_search, rss, web_list, mp_account, json_list. */
  sourceKinds: Record<string, number>;
  /** Of them, sources that only count toward heat (their items never reach 精选). */
  heatOnlySources: number;
  /** Everything collected and not withdrawn, heat-only sources included. */
  items: number;
  selected: number;
  dailies: number;
  /** The last 24 hours: items found (heat-only sources included), and items that made 精选 (by their place on the timeline). */
  day: { collected: number; selected: number };
  /** Enabled sources in a daily shuffle, for the about page's river: one line per source. */
  sampleSources: Array<{ name: string; kind: string; heatOnly: boolean; nameEn?: string }>;
  /** The latest 精选, newest first. */
  latest: Array<{ id: string; title: string; source: string; titleEn?: string; sourceNameEn?: string }>;
  lang?: SiteLang;
}

/** A reading page transfers one language; the canonical item retains both for exports. */
export interface SiteItemDetail extends Omit<ItemDetail, "x"> {
  x: Omit<XPostView, "text" | "translation"> | null;
  hasTranslation: boolean;
  bodyLanguage: "zh" | "en" | "original";
  lang?: SiteLang;
}

export interface StoryFollowup {
  factId: string;
  representative: { id: string; title: string; source: { name: string }; timelineAt: string };
}
export interface StoryFollowupsResponse { items: StoryFollowup[]; more: boolean }

/** All issue keys keep numbering and calendars stable; closed daily months omit their titles. */
export interface ReportNavigationEntry { key: string; title?: string | null; count?: number; no?: number | null }
