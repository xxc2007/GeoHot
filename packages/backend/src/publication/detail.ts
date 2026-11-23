import {readableBulletin} from '../content/readable-bulletin.ts';
// Item detail and Markdown export, both behind the same visibility and licence rules.
import type { ItemDetail, SiteItemDetail, OutlineEntry, SiteLang, StoryRef } from "@aihot/contracts/site";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { sql } from "../db.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { textToHtml } from "../content/sanitize.ts";
import { dedupeConsecutiveFigures, translationTextDefect } from "../content/body-quality.ts";
import { ITEM_COLUMNS, ITEM_FROM, englishCopyCondition, listedCondition, releaseGateCondition, toItemSummary, videoMedia, xView, type ItemRow } from "./items.ts";
import { listTopics, topicMatchTags } from "./topics.ts";
import { bodyIsChinese, hasChineseCopy, isLabelOnlyCopy } from "@aihot/contracts/copy";
import { itemUrl } from "./links.ts";
import { itemHasPage } from "./rules.ts";
import { workflowReadyCondition } from "./readiness.ts";
import { englishReadyCondition } from "./readiness-en.ts";
import { englishPolicy, englishTextMode } from "./english-policy.ts";
import { sourceNameFor } from "./source-name.ts";
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
  /** Set when the not-ready verdict comes from a body-quality defect (pipeline settled, body dirty). */
  body_quality_status: string | null;
  /** 英文文案是否与当前 revision 同步（`englishCopyCondition`）。 */
  english_copy_ready: boolean;
  /** 英文正文就绪（`readiness-en.ts`，strict + english 的成员门）。 */
  english_ready: boolean;
}

export type DetailResult =
  | { kind: "found"; detail: ItemDetail; row: DetailRow }
  | { kind: "not_found"; reason?: "english_not_available" };

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

async function loadRow(id: string, preparingMedia = false, now = new Date(), needEnglishReady = false): Promise<DetailRow | null> {
  const [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS}, ${preparingMedia ? sql`true` : workflowReadyCondition()} AS workflow_ready,
      s.site_fulltext AS source_fulltext,
      a.revision AS article_revision, a.media AS preparation_media, tr.revision AS tr_revision, a.body_html, a.body_text, a.body_status, tr.body_html AS tr_html, tr.complete AS tr_complete,
      r.body_quality_status,
      (CASE WHEN ${englishCopyCondition()} THEN true ELSE false END) AS english_copy_ready,
      (CASE WHEN ${needEnglishReady ? englishReadyCondition(now) : sql`false`} THEN true ELSE false END) AS english_ready
    ${ITEM_FROM}
      LEFT JOIN article_workflow_readiness r ON r.article_id = p.article_id
    WHERE p.article_id = ${id} ${preparingMedia ? sql`` : sql`AND ${pageGate(now)}`}`;
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
/**
 * `lang='en'` 是显式读取语言：fallback 模式下页面照旧（英文有就投影，没有回退中文）；
 * strict 模式下英文不达标即 `not_found` 并带 `reason:'english_not_available'`，由路由给 404 code。
 * 第二参数兼容旧调用（Date）与蓝图里的 `{ lang }` 写法。
 */
export function loadItemDetail(id: string, nowOrOptions: Date | { lang?: SiteLang; now?: Date } = new Date(), langArg: SiteLang = "zh"): Promise<DetailResult> {
  const options = nowOrOptions instanceof Date ? { now: nowOrOptions, lang: langArg } : nowOrOptions;
  const now = options.now ?? new Date();
  const lang = options.lang === "en" ? "en" : "zh";
  return buildItemDetail(id, now, false, lang);
}

/** Worker-only input for prewarming before release. Never exposed by a public route or parameter. */
export function loadItemForMediaPreparation(id: string): Promise<DetailResult> {
  return buildItemDetail(id, new Date(), true, "zh");
}

async function buildItemDetail(id: string, now: Date, preparingMedia: boolean, lang: SiteLang = "zh"): Promise<DetailResult> {
  // strict 的 /en 详情页也要能回答「这条现在是什么状态」：列表可以只收英文，但详情不能因为
  // 缺英文就 404——「英文源」与「无英文回退」两类样本都要有页面可验收（2026-11-23 第 2 轮）。
  // 页面本身仍守住 public / editorial / release 三道门；英文只决定「完整页」还是「摘要页」。
  const needEnglishReady = lang === "en" && englishTextMode() === "strict";
  const row = await loadRow(id, preparingMedia, now, needEnglishReady);
  if (!row || (preparingMedia ? row.visibility === "withdrawn" || row.source_mode !== "editorial" : !itemHasPage(pageFacts(row), now))) return { kind: "not_found" };

  const summary = toItemSummary(row, lang);
  if (row.channel === "x") summary.x = xView(row, false, true, lang);
  const topics = await itemTopics(row.tags);
  // strict+parity 仍是「与中文同一批」：完整页看中文 workflow，不拿 english_ready 扩成员集；
  // strict+english 才用英文就绪门回答完整页。两种模式下缺英文的条目都可以打开英文回退页。
  const englishGrade = lang === "en" && englishTextMode() === "strict";
  const englishMembership = englishGrade && englishPolicy().membership === "english";
  const pageReady = englishMembership ? row.english_ready : row.workflow_ready;
  const fullGrade = pageReady && (row.body_mode === "full" || row.channel === "x");
  // The page gate above is deliberately lighter than the full-body gate, so the read grades the row
  // itself: the complete page needs the workflow's own verdict; without it the row either stays in the
  // back office (full-licence row — docs/complete-reader-policy.md 放行条件 2: 提取未确认的材料只留在
  // 后台) or opens the summary-licence restricted page — title, AI summary, source, original link,
  // exactly the citation a daily already printed (`site_fulltext = false` is a permanent licence state:
  // 62,860 rows in production). An admin's `summary-only` pull keeps hiding everywhere (pageGate). A
  // restricted page only earns its place when it can carry that citation: a Chinese title and a
  // non-empty summary — an unsummarised row or a label-only wreck (`title_zh:`) has nothing to show,
  // and an empty shell is worse than a 404.
  if (lang === "en" ? isLabelOnlyCopy(summary.title) || isLabelOnlyCopy(summary.summary) : isLabelOnlyCopy(row.title) || isLabelOnlyCopy(row.summary)) return { kind: "not_found" };
  if (!fullGrade) {
    const canLead = englishGrade
      ? !!(summary.title?.trim() && summary.summary?.trim())
      : hasChineseCopy(row.title) && !!row.summary?.trim();
    if (!canLead) return { kind: "not_found" };
    const bodyDirty = row.body_quality_status === "defect";
    // Full-text licence but the pipeline has not settled (analysis/translation pending) stays 404:
    // extraction is not confirmed, the material only lives in the back office.
    // A body-quality defect (pipeline settled, body is consent-wall / template-shell / too-short / …)
    // opens the safe-lead restricted page instead: title + summary + source + original link, never the
    // dirty body, never an error page. This is the 2026-11-16 hotfix grade.
    // 英文成员模式下 `body_mode='summary'` 本身就是完整页面（来源只借摘要），不是「未确认的全文」。
    // strict 的 /en 上，全文来源即使中文工作流未就绪，也给摘要页：标题、摘要、来源、原文入口
    // 都是已公开的引用，缺的只是英文全文；这比 404 更能让读者判断有没有英文版。
    if (row.source_fulltext && !bodyDirty && !englishGrade) return { kind: "not_found" };
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
    SELECT DISTINCT st.public_id::text AS "publicId", (CASE WHEN ${lang} = 'en' THEN coalesce(nullif(btrim(st.title_en), ''), st.title) ELSE st.title END) AS title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND fa.role <> 'mention' AND st.merged_into IS NULL
    LIMIT 6`;
  // /en 的相关事件只留有英文标题的：标题是这条链接唯一的内容，中文标题在这里没有回退的去处。
  const relatedVisible = lang === "en" ? related.filter((r) => !hasChineseCopy(r.title)) : related;

  let body: ItemDetail["body"] = null;
  let outline: OutlineEntry[] = [];
  // 当前 revision 的英文译文（complete 且非空）才可用；不完整的英文稿不冒充英文正文。
  const enBodyReady = row.en_body_complete === true
    && (row.en_body_revision === null || row.en_body_revision >= row.article_revision)
    && !!(row.en_body_html || row.en_body_text);
  const enBodyHtml = () => (enBodyReady
    ? proxyBodyImages(readableBulletin(row.url, dedupeConsecutiveFigures(row.en_body_html || textToHtml(row.en_body_text!))))
    : null);
  if (row.channel === "x") {
    const text = String(row.x_post?.text ?? row.body_text ?? "");
    body = {
      zh: summary.x?.translation ? textToHtml(summary.x.translation) : null,
      original: text ? textToHtml(text) : null,
      en: enBodyHtml(),
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
      en: enBodyHtml(),
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
      WHERE f.id = ${row.fact_id} AND p.eligible AND ${listedCondition(now, lang)}
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
    relatedStories: relatedVisible,
    indexable: row.indexable,
    markdownAvailable: markdownAvailable(row, now, pageReady),
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
  title: string; visibility: string; source_mode: string; selected: boolean; visible_after: Date | null; workflow_ready: boolean;
  summary: string | null; body_mode: string; body_html?: string | null; body_text?: string | null; channel: string; x_post: Record<string, any> | null;
}, now = new Date(), readyOverride?: boolean): boolean {
  if (row.visibility !== "public" || !(readyOverride ?? row.workflow_ready) || !itemHasPage(pageFacts(row), now)) return false;
  // Same "label-only wrecks have nothing to show" check the page makes above (`title_zh:` rows answer
  // 404): the export route must not hand out a 300-second CDN-cached file whose body is the label.
  if (isLabelOnlyCopy(row.title) || isLabelOnlyCopy(row.summary)) return false;
  // 页面在 `body_text` only 时也能渲染正文（见上面 169 行的 textToHtml 分支），
  // 所以"能导出 Markdown"的判据必须与它一致，否则这类全文条目点导出返回 null。
  return !!row.summary || (row.channel === "x" && !!row.x_post?.text) || (row.body_mode === "full" && (!!row.body_html || !!row.body_text));
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

export async function exportMarkdown(id: string, lang: SiteLang = "zh"): Promise<{ filename: string; body: string } | null> {
  const needEnglishReady = lang === "en" && englishTextMode() === "strict" && englishPolicy().membership === "english";
  const row = await loadRow(id, false, new Date(), needEnglishReady);
  if (!row) return null;
  const readyOverride = lang === "en" && englishTextMode() === "strict"
    // parity 的成员集仍是中文 workflow；导出还要求当前 revision 的英文稿，别把旧英文复制出去。
    ? (englishPolicy().membership === "english" ? row.english_ready : (row.workflow_ready && row.english_copy_ready && row.english_source_revision === row.revision))
    : undefined;
  if (!markdownAvailable(row, new Date(), readyOverride)) return null;
  if (lang === "en" && englishTextMode() === "strict") {
    const ok = englishPolicy().membership === "english"
      ? row.english_ready
      : (row.workflow_ready && row.english_copy_ready && row.english_source_revision === row.revision);
    if (!ok) return null;
  }
  const en = lang === "en";
  const englishFresh = en && row.english_source_revision === row.revision;
  const title = englishFresh && row.title_en?.trim() ? row.title_en : row.title;
  const sourceName = sourceNameFor(lang, row.source_name, row.source_name_en, row.url);
  const summary = englishFresh && row.summary_en?.trim() ? row.summary_en : row.summary;
  const reason = en ? (row.selected && englishFresh ? row.reason_en : null) : (row.selected ? row.reason : null);
  const lines: string[] = [];
  lines.push(`# ${title}`, "");
  if (row.original_title) lines.push(`> ${en ? "Original title" : "原标题"}：${row.original_title}`, "");
  lines.push(`- ${en ? "Source" : "来源"}：${sourceName}`);
  lines.push(`- ${en ? "Published" : "发布时间"}：${(row.published_at ?? row.discovered_at).toISOString()}`);
  lines.push(`- ${SITE.name}：${itemUrl(row.id)}`);
  lines.push(`- ${en ? "Original" : "原文"}：${row.url}`, "");
  if (summary) lines.push(en ? "## Summary" : "## 摘要", "", summary, "");
  if (reason) lines.push(en ? "## Why it matters" : "## 推荐理由", "", reason, "");
  if (row.channel === "x" && row.x_post?.text) {
    lines.push(en ? "## Post" : "## 正文", "", String(row.x_post.text), "");
    if (!en && row.zh_text) lines.push("## 中文译文", "", row.zh_text, "");
    const q = row.x_post.quoted as { handle?: string; text?: string; url?: string } | null | undefined;
    if (q?.text) lines.push(`## ${en ? "Quoted" : "引用"} @${q.handle ?? ""}`, "", ...String(q.text).split("\n").map((l) => `> ${l}`), "", ...(q.url ? [q.url, ""] : []));
    // 引用译文也要出现在导出里：/en 读 quote_translations_en，只有 fallback 模式才回退中文；中文页照旧只读中文译文。
    const quotedTranslation = en
      ? (row.quoted_en?.trim() ? row.quoted_en : (englishTextMode() === "fallback" ? row.quoted_zh : null))
      : row.quoted_zh;
    // 中文译文在 fallback 模式下也会进英文导出，但标题必须说清楚它是中文，不能只写 “Quoted translation”。
    const quotedTranslationIsZh = en && !row.quoted_en?.trim();
    if (!en && q?.text && row.quoted_zh) lines.push("### 引用中文译文", "", ...row.quoted_zh.split("\n").map((l) => `> ${l}`), "");
    else if (en && q?.text && quotedTranslation && quotedTranslation.trim() !== String(q.text).trim()) {
      lines.push(`### ${quotedTranslationIsZh ? "Quoted translation (Chinese)" : "Quoted translation"}`, "", ...quotedTranslation.split("\n").map((l) => `> ${l}`), "");
    }
  } else if (row.body_mode === "full" && (row.body_html || row.body_text)) {
    // The same question the page asks (`loadRow`'s reading projection above), spelled once
    // (`contracts/copy.ts`): a declared language wins over a sample, and a declared `en` is an English
    // body even when the article quotes a Chinese line.
    const isZh = bodyIsChinese(row.language, row.body_text ?? "");
    if (en) {
      const enHtml = row.en_body_complete === true ? (row.en_body_html || (row.en_body_text ? textToHtml(row.en_body_text) : "")) : "";
      if (enHtml) lines.push("## Body · English translation", "", turndown.turndown(enHtml), "");
      else if (!isZh) lines.push("## Body", "", turndown.turndown(row.body_html || textToHtml(row.body_text!)), "");
      else return null; // 英文导出没有英文正文就不冒充英文全文
    } else {
      if (!isZh && row.tr_html && row.tr_complete) lines.push("## 正文 · 中文译文", "", turndown.turndown(row.tr_html), "");
      lines.push(isZh ? "## 正文" : "## 正文 · 原文", "", turndown.turndown(row.body_html || textToHtml(row.body_text!)), "");
    }
  }
  // The download carries the site's own identity, not the framework's (upstream a75140b): `aihot-…md`
  // in a reader's Downloads folder is the upstream name, which this deployment must not use.
  return { filename: `${SITE.mcpPrefix}-${row.id}${en ? "-en" : ""}.md`, body: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}

/** Site reading projection: default text remains SSR, a second language has its own readable URL. */
export function siteItemDetail(detail: ItemDetail, original = false, lang: SiteLang = "zh"): SiteItemDetail {
  if (lang === "en") {
    const englishOriginal = detail.language === "en" || (!!detail.body?.original && !hasChineseCopy(detail.body.original));
    // strict：英文正文没写好时不拿中文正文冒充英文全文，退成「英文标题/摘要 + 原文链接」的
    // summary-licence 页（有英文 title/summary，读者仍有可读内容）。fallback 模式保持中文回退。
    if (englishTextMode() === "strict" && detail.body && !detail.body.en && !englishOriginal) {
      const { text: _text, translation: _translation, ...x } = detail.x ?? {} as NonNullable<ItemDetail["x"]>;
      return {
        ...detail,
        lang,
        x: detail.x ? x : null,
        readingMode: "summary-licence",
        hasTranslation: false,
        bodyLanguage: "zh",
        body: null,
        outline: [],
        markdownAvailable: false,
      };
    }
    // /en：英文译文优先；源文本身是英文时 `body.original` 就是英文；两者都没有才回退中文。
    const bodyLanguage: SiteItemDetail["bodyLanguage"] = original && detail.body?.original
      ? "original"
      : detail.body?.en
        ? "en"
        : englishOriginal && detail.body?.original
          ? "original"
          : detail.body?.zh
            ? "zh"
            : "original";
    const selectedHtml = bodyLanguage === "en" ? detail.body?.en : bodyLanguage === "zh" ? detail.body?.zh : detail.body?.original;
    const { text: _text, translation: _translation, ...x } = detail.x ?? {} as NonNullable<ItemDetail["x"]>;
    const textLocale = bodyLanguage === "zh" && detail.textLocale === "en" ? "mixed" : detail.textLocale;
    return { ...detail, lang, x: detail.x ? x : null, hasTranslation: bodyLanguage === "en", bodyLanguage, textLocale,
      body: detail.body ? {
        ...detail.body,
        en: bodyLanguage === "en" ? detail.body.en : null,
        zh: bodyLanguage === "zh" ? detail.body.zh : null,
        original: bodyLanguage === "original" ? detail.body.original : null,
      } : null,
      outline: selectedHtml ? withOutline(selectedHtml).outline : [],
    };
  }
  const hasTranslation = !!detail.body?.zh && detail.body.zhKind === "translation" && !!detail.body.original;
  const bodyLanguage = original && detail.body?.original ? "original" : detail.body?.zh ? "zh" : "original";
  const selectedHtml = bodyLanguage === "zh" ? detail.body?.zh : detail.body?.original;
  const { text: _text, translation: _translation, ...x } = detail.x ?? {} as NonNullable<ItemDetail["x"]>;
  return { ...detail, lang, x: detail.x ? x : null, hasTranslation, bodyLanguage,
    body: detail.body ? { ...detail.body, en: null, zh: bodyLanguage === "zh" ? detail.body.zh : null, original: bodyLanguage === "original" ? detail.body.original : null } : null,
    outline: selectedHtml ? withOutline(selectedHtml).outline : [],
  };
}
