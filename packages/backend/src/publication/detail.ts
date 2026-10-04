// Item detail and Markdown export, both behind the same visibility and licence rules.
import type { ItemDetail, SiteItemDetail, OutlineEntry, StoryRef } from "@aihot/contracts/site";
import TurndownService from "turndown";
import { sql } from "../db.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { textToHtml } from "../content/sanitize.ts";
import { ITEM_COLUMNS, ITEM_FROM, releasedCondition, toItemSummary, xView, type ItemRow } from "./items.ts";
import { itemUrl } from "./links.ts";
import { itemHasPage } from "./rules.ts";
import { SITE } from "@aihot/industry/site";

interface DetailRow extends ItemRow {
  body_html: string | null;
  body_text: string | null;
  body_status: string;
  tr_html: string | null;
  tr_complete: boolean | null;
}

export type DetailResult =
  | { kind: "found"; detail: ItemDetail; row: DetailRow }
  | { kind: "not_found" };

/** Adds stable ids to h2–h4 and returns the outline. */
function withOutline(html: string): { html: string; outline: OutlineEntry[] } {
  const outline: OutlineEntry[] = [];
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

async function loadRow(id: string): Promise<DetailRow | null> {
  const [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS}, a.body_html, a.body_text, a.body_status, tr.body_html AS tr_html, tr.complete AS tr_complete
    ${ITEM_FROM}
    WHERE p.article_id = ${id}`;
  return row ?? null;
}

/** The four row fields the page rule reads; every exit that asks "does this item have a page" builds them the same way. */
export function pageFacts(row: Pick<ItemRow, "visibility" | "source_mode" | "selected" | "visible_after">) {
  return { visibility: row.visibility, sourceMode: row.source_mode, selected: row.selected, visibleAfter: row.visible_after };
}

/**
 * Public detail (rules.itemHasPage): items the lists leave out (low relevance, merged duplicates, no
 * Chinese summary yet) keep a noindex page; withdrawn, hot_signal and not-yet-released items are a 404.
 */
export async function loadItemDetail(id: string, now = new Date()): Promise<DetailResult> {
  const row = await loadRow(id);
  if (!row || !itemHasPage(pageFacts(row), now)) return { kind: "not_found" };

  const summary = toItemSummary(row);
  if (row.channel === "x") summary.x = xView(row, false, true);
  if (row.visibility === "summary-only") {
    const detail: ItemDetail = {
      ...summary,
      reason: null,
      tags: [],
      x: null,
      readingMode: "summary-only",
      author: null,
      language: row.language,
      body: null,
      outline: [],
      relatedStories: [],
      indexable: false,
      markdownAvailable: false,
      group: null,
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
  } else if (row.body_mode === "full" && row.body_html) {
    const isZh = row.language === "zh" || (/[一-鿿]/.test(row.body_text?.slice(0, 400) ?? "") && row.language !== "en");
    const original = proxyBodyImages(row.body_html);
    const zh = isZh ? original : row.tr_html ? proxyBodyImages(row.tr_html) : null;
    const primary = withOutline(zh ?? original);
    outline = primary.outline;
    body = {
      zh: zh ? primary.html : null,
      original: zh && !isZh ? withOutline(original).html : isZh ? null : primary.html,
      zhKind: isZh ? "original" : zh ? "translation" : null,
      complete: isZh ? true : row.tr_complete ?? false,
    };
  }

  let group: ItemDetail["group"] = null;
  if (row.fact_id) {
    const [g] = await sql<{ public_id: string; reports: number; sources: number }[]>`
      SELECT f.public_id, count(p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
      FROM facts f JOIN publications p ON p.fact_id = f.id
      WHERE f.id = ${row.fact_id} AND p.visibility = 'public' AND p.eligible AND ${releasedCondition(now)}
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
  };
  return { kind: "found", detail, row };
}

/**
 * Same predicate for the export button and the export route: a public page with something to export
 * (a summary, the post, or a full-text body). An item behind the release gate has no page, so it has no
 * export either — the button and the route must not offer what the page itself refuses.
 */
export function markdownAvailable(row: {
  visibility: string; source_mode: string; selected: boolean; visible_after: Date | null;
  summary: string | null; body_mode: string; body_html?: string | null; channel: string; x_post: Record<string, any> | null;
}, now = new Date()): boolean {
  if (row.visibility !== "public" || !itemHasPage(pageFacts(row), now)) return false;
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
  } else if (row.body_mode === "full" && row.body_html) {
    const isZh = row.language === "zh";
    if (!isZh && row.tr_html && row.tr_complete) lines.push("## 正文 · 中文译文", "", turndown.turndown(row.tr_html), "");
    lines.push(isZh ? "## 正文" : "## 正文 · 原文", "", turndown.turndown(row.body_html), "");
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
