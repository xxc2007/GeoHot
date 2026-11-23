// English content layer (migrations 0128/0129): reader-facing English copy written by the worker, never
// by a page read.
//
// Rules this file carries, none of them style:
//  - **one bounded paid call or one bounded batch per function.** Long bodies are translated in a batch of
//    whole blocks; the rest is left for the next sweep. Nothing here loops over a whole backfill.
//  - **CAS at the write.** The source revision is read before the call and compared under `FOR UPDATE`
//    at write time (`publications.revision`, `articles.revision`, `stories.version`, `reports.revision`,
//    the `(id, title)` snapshot of each fact, the quoted post's `text_hash`). A row that changed while the
//    model was answering is `stale`, nothing is written, and the sweep picks it up again. Without this, a
//    Chinese re-publish during an 80k-row backfill would stamp English as "current" for text it never saw.
//  - **`english_source_revision`/`english_source_version`/`revision_en` are the only freshness claims.**
//    English writes never touch `revision`/`version`/`eligible`/`selected`/`visible_after`/`indexable` and
//    never call `publishArticleTx`. Bumping `publications.revision` would detach the row from
//    `article_workflow_readiness.revision` (publication/readiness.ts) and drop it from every Chinese list.
//  - **failure is local.** A failed English answer writes only `english_attempts`; the Chinese columns and
//    the Chinese body are untouched, and the missing English field stays NULL so the read layer can fall
//    back to Chinese and can tell "no English yet" from "English was written".
//  - **receipts and budgets are the existing ones.** Every call goes through `chatJson` → `paidRequest`, with
//    a purpose from the `english` capability (`models.ts`), so the per-service budget breaker applies.
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import postgres from "postgres";
import { z } from "zod";
import type { EnglishAttemptKind, EnglishAttemptOutcome, ReportCitationSnapshot, ReportEnglishContent } from "@aihot/contracts/english";
import { cjkCount, hasChineseCopy } from "@aihot/contracts/copy";
import { IDENTITY_CONTEXT_ALIASES, IDENTITY_LEXICON } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";
import { sanitizeBody, textToHtml } from "../content/sanitize.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { modelFor } from "./models.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError, completeReceipt, rejectReceivedResponse } from "../providers/receipts.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { machineRuleOf } from "./provenance.ts";
import { cleanArticleTextForLLM, matchEntityIds, publisherEntityId } from "./writing.ts";
import { shield, unshield } from "./translate.ts";
import { storyReports } from "../events/story-reports.ts";
import { sourceNameFor } from "../publication/source-name.ts";

/** 每次调用的提示词指纹：改一个字都要换版本，否则回执会复用旧措辞的答复。 */
export const ENGLISH_PROMPT_VERSION = promptVersion("write-english");
const BODY_PROMPT_VERSION = promptVersion("translate-body-en");
const FACT_TITLES_PROMPT_VERSION = promptVersion("translate-fact-titles-en");
const POST_PROMPT_VERSION = promptVersion("translate-post-en");
const STORY_PROMPT_VERSION = promptVersion("story-digest-en");
const DAILY_PROMPT_VERSION = promptVersion("report-daily-lead-en");
const PERIOD_PROMPT_VERSION = promptVersion("report-period-en");

/** 英文腿的 worker 并发：0 = 关（读者机默认），1 = 独立回填节点/夜间窗口。上限 1 是 240MB worker 的硬顶。 */
export function englishConcurrency(raw: string | undefined = process.env.ENGLISH_CONCURRENCY): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n >= 1 ? Math.min(1, Math.floor(n)) : 0;
}

/**
 * 英文正文一次的批次上限：块数与字符数都设上界，超出部分留给 sweep 的下一轮。
 * 字符上限才是 token 与 180 秒超时的预算；块数只是编排上限——短段落的长文过去被 8 块卡住，
 * 一轮只译几百到两千多字，60k 字的正文要排二十多轮。短块不增加字符量，所以提到 16 块不改内存与预算。
 */
const BODY_BATCH_BLOCKS = 16;
const BODY_BATCH_CHARS = 6_000;
const BODY_TEXT_LIMIT = 60_000;
const FACT_TITLE_BATCH = 60;
const REPORT_ENTRY_LIMIT = 40;

const BODY_BLOCK_TAGS = new Set(["p", "h2", "h3", "h4", "h5", "li", "blockquote", "figcaption", "td", "th", "dt", "dd", "caption"]);
const BODY_CONTAINER = /^(p|h[2-5]|li|blockquote|figcaption|td|th|dt|dd|caption|ul|ol|table|pre|figure|div)$/;

// ── Answer shapes ───────────────────────────────────────────────────────────────────────────────

const ArticleSchema = z.object({
  title: z.string().max(600).catch(""),
  summary: z.string().max(8000).catch(""),
  reason: z.string().max(2000).catch(""),
});
type ArticleAnswer = z.infer<typeof ArticleSchema>;

const BlocksSchema = z.object({ blocks: z.array(z.string().max(20_000)).max(40) });
type BlocksAnswer = z.infer<typeof BlocksSchema>;

const PostSchema = z.object({ text: z.string().max(8000).catch("") });
type PostAnswer = z.infer<typeof PostSchema>;

const FactTitlesSchema = z.object({
  titles: z
    .array(z.object({ id: z.union([z.string(), z.number()]).transform(String), title: z.string().max(400) }))
    .max(120),
});
type FactTitlesAnswer = z.infer<typeof FactTitlesSchema>;

const StorySchema = z.object({
  title: z.string().max(600).catch(""),
  digest: z.string().max(8000).catch(""),
  latest: z.string().max(1200).catch(""),
});
type StoryAnswer = z.infer<typeof StorySchema>;

const DailySchema = z.object({
  title: z.string().max(600).catch(""),
  leadParagraph: z.string().max(4000).catch(""),
  sections: z
    .array(z.object({ label: z.string().max(200), summary: z.string().max(2000) }))
    .max(12)
    .catch([]),
});
const PeriodSchema = z.object({
  headline: z.string().max(600).catch(""),
  overview: z.string().max(8000).catch(""),
  themes: z
    .array(z.object({ heading: z.string().max(200), summary: z.string().max(4000) }))
    .max(12)
    .catch([]),
});

export interface EnglishWriteResult {
  outcome: EnglishAttemptOutcome;
  reason?: string;
  receiptId?: number;
}

// ── Text helpers ────────────────────────────────────────────────────────────────────────────────

const cpLen = (s: string) => Array.from(s).length;
const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** A line that is only a field label (`title:`) is an answer shape, not copy. */
const LABEL_ONLY = /^(?:title|summary|reason|headline|overview|digest|latest|lead|sections|themes|text|blocks|titles)\s*[:：]\s*$/i;

/**
 * Han characters and Latin/digit words in one block. The two are kept apart because they are not the
 * same unit: a Han character carries roughly two to three times the information of an English word, so
 * "one Han character = one word" (the old {@link englishWordCount}) made a faithful Chinese→English
 * translation look like a half answer (a 339-character block has ~110 English words, a ratio of 0.32).
 */
function wordBreakdown(text: string): { han: number; latin: number } {
  const plain = stripTags(text).replace(/⟦\d+⟧/g, " ").replace(/⟦G\d+⟧/g, " ");
  const han = cjkCount(plain);
  const latin = plain.match(/[A-Za-zÀ-ÖØ-öø-ſĀ-ž0-9]+(?:['’-][A-Za-zÀ-ÖØ-öø-ſĀ-ž0-9]+)*/g)?.length ?? 0;
  return { han, latin };
}

/** How many words a block is, for mixed Chinese/English sources: one Han character counts as one word. */
export function englishWordCount(text: string): number {
  const { han, latin } = wordBreakdown(text);
  return han + latin;
}

/** Ends on a real sentence boundary. Headings and fact titles are allowed to be fragments. */
export function endsEnglishSentence(text: string): boolean {
  return /[.!?…]["')\]]?$/u.test(text.trim());
}

/**
 * The structural copy gate: 1–120 title, 40–1200 summary, ≤400 reason, no CJK, not a label-only line,
 * and summary/reason end on a sentence. One test, asked in two places — `chatJson` refuses the receipt so
 * the same unusable answer is not replayed for free, and the writer refuses to store it.
 */
export function englishCopyUsable(copy: { title: string; summary: string; reason: string }): string | null {
  const title = copy.title?.trim() ?? "";
  const summary = copy.summary?.trim() ?? "";
  const reason = copy.reason?.trim() ?? "";
  if (!title) return "title is empty";
  if (cpLen(title) > 120) return `title is ${cpLen(title)} chars (max 120)`;
  if (LABEL_ONLY.test(title) || hasChineseCopy(title)) return "title is a label or not English";
  if (!summary) return "summary is empty";
  if (cpLen(summary) < 40 || cpLen(summary) > 1200) return `summary is ${cpLen(summary)} chars (40-1200)`;
  if (LABEL_ONLY.test(summary) || hasChineseCopy(summary)) return "summary is a label or not English";
  if (!endsEnglishSentence(summary)) return "summary does not end on a sentence";
  if (reason) {
    if (cpLen(reason) > 400) return `reason is ${cpLen(reason)} chars (max 400)`;
    if (LABEL_ONLY.test(reason) || hasChineseCopy(reason)) return "reason is a label or not English";
    if (!endsEnglishSentence(reason)) return "reason does not end on a sentence";
  }
  return null;
}

/** A prose field of any English shape (digest, lead, overview, theme summary). */
function englishProseUsable(text: string, min: number, max: number): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (cpLen(t) < min || cpLen(t) > max) return `${cpLen(t)} chars (${min}-${max})`;
  if (LABEL_ONLY.test(t) || hasChineseCopy(t)) return "a label or not English";
  if (!endsEnglishSentence(t)) return "does not end on a sentence";
  return null;
}

/** A short English line (title / fact title / heading): no CJK, no label, length bounded. */
function englishLineUsable(text: string, min: number, max: number): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (cpLen(t) < min || cpLen(t) > max) return `${cpLen(t)} chars (${min}-${max})`;
  if (LABEL_ONLY.test(t) || hasChineseCopy(t)) return "a label or not English";
  if (/[,;:，、；：]$/u.test(t)) return "ends on a clause separator";
  return null;
}

/**
 * 一块译文里允许留下的汉字原字：默认零容忍。只有已经成篇的正文段落（≥40 个英文词）才容得下至多两个
 * 原字，给确无通行罗马化的专名；短块（标题、表头、图注、单元格）一个都不许——那里最容易让一整句
 * 未译的中文混过去。整段未译的正文会先被下方的词数比例挡下。
 *
 * **与 `industry/prompts/translate-body-en.md` 的地名条款同一口径**：改这里就改那一行，否则模型会
 * 按一套写、闸门按另一套拒，长文永远到不了 complete（2026-11-23 审查）。
 */
const RESIDUAL_HAN_MAX = 2;
const RESIDUAL_HAN_MIN_LATIN = 40;

function residualHanOk(outputHtml: string): boolean {
  const han = cjkCount(stripTags(outputHtml));
  if (han === 0) return true;
  if (han > RESIDUAL_HAN_MAX) return false;
  return wordBreakdown(outputHtml).latin >= RESIDUAL_HAN_MIN_LATIN;
}

/**
 * Body-block guard. The source's main language picks the ruler:
 *  · Chinese source: English words against Han characters in 0.18–1.6. A faithful translation runs
 *    around 0.3 (100 Han characters ≈ 30–40 English words); a half answer (one sentence of three)
 *    falls under 0.18 and is still refused.
 *  · Latin source: words against words in 0.6–1.8, as before.
 * Whichever ruler, a short block must be wholly English and a long one may keep at most two original
 * characters ({@link residualHanOk}); a long enough block has to end on a sentence. (The old single
 * 0.6–1.8 scale counted Han characters as words and therefore refused every complete Chinese→English
 * block — the English backfill could never store a body.)
 */
export function englishBodyRatioOk(sourceHtml: string, outputHtml: string): boolean {
  if (!residualHanOk(outputHtml)) return false;
  const source = wordBreakdown(sourceHtml);
  const output = wordBreakdown(outputHtml);
  const outputWords = output.han + output.latin;
  if (source.han >= 40 && source.han >= source.latin * 2) {
    const ratio = output.latin / source.han;
    if (!(ratio >= 0.18 && ratio <= 1.6)) return false;
  } else if (source.han + source.latin >= 40) {
    const ratio = outputWords / (source.han + source.latin);
    if (!(ratio >= 0.6 && ratio <= 1.8)) return false;
  }
  if (outputWords >= 40 && !endsEnglishSentence(stripTags(outputHtml))) return false;
  return true;
}

/** 收在一句完整的话上：能收到前一句就收，否则补一个句号。没有中文的那套分句规则。 */
export function closeEnglishSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (endsEnglishSentence(t)) return t;
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"));
  if (last >= 40) return t.slice(0, last + 1);
  return `${t}.`;
}

// ── Per-shape usability ─────────────────────────────────────────────────────────────────────────
// `chatJson` marks the receipt `failed` for an unusable answer but still returns it to the caller
// (providers/llm.ts), so every writer must ask the same question again before storing anything.
// The `usable` closures passed to `chatJson` are exactly these functions — one definition, two uses.

function blocksUsable(data: BlocksAnswer, expected: number): string | null {
  if (data.blocks.length !== expected) return `answered ${data.blocks.length} of ${expected} blocks`;
  for (const block of data.blocks) {
    const text = stripTags(block).trim();
    if (!text) return "an empty block";
    if (!residualHanOk(block)) return "a block is not English";
  }
  return null;
}

function postUsable(data: PostAnswer): string | null {
  const text = data.text.trim();
  if (!text) return "empty translation";
  if (hasChineseCopy(text)) return "not English";
  // 帖子常以链接、话题标签或表情收尾，不强求句末标点；正文与摘要才守那一条。
  return null;
}

function storyUsable(data: StoryAnswer): string | null {
  return englishLineUsable(data.title, 1, 120)
    ?? englishProseUsable(data.digest, 60, 2000)
    ?? (data.latest.trim() ? englishProseUsable(data.latest, 1, 300) : null);
}

function factTitlesUsable(data: FactTitlesAnswer, ids: Set<string>): string | null {
  const seen = new Set<string>();
  for (const item of data.titles) {
    if (!ids.has(item.id)) return `unknown fact id ${item.id}`;
    if (seen.has(item.id)) return `duplicate fact id ${item.id}`;
    seen.add(item.id);
    const problem = englishLineUsable(item.title, 1, 110);
    if (problem) return `fact ${item.id}: ${problem}`;
  }
  if (seen.size !== ids.size) return `answered ${seen.size} of ${ids.size} facts`;
  return null;
}

function dailyUsable(data: z.infer<typeof DailySchema>, sectionCount: number): string | null {
  const title = englishLineUsable(data.title, 1, 120);
  if (title) return `title: ${title}`;
  const lead = englishProseUsable(data.leadParagraph, 40, 600);
  if (lead) return `leadParagraph: ${lead}`;
  if (data.sections.length !== sectionCount) return `sections: ${data.sections.length} of ${sectionCount}`;
  for (const section of data.sections) {
    const label = englishLineUsable(section.label, 1, 60);
    if (label) return `section label: ${label}`;
    if (section.summary.trim() && englishProseUsable(section.summary, 1, 300)) return "section summary is not usable English";
  }
  return null;
}

function periodUsable(data: z.infer<typeof PeriodSchema>, themeCount: number): string | null {
  const headline = englishLineUsable(data.headline, 1, 60);
  if (headline) return `headline: ${headline}`;
  const overview = englishProseUsable(data.overview, 200, 2400);
  if (overview) return `overview: ${overview}`;
  if (data.themes.length !== themeCount) return `themes: ${data.themes.length} of ${themeCount}`;
  for (const theme of data.themes) {
    const heading = englishLineUsable(theme.heading, 1, 60);
    if (heading) return `theme heading: ${heading}`;
    const summary = englishProseUsable(theme.summary, 1, 800);
    if (summary) return `theme summary: ${summary}`;
  }
  return null;
}

// ── Identity guard, English side ────────────────────────────────────────────────────────────────

export interface EnglishEvidence {
  title: string;
  text: string;
  sourceName?: string;
  documentUrl?: string;
  sourceOwnerEntityId?: string | null;
}

export interface EnglishIdentityGuard {
  outcome: "pass" | "fallback";
  unsupportedTitleEntityIds: string[];
  unsupportedSummaryEntityIds: string[];
  unsupportedReasonEntityIds: string[];
}

/**
 * Known entities the evidence names, by the pack's identity lexicon. Both sides of the comparison go
 * through `matchEntityIds`, so a name that matches on one side matches on the other — and an English
 * spelling added to `IDENTITY_LEXICON` maps to the same id as the Chinese one. Publisher and owner are
 * added the same way `writing.ts` does for the Chinese guard.
 */
function englishAllowedEntityIds(evidence: EnglishEvidence): Set<string> {
  const texts = [evidence.title, evidence.text, evidence.sourceName].filter(isText);
  const forms = texts.flatMap((t) => {
    const folded = t.normalize("NFKC").replace(/\s+/g, "");
    return folded === t ? [t] : [t, folded];
  });
  const allowed = new Set(matchEntityIds(forms));
  const joined = texts.join("\n");
  for (const alias of IDENTITY_CONTEXT_ALIASES) if (alias.pattern.test(joined)) allowed.add(alias.entityId);
  const publisher = publisherEntityId(evidence.documentUrl);
  if (publisher) allowed.add(publisher);
  if (evidence.sourceOwnerEntityId && IDENTITY_LEXICON.some((e) => e.id === evidence.sourceOwnerEntityId)) {
    allowed.add(evidence.sourceOwnerEntityId);
  }
  return allowed;
}

/**
 * The English copy may only name an entity the evidence names. A title that does is dropped (the read
 * layer keeps Chinese), a summary/reason that does is cleared. Nothing here trims or invents words.
 */
export function enforceEnglishIdentity(evidence: EnglishEvidence, copy: { title: string; summary: string; reason: string }) {
  const allowed = englishAllowedEntityIds(evidence);
  const unsupported = (text: string) => (text ? matchEntityIds([text]).filter((id) => !allowed.has(id)) : []);
  const titleIds = unsupported(copy.title);
  const summaryIds = unsupported(copy.summary);
  const reasonIds = unsupported(copy.reason);
  return {
    title: titleIds.length ? "" : copy.title,
    summary: summaryIds.length ? "" : copy.summary,
    reason: reasonIds.length ? "" : copy.reason,
    identityGuard: {
      outcome: titleIds.length || summaryIds.length || reasonIds.length ? "fallback" : "pass",
      unsupportedTitleEntityIds: titleIds,
      unsupportedSummaryEntityIds: summaryIds,
      unsupportedReasonEntityIds: reasonIds,
    } as EnglishIdentityGuard,
  };
}

/**
 * Trim, close the sentences and run the identity guard. Length/文字 gates already ran in `usable` (the
 * receipt is refused there), so this only *keeps* what is safe to publish; it never pads a missing field.
 */
export function finalizeEnglishCopy(
  copy: ArticleAnswer,
  evidence: EnglishEvidence,
): { title: string; summary: string; reason: string; identityGuard: EnglishIdentityGuard } {
  const title = copy.title.trim().replace(/\s*\n+\s*/g, " ");
  const summary = closeEnglishSentence(copy.summary.trim().replace(/\s*\n+\s*/g, " "));
  const reason = copy.reason.trim().replace(/\s*\n+\s*/g, " ");
  return enforceEnglishIdentity(evidence, { title, summary, reason });
}

// ── Attempt accounting (migration 0129) ─────────────────────────────────────────────────────────

/** 派生的事实集版本：`f<条数>:<最大 id>`。facts 没有可用的版本列，sweep 与写回要用同一个公式。 */
export function factsRevisionOf(count: number, maxId: string | number | null): string {
  return `f${count}:${maxId ?? 0}`;
}

async function recordEnglishAttempt(
  kind: EnglishAttemptKind,
  subject: string,
  sourceRevision: string,
  outcome: EnglishAttemptOutcome,
  reason: string,
  countAttempt = false,
  db = sql,
): Promise<void> {
  await db`
    INSERT INTO english_attempts (kind, subject, source_revision, attempts, outcome, reason, updated_at)
    VALUES (${kind}, ${subject}, ${sourceRevision}, ${outcome === "failed" || countAttempt ? 1 : 0}, ${outcome}, ${reason.slice(0, 300)}, now())
    ON CONFLICT (kind, subject, source_revision) DO UPDATE SET
      attempts = english_attempts.attempts + CASE WHEN EXCLUDED.outcome = 'failed' OR ${countAttempt} THEN 1 ELSE 0 END,
      outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, updated_at = now()`;
}

/** Infrastructure failures stop this attempt and are retried by pg-boss; they are not content failures. */
function infrastructureFailure(error: unknown): boolean {
  if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError || error instanceof ReceiptUnknownError) return true;
  if (error instanceof postgres.PostgresError) return true;
  if (!error || typeof error !== "object") return false;
  if (Object.hasOwn(error, "query") && Object.hasOwn(error, "parameters")) return true;
  return ["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"].includes((error as { code?: string }).code ?? "");
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 300);

/** Failed content attempts do not throw: the sweep retries a bounded number of times. */
async function failedAttempt(kind: EnglishAttemptKind, subject: string, revision: string, error: unknown): Promise<EnglishWriteResult> {
  const reason = errorText(error);
  await recordEnglishAttempt(kind, subject, revision, "failed", reason);
  return { outcome: "failed", reason };
}

// ── Article copy ────────────────────────────────────────────────────────────────────────────────

interface ArticleRow {
  revision: number;
  visibility: string;
  body_mode: string;
  title: string | null;
  summary: string | null;
  reason: string | null;
  english_source_revision: number | null;
  title_en: string | null;
  summary_en: string | null;
  article_title: string;
  original_title: string | null;
  language: string | null;
  body_text: string | null;
  url: string;
  source_name: string;
  source_owner_entity_id: string | null;
  analysis_title_zh: string | null;
  analysis_summary_zh: string | null;
  analysis_reason_zh: string | null;
}

/** The exact request `writeArticleEnglish` sends; exported so the brain probe can replay it. */
export function buildEnglishArticleUser(row: ArticleRow): string {
  const body = row.body_text ? cleanArticleTextForLLM(row.body_text) : "";
  const clipped = body.length > BODY_TEXT_LIMIT ? `${body.slice(0, BODY_TEXT_LIMIT)}…` : body;
  return [
    `Source language: ${row.language ?? "unknown"}`,
    `Source publisher: ${row.source_name}`,
    `Published title (Chinese edition): ${row.title ?? ""}`,
    `Published summary (Chinese edition): ${row.summary ?? ""}`,
    `Editor's reason (Chinese edition): ${row.reason || "(none)"}`,
    "",
    `Original title: ${row.original_title || row.article_title}`,
    "Original body (truncated):",
    clipped || "(no body; this item carries a title and a summary only)",
  ].join("\n");
}

function articleEvidence(row: ArticleRow): EnglishEvidence {
  return {
    title: [row.article_title, row.original_title, row.title ?? "", row.analysis_title_zh ?? ""].filter(isText).join("\n"),
    text: [
      row.summary ?? "",
      row.reason ?? "",
      row.analysis_summary_zh ?? "",
      row.analysis_reason_zh ?? "",
      row.body_text ? cleanArticleTextForLLM(row.body_text).slice(0, BODY_TEXT_LIMIT) : "",
    ].filter(isText).join("\n"),
    sourceName: row.source_name,
    documentUrl: row.url,
    sourceOwnerEntityId: row.source_owner_entity_id,
  };
}

const SYSTEM_ARTICLE = promptText("write-english");

/**
 * The item's English title/summary/reason + `search_text_en`. One paid call, one CAS write. Content is
 * written from the original title/body for English sources and from the Chinese copy for Chinese sources;
 * the prompt states both, and every number must come from the material.
 */
export async function writeArticleEnglish(articleId: string): Promise<EnglishWriteResult> {
  const [row] = await sql<ArticleRow[]>`
    SELECT p.revision, p.visibility, p.body_mode, p.title, p.summary, p.reason, p.english_source_revision, p.title_en, p.summary_en,
           a.title AS article_title, p.original_title, a.language, a.body_text, a.url,
           s.name AS source_name, s.owner_entity_id AS source_owner_entity_id,
           latest.title_zh AS analysis_title_zh, latest.summary_zh AS analysis_summary_zh, latest.reason_zh AS analysis_reason_zh
      FROM publications p
      JOIN articles a ON a.id = p.article_id
      JOIN sources s ON s.id = p.source_id
      LEFT JOIN LATERAL (
        SELECT title_zh, summary_zh, reason_zh FROM analyses WHERE article_id = p.article_id ORDER BY id DESC LIMIT 1
      ) latest ON true
     WHERE p.article_id = ${articleId}`;
  if (!row) {
    await recordEnglishAttempt("copy", articleId, "0", "skipped", "not-published");
    return { outcome: "skipped", reason: "not-published" };
  }
  const revision = String(row.revision);
  if (row.visibility !== "public") {
    await recordEnglishAttempt("copy", articleId, revision, "skipped", "not-public");
    return { outcome: "skipped", reason: "not-public" };
  }
  if (!row.title?.trim() || !row.summary?.trim()) {
    await recordEnglishAttempt("copy", articleId, revision, "skipped", "missing-chinese-copy");
    return { outcome: "skipped", reason: "missing-chinese-copy" };
  }
  if (row.english_source_revision === row.revision && row.title_en?.trim() && row.summary_en?.trim()) {
    await recordEnglishAttempt("copy", articleId, revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }

  const evidence = articleEvidence(row);
  let answer: ArticleAnswer;
  let receiptId: number;
  let rule: string | null;
  try {
    const model = await modelFor("english", articleId, "write_english");
    const res = await chatJson({
      model,
      purpose: "write_english",
      subject: `article:${articleId}`,
      promptVersion: ENGLISH_PROMPT_VERSION,
      system: SYSTEM_ARTICLE,
      user: buildEnglishArticleUser(row),
      schema: ArticleSchema,
      temperature: 0.2,
      maxTokens: 1600,
      timeoutMs: 180_000,
      usable: englishCopyUsable,
    });
    answer = res.data;
    receiptId = res.receiptId;
    rule = machineRuleOf(res.usage);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("copy", articleId, revision, error);
  }
  if (rule) {
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("copy", articleId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const problem = englishCopyUsable(answer);
  if (problem) {
    await recordEnglishAttempt("copy", articleId, revision, "failed", problem);
    return { outcome: "failed", reason: problem };
  }

  const finalized = finalizeEnglishCopy(answer, evidence);
  if (!finalized.title || !finalized.summary) {
    const ids = [
      ...finalized.identityGuard.unsupportedTitleEntityIds,
      ...finalized.identityGuard.unsupportedSummaryEntityIds,
      ...finalized.identityGuard.unsupportedReasonEntityIds,
    ];
    const reason = ids.length ? `identity:${[...new Set(ids)].join(",")}` : "unusable-copy";
    // 形状过了 `usable`、却被身份守卫或补句丢掉的答复不能留在回执里当"已收款"：
    // 下一次会原样复用同一份坏答案，英文永远写不出来（2026-11-23 验收里正文重试 3 次全是同一份）。
    await rejectReceivedResponse(receiptId, `english copy refused: ${reason}`);
    await recordEnglishAttempt("copy", articleId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const searchText = collapseWhitespace([finalized.title, finalized.summary, finalized.reason, row.source_name].filter(Boolean).join(" ")).toLowerCase();

  const written = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM publications WHERE article_id = ${articleId} FOR UPDATE`;
    if (!current || current.revision !== row.revision) return "stale" as const;
    await tx`
      UPDATE publications
         SET title_en = ${finalized.title}, summary_en = ${finalized.summary},
             reason_en = ${finalized.reason || null}, search_text_en = ${searchText},
             english_source_revision = ${row.revision}, english_at = now()
       WHERE article_id = ${articleId}`;
    await completeReceipt(tx, receiptId);
    return "written" as const;
  });
  await recordEnglishAttempt("copy", articleId, revision, written, written === "written" ? "stored" : "publication-revision-changed");
  if (written !== "written") await rejectReceivedResponse(receiptId, "publication revision changed before the English copy was stored");
  return written === "written" ? { outcome: "written", receiptId } : { outcome: "stale", reason: "publication-revision-changed" };
}

// ── Article body ────────────────────────────────────────────────────────────────────────────────

function textBlocksOf($: cheerio.CheerioAPI): Element[] {
  const out: Element[] = [];
  const visit = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.name === "pre" || el.name === "code") continue;
      const hasBlockChild = el.children.some((c) => c.type === "tag" && BODY_CONTAINER.test((c as Element).name));
      if (BODY_BLOCK_TAGS.has(el.name) && !hasBlockChild) {
        const text = $(el).text();
        if (/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ]/.test(text) || hasChineseCopy(text)) out.push(el);
        continue;
      }
      visit(el.children);
    }
  };
  visit($.root().children().toArray());
  return out;
}

interface BodyRow {
  revision: number;
  language: string | null;
  body_html: string | null;
  body_text: string | null;
  x_post: { text?: string } | null;
  title: string;
  title_en: string | null;
  visibility: string;
  body_mode: string;
  channel: string;
}

/**
 * `translations.lang='en'` for the current article revision, written block by block. One bounded batch per
 * call; a body that does not finish is stored incomplete and the sweep asks again. Deliberately does not
 * call `publishArticleTx` or `refreshWorkflowReadinessTx`: the trigger in `0092` ignores non-zh rows, and a
 * readiness recompute per article would rewrite `articles FOR UPDATE` on a machine that cannot afford it.
 */
export async function translateArticleBodyEn(articleId: string): Promise<EnglishWriteResult> {
  const [row] = await sql<BodyRow[]>`
    SELECT a.revision, a.language, a.body_html, a.body_text, a.x_post, a.title, p.title_en, p.visibility, p.body_mode, p.channel
      FROM articles a JOIN publications p ON p.article_id = a.id
     WHERE a.id = ${articleId}`;
  if (!row) {
    await recordEnglishAttempt("body", articleId, "0", "skipped", "not-published");
    return { outcome: "skipped", reason: "not-published" };
  }
  const revision = String(row.revision);
  if (row.visibility !== "public" || row.body_mode !== "full") {
    await recordEnglishAttempt("body", articleId, revision, "skipped", "not-a-public-full-text-item");
    return { outcome: "skipped", reason: "not-a-public-full-text-item" };
  }
  const sourceText = row.channel === "x" ? String(row.x_post?.text ?? "") : (row.body_text ?? "");
  const sample = sourceText.slice(0, 400);
  // 源文已经是英文（或声明为 en）就没有可译的内容。`language='zh'` 明确要译：不能因为开头恰好是
  // ASCII（代码、英文摘要）就把一整个中文正文当成英文。
  if (row.language === "en" || (row.language !== "zh" && !hasChineseCopy(sample))) {
    await recordEnglishAttempt("body", articleId, revision, "skipped", "source-already-english");
    return { outcome: "skipped", reason: "source-already-english" };
  }
  const sourceHtml = row.channel === "x" ? textToHtml(sourceText) : (row.body_html || (row.body_text ? textToHtml(row.body_text) : ""));
  if (!sourceHtml.trim()) {
    await recordEnglishAttempt("body", articleId, revision, "skipped", "no-translatable-text");
    return { outcome: "skipped", reason: "no-translatable-text" };
  }

  const [existing] = await sql<{ revision: number; body_html: string | null }[]>`
    SELECT revision, body_html FROM translations WHERE article_id = ${articleId} AND lang = 'en'`;
  const reuse = !!existing && existing.revision === row.revision && !!existing.body_html;

  const $ = cheerio.load(sourceHtml, null, false);
  const blocks = textBlocksOf($);
  if (!blocks.length) {
    await recordEnglishAttempt("body", articleId, revision, "skipped", "no-translatable-block");
    return { outcome: "skipped", reason: "no-translatable-block" };
  }
  const prior = reuse ? cheerio.load(existing!.body_html!, null, false) : null;
  const priorBlocks = prior ? textBlocksOf(prior) : [];

  const missing: Array<{ index: number; html: string }> = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const own = $(blocks[i]!).html() ?? "";
    const previous = priorBlocks.length === blocks.length ? prior!(priorBlocks[i]!).text() : "";
    // 与写回闸同一口径：上一轮存下的块只要符合 `residualHanOk` 就算译完，否则每次都会被重新排进
    // `missing`，长文永远到不了 complete。
    if (previous.trim().length > 0 && residualHanOk(previous)) {
      $(blocks[i]!).html(prior!(priorBlocks[i]!).html() ?? "");
      continue;
    }
    missing.push({ index: i, html: own });
  }
  if (!missing.length) {
    await recordEnglishAttempt("body", articleId, revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }

  const batch: Array<{ index: number; html: string; shielded: ReturnType<typeof shield> }> = [];
  let chars = 0;
  for (const item of missing) {
    if (batch.length >= BODY_BATCH_BLOCKS) break;
    if (batch.length > 0 && chars + item.html.length > BODY_BATCH_CHARS) break;
    chars += item.html.length;
    batch.push({ ...item, shielded: shield(item.html) });
  }
  const batchTexts = batch.map((b) => b.shielded.html);

  let answer: BlocksAnswer;
  let receiptId: number;
  let rule: string | null;
  try {
    const model = await modelFor("english", articleId, "translate_body_en");
    const res = await chatJson({
      model,
      purpose: "translate_body_en",
      subject: `article:${articleId}`,
      promptVersion: BODY_PROMPT_VERSION,
      system: promptText("translate-body-en"),
      user: JSON.stringify({ blocks: batchTexts, target: "en" }),
      schema: BlocksSchema,
      temperature: 0.2,
      maxTokens: Math.min(12_000, Math.ceil(batchTexts.join("").length * 1.6) + 600),
      timeoutMs: 180_000,
      usable: (data) => blocksUsable(data, batchTexts.length),
    });
    answer = res.data;
    receiptId = res.receiptId;
    rule = machineRuleOf(res.usage);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("body", articleId, revision, error);
  }
  if (rule) {
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("body", articleId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  // 条数相等时才允许按位置写回：schema 里的 blocks 没有 id，少答/多答一块后 `answer.blocks[i]`
  // 就不再对应 `batch[i]`，相邻段落会被永久错位存进 translations，而比例闸只看长度、认不出错位。
  // 条数相等时，个别坏块（空块、残留汉字、比例不合）仍只丢自己，不连累同批能过闸的译文。
  const problem = blocksUsable(answer, batchTexts.length);
  if (answer.blocks.length !== batchTexts.length) {
    const reason = problem ?? `answered ${answer.blocks.length} of ${batchTexts.length} blocks`;
    await rejectReceivedResponse(receiptId, reason);
    await recordEnglishAttempt("body", articleId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }

  let translated = 0;
  answer.blocks.forEach((translatedHtml, i) => {
    const item = batch[i];
    if (!item) return; // 多答的块没有对应的原文
    const restored = unshield(translatedHtml, item.shielded);
    if (!restored || !englishBodyRatioOk(item.html, restored)) return;
    $(blocks[item.index]!).html(restored);
    translated += 1;
  });
  if (translated === 0) {
    // 回执必须一起拒：这道比例闸在 `chatJson` 之后，`usable` 只查形状，形状对了的坏答案会一直
    // 以 `received` 被复用，重试永远拿同一份短译（2026-11-23 验收的 "no block translated" 就是这个循环）。
    await rejectReceivedResponse(receiptId, "no body block passed the English translation guard");
    const reason = problem ? `no block translated: ${problem}` : "no block translated";
    await recordEnglishAttempt("body", articleId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }

  const html = sanitizeBody($.html());
  const text = cheerio.load(html, null, false).root().text().trim();
  const complete = translated === missing.length;
  const written = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!current || current.revision !== row.revision) return "stale" as const;
    await tx`
      INSERT INTO translations (article_id, lang, revision, title, body_html, body_text, complete, origin, receipt_id)
      VALUES (${articleId}, 'en', ${row.revision}, ${row.title_en ?? null}, ${html}, ${text}, ${complete}, 'model', ${receiptId})
      ON CONFLICT (article_id, lang) DO UPDATE SET
        revision = EXCLUDED.revision, title = EXCLUDED.title, body_html = EXCLUDED.body_html,
        body_text = EXCLUDED.body_text, complete = EXCLUDED.complete, origin = 'model',
        receipt_id = EXCLUDED.receipt_id, created_at = now()
      WHERE translations.revision <= EXCLUDED.revision`;
    if (complete) await completeReceipt(tx, receiptId);
    return complete ? "translated" as const : "partial" as const;
  });
  if (written === "stale") {
    // 旧 revision 的答复不能留着复用：下一次同名请求会读到它，却和新正文对不上。
    await rejectReceivedResponse(receiptId, "article revision changed before the English body was stored");
    await recordEnglishAttempt("body", articleId, revision, "stale", "article-revision-changed", true);
    return { outcome: "stale", reason: "article-revision-changed" };
  }
  const reason = complete
    ? "stored"
    : `partial: ${translated} of ${missing.length} blocks${problem ? ` (answer refused: ${problem})` : ""}`;
  if (!complete) await rejectReceivedResponse(receiptId, reason);
  // 分批没写完记 stale，不记 failed：failed 会消耗 attempts，长文（>3 批）永远到不了 complete。
  // 但每次部分成功也计一次 body 尝试（countAttempt=true），sweep 用 body 自己的上限停排——
  // 块结构对不上时 priorBlocks 会整篇重排，不计 attempts 就会每 10 分钟重复付费。
  await recordEnglishAttempt("body", articleId, revision, complete ? "translated" : "stale", reason, !complete);
  return { outcome: complete ? "translated" : "stale", reason, receiptId };
}

// ── Quoted post ─────────────────────────────────────────────────────────────────────────────────

interface QuoteRow {
  text: string;
  text_hash: string;
}

async function quoteSource(tweetId: string): Promise<QuoteRow | null> {
  const [row] = await sql<QuoteRow[]>`
    SELECT DISTINCT ON (q.tweet_id) a.x_post->'quoted'->>'text' AS text,
           encode(sha256(convert_to(a.x_post->'quoted'->>'text', 'UTF8')), 'hex') AS text_hash
      FROM publications p JOIN articles a ON a.id = p.article_id
      CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
     WHERE p.channel = 'x' AND p.visibility = 'public' AND q.tweet_id = ${tweetId}
       AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
     ORDER BY q.tweet_id, p.discovered_at DESC, p.article_id`;
  return row ?? null;
}

/** `quote_translations_en` for one quoted post, shared by every item that quotes it. */
export async function translateQuotedPostEn(tweetId: string): Promise<EnglishWriteResult> {
  const source = await quoteSource(tweetId);
  if (!source) {
    await recordEnglishAttempt("quote", tweetId, "0", "skipped", "no-quoted-post");
    return { outcome: "skipped", reason: "no-quoted-post" };
  }
  const revision = source.text_hash;
  if (!hasChineseCopy(source.text.slice(0, 400))) {
    await recordEnglishAttempt("quote", tweetId, revision, "skipped", "source-already-english");
    return { outcome: "skipped", reason: "source-already-english" };
  }
  const [existing] = await sql<{ text_hash: string }[]>`SELECT text_hash FROM quote_translations_en WHERE tweet_id = ${tweetId}`;
  if (existing?.text_hash === revision) {
    await recordEnglishAttempt("quote", tweetId, revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }

  let answer: PostAnswer;
  let receiptId: number;
  let rule: string | null;
  try {
    const model = await modelFor("english", tweetId, "translate_post_en");
    const res = await chatJson({
      model,
      purpose: "translate_post_en",
      subject: `quote:${tweetId}`,
      promptVersion: POST_PROMPT_VERSION,
      system: promptText("translate-post-en"),
      user: JSON.stringify({ post: source.text, target: "en" }),
      schema: PostSchema,
      temperature: 0.2,
      maxTokens: Math.min(4000, Math.ceil(source.text.length * 2) + 200),
      timeoutMs: 120_000,
      usable: postUsable,
    });
    answer = res.data;
    receiptId = res.receiptId;
    rule = machineRuleOf(res.usage);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("quote", tweetId, revision, error);
  }
  if (rule) {
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("quote", tweetId, revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const problem = postUsable(answer);
  if (problem) {
    await recordEnglishAttempt("quote", tweetId, revision, "failed", problem);
    return { outcome: "failed", reason: problem };
  }

  const text = answer.text.trim();
  const written = await sql.begin(async (tx) => {
    const [current] = await tx<{ text: string }[]>`
      SELECT DISTINCT ON (q.tweet_id) a.x_post->'quoted'->>'text' AS text
        FROM publications p JOIN articles a ON a.id = p.article_id
        CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
       WHERE p.channel = 'x' AND p.visibility = 'public' AND q.tweet_id = ${tweetId}
         AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
       ORDER BY q.tweet_id, p.discovered_at DESC, p.article_id LIMIT 1`;
    if (!current || sha256(current.text) !== revision) return "stale" as const;
    await tx`
      INSERT INTO quote_translations_en (tweet_id, text_hash, text_en, origin)
      VALUES (${tweetId}, ${revision}, ${text}, 'model')
      ON CONFLICT (tweet_id) DO UPDATE SET
        text_hash = EXCLUDED.text_hash, text_en = EXCLUDED.text_en, origin = 'model', created_at = now()`;
    await completeReceipt(tx, receiptId);
    return "translated" as const;
  });
  await recordEnglishAttempt("quote", tweetId, revision, written, written === "translated" ? "stored" : "text-hash-changed");
  return written === "translated" ? { outcome: "translated", receiptId } : { outcome: "stale", reason: "text-hash-changed" };
}

// ── Story (event) copy ──────────────────────────────────────────────────────────────────────────

interface StoryRow {
  id: number;
  title: string;
  summary: string | null;
  digest: string | null;
  latest: string | null;
  version: number;
  merged_into: number | null;
  title_en: string | null;
  digest_en: string | null;
  english_source_version: number | null;
}

/** The English event request; exported so the brain probe can replay it. */
export function buildEnglishStoryUser(story: Pick<StoryRow, "title" | "summary" | "digest">, reports: Array<{ at: Date; sourceName: string; title: string; summary: string | null }>): string {
  const lines = reports.slice(-REPORT_ENTRY_LIMIT).map((r) => `${r.at.toISOString()} | ${r.sourceName} | ${r.title} | ${(r.summary ?? "").slice(0, 220)}`);
  return [
    `Story title (Chinese): ${story.title}`,
    `Story summary (Chinese): ${story.summary || "(none)"}`,
    `Current digest (Chinese): ${story.digest || "(none)"}`,
    "",
    "Reports (time | source | title | summary):",
    ...lines,
  ].join("\n");
}

function storyEvidence(story: StoryRow, reports: Array<{ title: string; summary: string | null; sourceName: string }>): EnglishEvidence {
  return {
    title: [story.title, story.summary ?? "", ...reports.map((r) => r.title)].filter(isText).join("\n"),
    text: [story.digest ?? "", story.latest ?? "", ...reports.map((r) => `${r.sourceName}｜${r.title}｜${r.summary ?? ""}`)].filter(isText).join("\n"),
  };
}

/**
 * The event page's English title/digest/latest, plus a new `story_digests_en` version. One call, one CAS
 * write on `stories.version`; `stories.version` itself is not bumped (that would make the Chinese digest
 * look stale and re-enqueue `events.digest`).
 */
export async function writeStoryEnglish(storyId: number): Promise<EnglishWriteResult> {
  const [story] = await sql<StoryRow[]>`
    SELECT id, title, summary, digest, latest, version, merged_into, title_en, digest_en, english_source_version
      FROM stories WHERE id = ${storyId}`;
  if (!story) {
    await recordEnglishAttempt("story", String(storyId), "0", "skipped", "no-story");
    return { outcome: "skipped", reason: "no-story" };
  }
  const revision = String(story.version);
  if (story.merged_into) {
    await recordEnglishAttempt("story", String(storyId), revision, "skipped", "merged");
    return { outcome: "skipped", reason: "merged" };
  }
  if (!story.digest?.trim()) {
    await recordEnglishAttempt("story", String(storyId), revision, "skipped", "no-digest");
    return { outcome: "skipped", reason: "no-digest" };
  }
  if (story.english_source_version === story.version && story.title_en?.trim() && story.digest_en?.trim()) {
    await recordEnglishAttempt("story", String(storyId), revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }
  const reports = await storyReports(story.id);
  if (!reports.length) {
    await recordEnglishAttempt("story", String(storyId), revision, "skipped", "no-reports");
    return { outcome: "skipped", reason: "no-reports" };
  }

  let answer: StoryAnswer;
  let receiptId: number;
  let rule: string | null;
  try {
    const model = await modelFor("english", String(storyId), "story_digest_en");
    const res = await chatJson({
      model,
      purpose: "story_digest_en",
      subject: `story:${storyId}`,
      promptVersion: STORY_PROMPT_VERSION,
      system: promptText("story-digest-en"),
      user: buildEnglishStoryUser(story, reports),
      schema: StorySchema,
      temperature: 0.3,
      maxTokens: 2000,
      timeoutMs: 240_000,
      usable: storyUsable,
    });
    answer = res.data;
    receiptId = res.receiptId;
    rule = machineRuleOf(res.usage);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("story", String(storyId), revision, error);
  }
  if (rule) {
    // 读者可见的英文综述只能出自署名的那一份；机器规则拼出来的稿子留空，读取层回退中文。
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("story", String(storyId), revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const problem = storyUsable(answer);
  if (problem) {
    await recordEnglishAttempt("story", String(storyId), revision, "failed", problem);
    return { outcome: "failed", reason: problem };
  }
  const guard = enforceEnglishIdentity(storyEvidence(story, reports), { title: answer.title.trim(), summary: "", reason: "" });
  if (!guard.title) {
    const reason = `identity:${guard.identityGuard.unsupportedTitleEntityIds.join(",")}`;
    await rejectReceivedResponse(receiptId, `story title refused: ${reason}`);
    await recordEnglishAttempt("story", String(storyId), revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const digest = closeEnglishSentence(answer.digest.trim());
  const latest = answer.latest.trim() ? closeEnglishSentence(answer.latest.trim()) : null;
  const inputsHash = sha256(stableJson([story.version, reports.map((r) => [r.id, r.title, r.summary ?? ""])]));

  const written = await sql.begin(async (tx) => {
    const [current] = await tx<{ version: number; merged_into: number | null }[]>`
      SELECT version, merged_into FROM stories WHERE id = ${storyId} FOR UPDATE`;
    if (!current || current.merged_into || current.version !== story.version) return "stale" as const;
    const [top] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM story_digests_en WHERE story_id = ${storyId}`;
    const version = Math.max(story.version, Number(top?.v ?? 0)) + 1;
    await tx`
      INSERT INTO story_digests_en (story_id, version, source_version, digest, latest, receipt_id, inputs_hash, machine_rule)
      VALUES (${storyId}, ${version}, ${story.version}, ${digest}, ${latest}, ${receiptId}, ${inputsHash}, NULL)`;
    await tx`
      UPDATE stories SET title_en = ${guard.title}, digest_en = ${digest}, latest_en = ${latest},
             english_version = ${version}, english_source_version = ${story.version}
       WHERE id = ${storyId}`;
    await completeReceipt(tx, receiptId);
    return "written" as const;
  });
  await recordEnglishAttempt("story", String(storyId), revision, written, written === "written" ? "stored" : "story-version-changed");
  if (written !== "written") await rejectReceivedResponse(receiptId, "story version changed before the English digest was stored");
  return written === "written" ? { outcome: "written", receiptId } : { outcome: "stale", reason: "story-version-changed" };
}

// ── Fact titles ─────────────────────────────────────────────────────────────────────────────────

interface FactRow {
  id: string;
  title: string;
  title_en: string | null;
  occurred_at: Date | null;
}

/** The fact-title request; exported so the brain probe can replay it. */
export function buildEnglishFactTitlesUser(storyTitle: string | null, facts: Array<{ id: string; title: string }>): string {
  return JSON.stringify({
    story: storyTitle ?? "",
    facts: facts.map((f) => ({ id: f.id, title: f.title })),
    target: "en",
  });
}

/**
 * English titles for every fact of one event. `stories.version` does not change when a new development is
 * added, so this leg is driven by `facts.title_en IS NULL` (sweep) and by the digest job; it covers every
 * listed fact, not only the ones the digest happens to mention. Each write is `WHERE id=? AND title=?`:
 * a fact whose Chinese title changed during the call is skipped, and the story is re-queued.
 */
export async function writeFactTitlesEn(storyId: number): Promise<EnglishWriteResult> {
  const [story] = await sql<{ title: string | null; title_en: string | null }[]>`SELECT title, title_en FROM stories WHERE id = ${storyId}`;
  const facts = await sql<FactRow[]>`
    SELECT id::text AS id, title, title_en, occurred_at FROM facts WHERE story_id = ${storyId} ORDER BY created_at, id`;
  if (!facts.length) {
    await recordEnglishAttempt("fact", String(storyId), factsRevisionOf(0, null), "skipped", "no-facts");
    return { outcome: "skipped", reason: "no-facts" };
  }
  const revision = factsRevisionOf(facts.length, facts[facts.length - 1]!.id);
  const missing = facts.filter((f) => !f.title_en?.trim());
  if (!missing.length) {
    await recordEnglishAttempt("fact", String(storyId), revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }
  const batch = missing.slice(0, FACT_TITLE_BATCH);
  const requestedIds = new Set(batch.map((f) => f.id));

  let answer: FactTitlesAnswer;
  let receiptId: number;
  let rule: string | null;
  try {
    const model = await modelFor("english", String(storyId), "translate_fact_titles_en");
    const res = await chatJson({
      model,
      purpose: "translate_fact_titles_en",
      subject: `story:${storyId}:facts`,
      promptVersion: FACT_TITLES_PROMPT_VERSION,
      system: promptText("translate-fact-titles-en"),
      user: buildEnglishFactTitlesUser(story?.title ?? null, batch.map((f) => ({ id: f.id, title: f.title }))),
      schema: FactTitlesSchema,
      temperature: 0.2,
      maxTokens: Math.min(6000, 200 + batch.length * 90),
      timeoutMs: 180_000,
      usable: (data) => factTitlesUsable(data, requestedIds),
    });
    answer = res.data;
    receiptId = res.receiptId;
    rule = machineRuleOf(res.usage);
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("fact", String(storyId), revision, error);
  }
  if (rule) {
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("fact", String(storyId), revision, "failed", reason);
    return { outcome: "failed", reason };
  }
  const problem = factTitlesUsable(answer, requestedIds);
  if (problem) {
    await recordEnglishAttempt("fact", String(storyId), revision, "failed", problem);
    return { outcome: "failed", reason: problem };
  }

  const written = await sql.begin(async (tx) => {
    let updated = 0;
    for (const item of answer.titles) {
      const source = batch.find((f) => f.id === item.id);
      if (!source) continue;
      const res = await tx`UPDATE facts SET title_en = ${item.title.trim()}, english_at = now() WHERE id = ${source.id} AND title = ${source.title}`;
      updated += res.count;
    }
    if (updated === batch.length) await completeReceipt(tx, receiptId);
    return updated;
  });
  if (written === batch.length && missing.length === batch.length) {
    await recordEnglishAttempt("fact", String(storyId), revision, "translated", "stored");
    return { outcome: "translated", receiptId };
  }
  // 有 fact 在调用期间被改写，或这一批不是全部：不记终态，下一轮按 `title_en IS NULL` 重排。
  const reason = written === batch.length ? `partial: ${batch.length} of ${missing.length} facts` : `${batch.length - written} fact title(s) changed meanwhile`;
  // 没写完的回执不留在 `received`：否则下一批会原样复用这份只覆盖前半批的答复，剩下的永远排不到。
  await rejectReceivedResponse(receiptId, reason);
  await recordEnglishAttempt("fact", String(storyId), revision, "stale", reason);
  return { outcome: "stale", reason };
}

// ── Reports ────────────────────────────────────────────────────────────────────────────────────

type ReportKind = "daily" | "weekly" | "monthly";

interface ReportEntryView {
  itemId: string;
  title: string;
  summary: string;
  sourceName: string;
  role: string;
}

interface ReportView {
  sections: Array<{ label: string; items: ReportEntryView[] }>;
  themes: Array<{ heading: string; summary: string | null; entries: ReportEntryView[] }>;
  /** Daily 快讯：它们也出现在版面上，所以也要有写时英文快照。 */
  flashes: ReportEntryView[];
  lead: { title: string; leadParagraph: string } | null;
}

function entryView(value: unknown): ReportEntryView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const itemId = typeof v.itemId === "string" ? v.itemId : "";
  const title = typeof v.title === "string" ? v.title : "";
  if (!itemId || !title) return null;
  return {
    itemId,
    title,
    summary: typeof v.summary === "string" ? v.summary : "",
    sourceName: typeof v.sourceName === "string" ? v.sourceName : "",
    role: typeof v.role === "string" ? v.role : "",
  };
}

/** The `reports.content` shape this layer reads: daily sections or weekly/monthly themes, plus the lead. */
function reportView(kind: ReportKind, content: unknown): ReportView {
  const c = (content && typeof content === "object" ? content : {}) as Record<string, unknown>;
  const leadRaw = c.lead as Record<string, unknown> | null | undefined;
  const lead = leadRaw && typeof leadRaw.title === "string" && typeof leadRaw.leadParagraph === "string"
    ? { title: leadRaw.title, leadParagraph: leadRaw.leadParagraph }
    : null;
  if (kind === "daily") {
    const sections = Array.isArray(c.sections) ? c.sections : [];
    return {
      lead,
      sections: sections.flatMap((s) => {
        if (!s || typeof s !== "object") return [];
        const section = s as Record<string, unknown>;
        const items = (Array.isArray(section.items) ? section.items : []).map(entryView).filter((e): e is ReportEntryView => !!e);
        return typeof section.label === "string" ? [{ label: section.label, items }] : [];
      }),
      themes: [],
      flashes: (Array.isArray(c.flashes) ? c.flashes : []).map(entryView).filter((e): e is ReportEntryView => !!e),
    };
  }
  const themes = Array.isArray(c.themes) ? c.themes : [];
  return {
    lead,
    sections: [],
    themes: themes.flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const theme = t as Record<string, unknown>;
      const entries = (Array.isArray(theme.storyRefs) ? theme.storyRefs : []).map(entryView).filter((e): e is ReportEntryView => !!e);
      return typeof theme.heading === "string"
        ? [{ heading: theme.heading, summary: typeof theme.summary === "string" ? theme.summary : null, entries }]
        : [];
    }),
    flashes: [],
  };
}

/** The daily's English brief; exported so the brain probe can replay it. */
export function buildEnglishDailyUser(key: string, view: ReportView): string {
  const lines: string[] = [`Edition: ${key}`];
  if (view.lead) lines.push(`Lead (Chinese): ${view.lead.title} — ${view.lead.leadParagraph}`);
  lines.push(`Sections in print order: ${view.sections.map((s) => s.label).join("; ") || "(none)"}`);
  lines.push("Entries:");
  let n = 0;
  for (const section of view.sections) {
    for (const item of section.items) {
      n += 1;
      lines.push(`${n}) [${section.label}] ${item.title} | ${item.summary.slice(0, 220)}`);
    }
  }
  for (const flash of view.flashes) {
    n += 1;
    lines.push(`${n}) [flash] ${flash.title} | ${flash.summary.slice(0, 220)}`);
  }
  return lines.join("\n");
}

/** The weekly/monthly English brief; exported so the brain probe can replay it. */
export function buildEnglishPeriodUser(kind: "weekly" | "monthly", key: string, content: Record<string, unknown>, view: ReportView): string {
  const lines: string[] = [`Period: ${kind} ${key}`];
  const start = typeof content.periodStart === "string" ? content.periodStart : "";
  const end = typeof content.periodEnd === "string" ? content.periodEnd : "";
  if (start && end) lines.push(`Window: ${start} to ${end}`);
  lines.push(`Themes in order (keep this count and order): ${view.themes.length}`);
  view.themes.forEach((theme, i) => {
    lines.push(`${i + 1}) ${theme.heading} — ${theme.summary || "(no summary)"}`);
    theme.entries.forEach((entry, j) => lines.push(`   [${j + 1}] ${entry.title} | ${entry.summary.slice(0, 220)}`));
  });
  return lines.join("\n");
}

/** Freeze the cited copy as it is now: English when written, Chinese otherwise (the read layer's fallback signal). */
async function citationSnapshots(entries: ReportEntryView[]): Promise<ReportCitationSnapshot[]> {
  const ids = [...new Set(entries.map((e) => e.itemId))];
  if (!ids.length) return [];
  const rows = await sql<{ article_id: string; title: string; summary: string | null; title_en: string | null; summary_en: string | null; english_fresh: boolean; name: string; name_en: string | null; url: string }[]>`
    SELECT p.article_id, p.title, p.summary, p.title_en, p.summary_en,
           (p.english_source_revision = p.revision) AS english_fresh, s.name, s.name_en, p.url
      FROM publications p JOIN sources s ON s.id = p.source_id
     WHERE p.article_id = ANY(${ids}::text[])`;
  const byId = new Map(rows.map((r) => [r.article_id, r]));
  const seen = new Set<string>();
  const out: ReportCitationSnapshot[] = [];
  for (const entry of entries) {
    if (seen.has(entry.itemId)) continue;
    seen.add(entry.itemId);
    const row = byId.get(entry.itemId);
    out.push({
      itemId: entry.itemId,
      // 只有当前 revision 的英文稿才是快照；旧 revision 的英文稿不冒充当前引用。
      title: row?.english_fresh && row.title_en?.trim() ? row.title_en : entry.title,
      summary: row?.english_fresh && row.summary_en?.trim() ? row.summary_en : (row?.summary || entry.summary || null),
      sourceName: row ? sourceNameFor("en", row.name, row.name_en, row.url) : entry.sourceName,
      role: entry.role || null,
    });
  }
  return out;
}

/**
 * The edition's English overlay + the citation snapshot. Daily writes `lead`/`sections`; weekly/monthly
 * writes `headline`/`overview`/`themes`, and `themes.length` must equal the Chinese edition's — otherwise
 * the whole answer is refused (a half-translated issue is not a layout the read layer can render).
 */
export async function writeReportEnglish(kind: ReportKind, key: string): Promise<EnglishWriteResult> {
  const [report] = await sql<{ revision: number; content: unknown; revision_en: number | null; content_en: unknown }[]>`
    SELECT revision, content, revision_en, content_en FROM reports WHERE kind = ${kind} AND key = ${key}`;
  if (!report) {
    await recordEnglishAttempt("report", `${kind}:${key}`, "0", "skipped", "no-report");
    return { outcome: "skipped", reason: "no-report" };
  }
  const revision = String(report.revision);
  if (report.revision_en === report.revision && report.content_en !== null) {
    await recordEnglishAttempt("report", `${kind}:${key}`, revision, "skipped", "already-fresh");
    return { outcome: "skipped", reason: "already-fresh" };
  }
  const view = reportView(kind, report.content);
  // 所有出现在版面上的引用都要有写时快照：daily 包括快讯；不按 40 条截断，否则周/月报超过 40 条
  // 引用时，读层对全部引用求 textLocale 会把这一期判成 mixed，而索引又已经把它列了出来。
  const entries = kind === "daily" ? [...view.sections.flatMap((s) => s.items), ...view.flashes] : view.themes.flatMap((t) => t.entries);
  if (!entries.length) {
    await recordEnglishAttempt("report", `${kind}:${key}`, revision, "skipped", "no-citations");
    return { outcome: "skipped", reason: "no-citations" };
  }
  const citations = await citationSnapshots(entries);
  // 引用快照是成刊时冻结的，之后不会因为条目补了英文而自动刷新（0128 的设计）。
  // 所以只要有一条引用的标题/摘要是中文，这一期就不能写成英文刊面：否则 content_en 会被记成
  // "已有英文"，而读层看到快照里的中文又把它藏起来，这一期再也不会重排。
  if (!citations.every((c) => !hasChineseCopy(c.title) && (!c.summary || !hasChineseCopy(c.summary)))) {
    const reason = "citations-not-english";
    // stale 而不是 failed/skipped：引用条目补上英文后 sweep 还会再排；failed 三次后这一期就永久没有
    // 英文版（sweep 只重排 stale 与未达上限的 failed，见 jobs/english.ts）。
    await recordEnglishAttempt("report", `${kind}:${key}`, revision, "stale", reason);
    return { outcome: "stale", reason };
  }
  const evidence: EnglishEvidence = {
    title: entries.map((e) => e.title).join("\n"),
    text: entries.map((e) => `${e.sourceName}｜${e.title}｜${e.summary}`).join("\n"),
  };
  const themeCount = view.themes.length;

  let overlay: ReportEnglishContent;
  let receiptId: number;
  let model: string;
  let rule: string | null;
  try {
    model = await modelFor("english", `${kind}:${key}`, kind === "daily" ? "report_lead_en" : "report_period_en");
    if (kind === "daily") {
      const res = await chatJson({
        model,
        purpose: "report_lead_en",
        subject: `report:${kind}:${key}`,
        promptVersion: DAILY_PROMPT_VERSION,
        system: promptText("report-daily-lead-en"),
        user: buildEnglishDailyUser(key, view),
        schema: DailySchema,
        temperature: 0.3,
        maxTokens: 900,
        timeoutMs: 180_000,
        usable: (data) => dailyUsable(data, view.sections.length),
      });
      receiptId = res.receiptId;
      rule = machineRuleOf(res.usage);
      const answer = res.data;
      // 机器规则拼出来的答复先拒，再谈形状：stub 没有署名稿时返回空 title，
      // 以前的顺序把它记成 `failed:title: empty`，看起来像模型答坏了，实际是"没有署名的稿子"。
      if (rule) {
        const reason = `unsigned:${rule}`;
        await recordEnglishAttempt("report", `${kind}:${key}`, revision, "failed", reason);
        return { outcome: "failed", reason };
      }
      const problem = dailyUsable(answer, view.sections.length);
      if (problem) {
        await recordEnglishAttempt("report", `${kind}:${key}`, revision, "failed", problem);
        return { outcome: "failed", reason: problem };
      }
      const title = guardReportTitle(evidence, answer.title);
      overlay = {
        citations,
        lead: title ? { title, leadParagraph: closeEnglishSentence(answer.leadParagraph.trim()) } : null,
        ...(answer.sections.length === view.sections.length
          ? { sections: answer.sections.map((s) => ({ label: s.label.trim(), summary: s.summary.trim() ? closeEnglishSentence(s.summary.trim()) : null })) }
          : {}),
      };
    } else {
      const res = await chatJson({
        model,
        purpose: "report_period_en",
        subject: `report:${kind}:${key}`,
        promptVersion: PERIOD_PROMPT_VERSION,
        system: promptText("report-period-en"),
        user: buildEnglishPeriodUser(kind, key, (report.content ?? {}) as Record<string, unknown>, view),
        schema: PeriodSchema,
        temperature: 0.3,
        maxTokens: 3000,
        timeoutMs: 240_000,
        usable: (data) => periodUsable(data, themeCount),
      });
      receiptId = res.receiptId;
      rule = machineRuleOf(res.usage);
      const answer = res.data;
      // 同 daily 分支：没有署名稿的机器答复先记 `unsigned`，不要让它冒充 "title/overview 空"。
      if (rule) {
        const reason = `unsigned:${rule}`;
        await recordEnglishAttempt("report", `${kind}:${key}`, revision, "failed", reason);
        return { outcome: "failed", reason };
      }
      const problem = periodUsable(answer, themeCount);
      if (problem) {
        await recordEnglishAttempt("report", `${kind}:${key}`, revision, "failed", problem);
        return { outcome: "failed", reason: problem };
      }
      const headline = guardReportTitle(evidence, answer.headline);
      overlay = {
        citations,
        headline: headline || null,
        overview: closeEnglishSentence(answer.overview.trim()),
        themes: answer.themes.map((t) => ({ heading: t.heading.trim(), summary: t.summary.trim() ? closeEnglishSentence(t.summary.trim()) : null })),
      };
    }
  } catch (error) {
    if (infrastructureFailure(error)) throw error;
    return failedAttempt("report", `${kind}:${key}`, revision, error);
  }
  if (rule) {
    const reason = `unsigned:${rule}`;
    await recordEnglishAttempt("report", `${kind}:${key}`, revision, "failed", reason);
    return { outcome: "failed", reason };
  }

  const written = await sql.begin(async (tx) => {
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    if (!current || current.revision !== report.revision) return "stale" as const;
    await tx`
      UPDATE reports SET content_en = ${tx.json(overlay as never)}, model_en = ${model},
             revision_en = ${report.revision}, english_at = now()
       WHERE kind = ${kind} AND key = ${key}`;
    await completeReceipt(tx, receiptId);
    return "written" as const;
  });
  await recordEnglishAttempt("report", `${kind}:${key}`, revision, written, written === "written" ? "stored" : "report-revision-changed");
  return written === "written" ? { outcome: "written", receiptId } : { outcome: "stale", reason: "report-revision-changed" };
}

/** A report headline may only name an entity its own cited entries name, or it is dropped. */
function guardReportTitle(evidence: EnglishEvidence, title: string): string {
  return enforceEnglishIdentity(evidence, { title: title.trim(), summary: "", reason: "" }).title;
}