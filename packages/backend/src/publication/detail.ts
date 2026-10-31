import {readableBulletin} from '../content/readable-bulletin.ts';
// Item detail and Markdown export, both behind the same visibility and licence rules.
import type { ItemDetail, SiteItemDetail, OutlineEntry, StoryRef } from "@aihot/contracts/site";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { sql } from "../db.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { textToHtml } from "../content/sanitize.ts";
import { dedupeConsecutiveFigures, translationTextDefect } from "../content/body-quality.ts";
import { ITEM_COLUMNS, ITEM_FROM, chineseCopyCondition, releaseGateCondition, releasedCondition, toItemSummary, videoMedia, xView, type ItemRow } from "./items.ts";
import { listTopics, topicMatchTags } from "./topics.ts";
import { bodyIsChinese, hasChineseCopy, isLabelOnlyCopy } from "@aihot/contracts/copy";
import { itemUrl } from "./links.ts";
import { itemHasPage } from "./rules.ts";
import { workflowReadyCondition } from "./readiness.ts";
import { SITE } from "@aihot/industry/site";

interface DetailRow extends ItemRow {
  article_revision: number;
  preparation_media: unknown;
  tr_revision: number | null;
  body_html: string | null;
  body_text: string | null;
  body_status: string;
  tr_html: string | null;
  tr_complete: boolean | null;
  media: unknown;
  workflow_ready: boolean;
  source_fulltext: boolean;
}

export type DetailResult =
  | { kind: "found"; detail: ItemDetail; row: DetailRow }
  | { kind: "not_found" };

/** Preserve the entire stored body. Reader performance must never discard article content. */
export function prepareArticleBody(html: string): { html: string; shown: number; total: number; truncated: boolean } {
  const total = cheerio.load(html, null, false).root().text().length;
  return { html, shown: total, total, truncated: false };
}

/** Adds stable ids to h2–h4 and returns the outline. */
function withOutline(html: string): { html: string; outline: OutlineEntry[] } {  const outline: OutlineEntry[] = [];
  let n = 0;
  const out = html.replace(/<h([2-4])(?: id="sec-\d+")?>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    n += 1;
    const id = `sec-${n}`;
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (text) outline.push({ id, text: text.slice(0, 80), level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, outline };
}

/**
 * The topics an item belongs to, matched back with the same semantics a topic page matches forward
 * (`topicMatchTags`), against the item's raw tags — the `p.tags` array the row carries, not the display
 * tags, so the withheld-tags page still shows where its item lives. `listTopics` is position-ordered
 * (and process-cached), so the filtered list keeps that order.
 */
async function itemTopics(tags: string[]): Promise<Array<{ slug: string; name: string }>> {
  if (tags.length === 0) return [];
  return (await listTopics())
    .filter((t) => topicMatchTags(t).some((tag) => tags.includes(tag)))
    .slice(0, 6)
    .map((t) => ({ slug: t.slug, name: t.name }));
}

/** The SQL twin of `rules.itemHasPage` widened one notch: public visibility, an editorial source,
 *  past the release gate (the summary-only admin pull keeps hiding everywhere, as pinned). Body
 *  completeness is NOT part of it — a summary-licence item keeps its restricted page (title, summary,
 *  source, original link), and a full-licence item whose workflow is still running gets the same page.
 *  The release half is the one spelling (`releaseGateCondition`); what the lists show is decided by
 *  the list predicates, and the page only has to stop lying about a citation the paper already printed. */
function pageGate(now: Date) {
  return sql`p.visibility = 'public' AND s.participation_mode = 'editorial' AND ${releaseGateCondition(now)}`;
}

async function loadRow(id: string, preparingMedia = false): Promise<DetailRow | null> {
  const [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS}, ${preparingMedia ? sql`true` : workflowReadyCondition()} AS workflow_ready,
      s.site_fulltext AS source_fulltext,
      a.revision AS article_revision, a.media AS preparation_media, tr.revision AS tr_revision, a.body_html, a.body_text, a.body_status, tr.body_html AS tr_html, tr.complete AS tr_complete
    ${ITEM_FROM}
    WHERE p.article_id = ${id} ${preparingMedia ? sql`` : sql`AND ${pageGate(new Date())}`}`;
  return row ?? null;
}

/** The four row fields the page rule reads; every exit that asks "does this item have a page" builds them the same way. */
export function pageFacts(row: Pick<ItemRow, "visibility" | "source_mode" | "selected" | "visible_after">) {
  return { visibility: row.visibility, sourceMode: row.source_mode, selected: row.selected, visibleAfter: row.visible_after };
}

/**
 * Public detail (rules.itemHasPage): items the lists leave out (low relevance, merged duplicates, no
 * Chinese summary yet) keep a noindex page; withdrawn, hot_signal and not-yet-released items are a 404.
 *
 * Two grades on one row, decided after the row is in memory:
 *  · workflow ready → the complete reading page as before;
 *  · public + editorial + released + Chinese title + summary, but the source lends no full text → a
 *    restricted page (title, AI summary, source, original link — everything a daily already shows) so
 *    a citation never lands on a 404. Nothing pretends to be the article; a workflow still running on
 *    a full-licence row stays a 404 (docs/complete-reader-policy.md).
 */
export function loadItemDetail(id: string, now = new Date()): Promise<DetailResult> {
  return buildItemDetail(id, now, false);
}

/** Worker-only input for prewarming before release. Never exposed by a public route or parameter. */
export function loadItemForMediaPreparation(id: string): Promise<DetailResult> {
  return buildItemDetail(id, new Date(), true);
}

async function buildItemDetail(id: string, now: Date, preparingMedia: boolean): Promise<DetailResult> {
  const row = await loadRow(id, preparingMedia);
  if (!row || (preparingMedia ? row.visibility === "withdrawn" || row.source_mode !== "editorial" : !itemHasPage(pageFacts(row), now))) return { kind: "not_found" };

  const summary = toItemSummary(row);
  if (row.channel === "x") summary.x = xView(row, false, true);
  const topics = await itemTopics(row.tags);
  // The page gate above is deliberately lighter than the full-body gate, so the read grades the row
  // itself: the complete page needs the workflow's own verdict; without it the row either stays in the
  // back office (full-licence row — docs/complete-reader-policy.md 放行条件 2: 提取未确认的材料只留在
  // 后台) or opens the summary-licence restricted page — title, AI summary, source, original link,
  // exactly the citation a daily already printed (`site_fulltext = false` is a permanent licence state:
  // 62,860 rows in production). An admin's `summary-only` pull keeps hiding everywhere (pageGate). A
  // restricted page only earns its place when it can carry that citation: a Chinese title and a
  // non-empty summary — an unsummarised row or a label-only wreck (`title_zh:`) has nothing to show,
  // and an empty shell is worse than a 404.
  if (isLabelOnlyCopy(row.title) || isLabelOnlyCopy(row.summary)) return { kind: "not_found" };
  if (!row.workflow_ready) {
    if (row.source_fulltext || !hasChineseCopy(row.title) || !row.summary?.trim()) return { kind: "not_found" };
    const detail: ItemDetail = {
      ...summary,
      reason: null,
      tags: [],
      x: null,
      readingMode: "summary-licence",
      author: null,
      language: row.language,
      body: null,
      outline: [],
      relatedStories: [],
      indexable: false,
      markdownAvailable: false,
      group: null,
      topics,
      media: videoMedia(row.media),
    };
    return { kind: "found", detail, row };
  }

  const related = await sql<StoryRef[]>`
    SELECT DISTINCT st.public_id::text AS "publicId", st.title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND fa.role <> 'mention' AND st.merged_into IS NULL
    LIMIT 6`;

  let body: ItemDetail["body"] = null;
  let outline: OutlineEntry[] = [];
  if (row.channel === "x") {
    const text = String(row.x_post?.text ?? row.body_text ?? "");
    body = {
      zh: summary.x?.translation ? textToHtml(summary.x.translation) : null,
      original: text ? textToHtml(text) : null,
      zhKind: summary.x?.translation ? "translation" : null,
      complete: true,
    };
  } else if (row.body_mode === "full" && (row.body_html || row.body_text)) {
    const isZh = bodyIsChinese(row.language, row.body_text ?? "");
    // 采集器常常只交回纯文本（RSS 的 description 之外没有 html）：这一类正文也得给读者看，
    // 否则投影说是 full、页面却什么也不渲染——读者看到的是"有正文这条不存在"。
    const original = proxyBodyImages(readableBulletin(row.url,dedupeConsecutiveFigures(row.body_html || (row.body_text ? textToHtml(row.body_text) : ""))));
    const zh = isZh ? original : row.tr_html && !translationTextDefect(row.tr_html) ? proxyBodyImages(readableBulletin(row.url,dedupeConsecutiveFigures(row.tr_html))) : null;
    // 原文和译文都保留到结尾，目录锚点覆盖全部章节；语言投影仍只发送当前阅读语言。
    const shown = prepareArticleBody(zh ?? original);
    const primary = withOutline(shown.html);
    const preparedOriginal = zh && !isZh ? prepareArticleBody(original) : null;
    outline = primary.outline;
    body = {
      zh: zh ? primary.html : null,
      original: preparedOriginal ? withOutline(preparedOriginal.html).html : isZh ? null : primary.html,
      zhKind: isZh ? "original" : zh ? "translation" : null,
      complete: isZh ? true : row.tr_complete ?? false,
      truncated: shown.truncated,
      shownChars: shown.shown,
      totalChars: shown.total,
    };
  }

  let group: ItemDetail["group"] = null;
  if (row.fact_id) {
    // The same predicate as the panel this number opens (groups.ts, and timeline.ts for the card): without
    // the Chinese gate the page promised 「另有 3 家信源报道」 while the expansion listed two, because
    // reports with no Chinese write-up are on no list — including this one.
    const [g] = await sql<{ public_id: string; reports: number; sources: number }[]>`
      SELECT f.public_id, count(p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
      FROM facts f JOIN publications p ON p.fact_id = f.id
      WHERE f.id = ${row.fact_id} AND p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)} AND ${chineseCopyCondition()}
      GROUP BY f.public_id`;
    if (g) {
      // No development count here: this page renders only "另有 N 家信源报道", and `developmentCount` means
      // "the rows the 展开 N 条进展 list shows", a list only a feed card has (`timeline.ts` defines it).
      // The detail page used to compute its own version — the same story's facts minus the card's own — and
      // the two numbers differed by exactly one, which is how a second meaning for one field name appears.
      group = {
        factId: g.public_id,
        story: summary.story,
        reportCount: Number(g.reports),
        additionalSourceCount: Math.max(0, Number(g.sources) - 1),
      };
    }
  }

  const detail: ItemDetail = {
    ...summary,
    readingMode: "full",
    author: row.author,
    language: row.language,
    body,
    outline,
    relatedStories: related,
    indexable: row.indexable,
    markdownAvailable: markdownAvailable(row),
    group,
    topics,
    media: videoMedia(row.media),
  };
  return { kind: "found", detail, row };
}

/**
 * Same predicate for the export button and the export route: a public page with something to export
 * (a summary, the post, or a full-text body). An item behind the release gate has no page, so it has no
 * export either — the button and the route must not offer what the page itself refuses. A restricted
 * preview page (summary-licence source, or a workflow still running) exports nothing: what it shows is
 * the citation the paper already printed, not a copyable article.
 */
export function markdownAvailable(row: {
  visibility: string; source_mode: string; selected: boolean; visible_after: Date | null; workflow_ready: boolean;
  summary: string | null; body_mode: string; body_html?: string | null; channel: string; x_post: Record<string, any> | null;
}, now = new Date()): boolean {
  if (row.visibility !== "public" || !row.workflow_ready || !itemHasPage(pageFacts(row), now)) return false;
  return !!row.summary || (row.channel === "x" && !!row.x_post?.text) || (row.body_mode === "full" && !!row.body_html);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

export async function exportMarkdown(id: string): Promise<{ filename: string; body: string } | null> {
  const row = await loadRow(id);
  if (!row || !markdownAvailable(row)) return null;
  const lines: string[] = [];
  lines.push(`# ${row.title}`, "");
  if (row.original_title) lines.push(`> 原标题：${row.original_title}`, "");
  lines.push(`- 来源：${row.source_name}`);
  lines.push(`- 发布时间：${(row.published_at ?? row.discovered_at).toISOString()}`);
  lines.push(`- ${SITE.name}：${itemUrl(row.id)}`);
  lines.push(`- 原文：${row.url}`, "");
  if (row.summary) lines.push("## 摘要", "", row.summary, "");
  if (row.selected && row.reason) lines.push("## 推荐理由", "", row.reason, "");
  if (row.channel === "x" && row.x_post?.text) {
    lines.push("## 正文", "", String(row.x_post.text), "");
    if (row.zh_text) lines.push("## 中文译文", "", row.zh_text, "");
    const q = row.x_post.quoted as { handle?: string; text?: string; url?: string } | null | undefined;
    if (q?.text) lines.push(`## 引用 @${q.handle ?? ""}`, "", ...String(q.text).split("\n").map((l) => `> ${l}`), "", ...(q.url ? [q.url, ""] : []));
    if (q?.text && row.quoted_zh) lines.push("### 引用中文译文", "", ...row.quoted_zh.split("\n").map((l) => `> ${l}`), "");
  } else if (row.body_mode === "full" && (row.body_html || row.body_text)) {
    // The same question the page asks (`loadRow`'s reading projection above), spelled once
    // (`contracts/copy.ts`): a declared language wins over a sample, and a declared `en` is an English
    // body even when the article quotes a Chinese line.
    const isZh = bodyIsChinese(row.language, row.body_text ?? "");
    if (!isZh && row.tr_html && row.tr_complete) lines.push("## 正文 · 中文译文", "", turndown.turndown(row.tr_html), "");
    lines.push(isZh ? "## 正文" : "## 正文 · 原文", "", turndown.turndown(row.body_html || textToHtml(row.body_text!)), "");
  }
  // The download carries the site's own identity, not the framework's (upstream a75140b): `aihot-…md`
  // in a reader's Downloads folder is the upstream name, which this deployment must not use.
  return { filename: `${SITE.mcpPrefix}-${row.id}.md`, body: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}

/** Site reading projection: default text remains SSR, a second language has its own readable URL. */
export function siteItemDetail(detail: ItemDetail, original = false): SiteItemDetail {
  const hasTranslation = !!detail.body?.zh && detail.body.zhKind === "translation" && !!detail.body.original;
  const bodyLanguage = original && detail.body?.original ? "original" : detail.body?.zh ? "zh" : "original";
  const selectedHtml = bodyLanguage === "zh" ? detail.body?.zh : detail.body?.original;
  const { text: _text, translation: _translation, ...x } = detail.x ?? {} as NonNullable<ItemDetail["x"]>;
  return { ...detail, x: detail.x ? x : null, hasTranslation, bodyLanguage,
    body: detail.body ? { ...detail.body, zh: bodyLanguage === "zh" ? detail.body.zh : null, original: bodyLanguage === "original" ? detail.body.original : null } : null,
    outline: selectedHtml ? withOutline(selectedHtml).outline : [],
  };
}
