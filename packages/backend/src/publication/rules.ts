// Publication rules. Each rule is defined once here and used by every exit.
import { hasChineseCopy } from "@aihot/contracts/copy";

export interface SourceFacts {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  first_party: boolean;
  site_fulltext: boolean;
  syndicate_fulltext: boolean;
  /** The section this source's items belong to when no explicit judgement exists (taxonomy key or null). */
  default_category: string | null;
}

export function channelOf(sourceKind: string, hasXPost: boolean): "x" | "news" {
  return sourceKind === "x_search" || hasXPost ? "x" : "news";
}

/** Public pool (/all): editorial sources, AI relevant, with a Chinese title and summary. */
export function isPoolEligible(input: {
  participationMode: string;
  relevance: string | null;
  title: string | null;
  summary: string | null;
}): boolean {
  return input.participationMode === "editorial" && input.relevance === "pass" && !!input.title && !!input.summary;
}

/**
 * The release gate for a row read on its own (the SQL twin is `releasedCondition` in items.ts, used by
 * every list): a selected item stays private until its `visible_after` passes, ~180 s after it met the
 * selection conditions. Everything not selected is already released.
 */
export function isReleased(p: { selected: boolean; visibleAfter: Date | null }, now: Date): boolean {
  return !p.selected || (p.visibleAfter !== null && p.visibleAfter <= now);
}

/**
 * One answer to "does this item have a page a reader can open?" — the detail page, its Markdown export, its
 * share card, the starred-items check and the citations a daily or weekly shows all ask this, so none of
 * them can disagree (a `summary-only` item used to open from 收藏 while the paper quoting it struck it
 * through as if withdrawn). Every unwithdrawn item from an editorial source has one, with or without a
 * Chinese summary (noindex unless indexable); a paused source keeps its pages; hot_signal material is heat
 * evidence only and has none. A selected item waiting behind the release gate has none yet either: every
 * list already hides it, so an item page, an og card and a sitemap entry answering 200 for it during the
 * embargo are a leak, not a preview.
 */
export interface ItemPageFacts {
  visibility: string;
  sourceMode: string;
  selected: boolean;
  visibleAfter: Date | null;
}
export function itemHasPage(p: ItemPageFacts, now: Date = new Date()): boolean {
  return p.visibility !== "withdrawn" && p.sourceMode === "editorial" && isReleased({ selected: p.selected, visibleAfter: p.visibleAfter }, now);
}

/**
 * 一个事实的"报道成员"是哪几种关系：`primary`（这条就是讲它）与 `report`（报道了它）。
 * `mention` 只是顺带被提到，不算成员。写 `publications.fact_id` 时用的是这一份，
 * 事件页的成员列表与「另有 N 家信源报道」那个数也必须是这一份——
 * 第三十四轮评审实测：面板原先不带这个过滤，于是标题写 2 家、展开列出 3 条。
 */
export const FACT_MEMBER_ROLES = ["primary", "report"];

/** Selected: pool eligible, judged selected, and the source tier may enter the selection. */
export function isSelectable(eligible: boolean, judgedSelected: boolean | null, tier: string): boolean {
  return eligible && judgedSelected === true && tier !== "EXCLUDE_MP";
}

/**
 * Site full text: the source licence allows showing it and we have confirmed body text.
 * WeChat and paywalled content never get it just because it was fetchable (source flag false).
 */
export function bodyModeOf(source: SourceFacts, bodyStatus: string, hasBody: boolean): "full" | "summary" {
  return source.site_fulltext && bodyStatus === "ok" && hasBody ? "full" : "summary";
}

/** Full-RSS redistribution whitelist: only sources that explicitly allow it. */
export function mayRedistribute(source: SourceFacts, bodyMode: "full" | "summary"): boolean {
  return source.syndicate_fulltext && bodyMode === "full";
}

/**
 * Detail pages are noindex by default. Selected items are indexed automatically; an editor
 * can mark any other public page for indexing, or exclude a page, which then stays out.
 *
 * This is the projection stored on the row, so it must not read a clock: nothing republishes an item when
 * its embargo lifts, and a `visible_after` test here would leave the row noindex forever. The release gate
 * is applied where the stored flag is read — `itemHasPage` for the page itself, `releasedCondition` for the
 * sitemap entries built from this column.
 *
 * The automatic branch follows the reader-facing rule: an item without Chinese copy is on no list, no feed
 * and no daily (the gate in `items.ts`), so promising its page to a crawler advertised a page the site
 * itself hides — measured 2026-10-05 with eleven selected-but-English items in the sitemap, one of them in
 * the live one. An editor's explicit mark stays absolute: that is the whole point of the mark.
 */
export function isIndexable(p: { visibility: string; title: string | null; hasSummary: boolean; selected: boolean; seoIndexedAt: Date | null; seoExcludedAt: Date | null }): boolean {
  return p.visibility === "public" && p.hasSummary && p.seoExcludedAt === null && ((p.selected && hasChineseCopy(p.title)) || p.seoIndexedAt !== null);
}

/** Display tags exclude internal entity markers. */
export function displayTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith("entity:"));
}
