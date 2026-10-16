// Full-text Chinese translations: made by the worker after an item
// is selected, for sources whose full text may be shown on the site; a page read never translates.
// Bodies are translated block by block (paragraphs, headings, list items, captions, table cells) so the
// sanitised structure stays as it is. Inside a block, images and inline code never reach the model
// (placeholders) and links keep only their text and an id; a block whose answer loses or repeats any of
// them is asked once more, then kept in the original. Each batch is a receipt, so a re-run reuses
// answers already paid for. A translation missing any block is stored as incomplete, never as whole.
// A block that came back Chinese is normalised on the way in (English unit words, straight quotes); a
// block with no Chinese in it at all — the residue of a body only partly translated — is left alone.
// The post a selected X post quotes is translated too (once per quoted post, shared by every quote).
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import { bodyIsChinese, hasChineseCopy } from "@aihot/contracts/copy";
import { sql } from "../db.ts";
import { sanitizeBody, textToHtml } from "../content/sanitize.ts";
import { chatJson } from "../providers/llm.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";
import { modelFor } from "./models.ts";
import { looksZh } from "./writing.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { promptText, promptVersion } from "./prompts.ts";

export const TRANSLATE_PROMPT_VERSION = promptVersion("translate-body", "translate-post");
const BATCH_CHARS = 3500;
/** Longer bodies get their first part translated and are marked incomplete. */
const MAX_CHARS = 60_000;
/** X posts shorter than this carry their meaning in the Chinese title and summary. */
const X_MIN_CHARS = 60;

const BLOCK = new Set(["p", "h2", "h3", "h4", "h5", "li", "blockquote", "figcaption", "td", "th", "dt", "dd", "caption"]);
const CONTAINER = /^(p|h[2-5]|li|blockquote|figcaption|td|th|dt|dd|caption|ul|ol|table|pre|figure|div)$/;

const Output = z.object({ t: z.array(z.string()) });

class TranslationInterruptedError extends Error {}

const SYSTEM_BODY = promptText("translate-body");

const SYSTEM_POST = promptText("translate-post");

export interface TranslateResult {
  articleId: string;
  status: "translated" | "partial" | "skipped";
  /** The article revision this result is about: the one read and translated, not a later one. */
  revision?: number;
  segments?: number;
  reason?: string;
}

// The predicate itself is `@aihot/contracts/copy`'s: `publication/detail.ts` asks the same question about
// the same rows, and the two used to spell the character class separately.

/** Leaf text blocks of a sanitised body, in document order, skipping code. */
function segmentsOf($: cheerio.CheerioAPI): Element[] {
  const out: Element[] = [];
  const visit = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.name === "pre" || el.name === "code") continue;
      const hasBlockChild = el.children.some((c) => c.type === "tag" && CONTAINER.test((c as Element).name));
      if (BLOCK.has(el.name) && !hasBlockChild) {
        if (/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ]/.test($(el).text())) out.push(el);
        continue;
      }
      visit(el.children);
    }
  };
  visit($.root().children().toArray());
  return out;
}

async function translateBatch(articleId: string, revision: number, index: number, parts: string[], system: string, attemptTag?: string): Promise<string[] | null> {
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  // One article, one translator: the shard key is the article id, not the batch index, or a long body
  // would be rendered in several prose styles stitched together.
  const workUnit = `article:${articleId}@${revision}`;
  const model = await modelFor("translate", articleId);
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
  const res = await chatJson({
    model,
    purpose: "translate_body",
    subject: `${workUnit}#${index}`,
    promptVersion: TRANSLATE_PROMPT_VERSION,
    system,
    user: JSON.stringify({ segments: parts }),
    schema: Output,
    temperature: 0.2,
    maxTokens: Math.min(8000, Math.ceil(parts.join("").length * 1.2) + 400),
    timeoutMs: 180_000,
    attemptTag,
  });
  return res.data.t.length === parts.length ? res.data.t : null;
}

/**
 * 只有"这一轮别再往下走"的错误才允许穿出批次层：停机、模型调用被关掉、没配置、熔断把额度用尽。
 * 批次层用它的反面来决定"这块算没翻出来"，`translatePending` 用它来决定"停整轮"——两层必须问同
 * 一个问题，否则熔断会被当成坏块咽下去，整轮继续对着已经墙死的门敲门。
 */
function stopsTheRun(error: unknown): boolean {
  return error instanceof TranslationInterruptedError || /disabled|not configured|budget/i.test((error as Error).message);
}

/** Translates batches; a batch whose answer does not line up is halved once, and a half that answers is kept. */
async function translateAll(articleId: string, revision: number, parts: string[], system: string, attemptTag?: string): Promise<{ answers: Array<string | null>; errors: string[] }> {
  const out: Array<string | null> = new Array(parts.length).fill(null);
  const errors: string[] = [];
  // 一批"报错"不等于整篇作废。2026-10-16 实测 12 小时 116 次 translate_body 调用：<180 s 的 107 次全部
  // received，≥180 s 的 9 次一次没成，报错文本只有 TimeoutError、不可用的答复、超 30 分钟被自动放行的
  // unknown 三种。它们原本直接穿出这里，于是整篇一块都没入库——同一轮里已经付过费的答复也一起扔掉，
  // 还要占掉 translation_attempts 三次机会里的一次。长正文批次多，被钉死的全是长正文（p50 20,136 字，
  // 而翻成功的那批只有 3,135 字）。现在按"这块没翻出来"处理：折半、缺块单问，其余照旧入库。
  const ask = (batch: string[], index: number): Promise<string[] | null> =>
    translateBatch(articleId, revision, index, batch, system, attemptTag).catch((error: unknown) => {
      if (stopsTheRun(error)) throw error;
      errors.push((error as Error).message);
      return null;
    });
  let start = 0;
  let index = 0;
  while (start < parts.length) {
    let end = start;
    let chars = 0;
    while (end < parts.length && (end === start || chars + parts[end]!.length <= BATCH_CHARS)) chars += parts[end++]!.length;
    const batch = parts.slice(start, end);
    const done = await ask(batch, index++);
    if (!done && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await ask(batch.slice(0, mid), index++);
      const right = await ask(batch.slice(mid), index++);
      // 折半是为了让"这一批太长/链撞了 cap"这种失败只损失一批，不是一整篇。所以一半答回来就收下那一半：
      // 原来要求两半都成，成的那半跟着整批一起扔；缺块重问那一步又把它们按同样的字符拼回一批、再撞同一堵墙，
      // 三次尝试用完，读者面上就永久留着"中文正文里夹几段英文"（2026-10-16 账上 9 条长论文、可见切片 89 块）。
      if (left) left.forEach((t, i) => (out[start + i] = t));
      if (right) right.forEach((t, i) => (out[start + mid + i] = t));
    } else if (done) {
      done.forEach((t, i) => (out[start + i] = t));
    }
    start = end;
  }
  return { answers: out, errors };
}

/** A block as the model sees it: media and inline code as ⟦n⟧, links as <a id="Ln"> with their attributes kept here. */
interface Shielded {
  html: string;
  tokens: string[];
  links: Array<Record<string, string>>;
}

export function shield(inner: string): Shielded {
  const $ = cheerio.load(inner, null, false);
  const tokens: string[] = [];
  for (const node of $("picture, video, img, code").toArray()) {
    if ($(node).parents("picture, video, code").length) continue;
    tokens.push($.html(node));
    $(node).replaceWith(`⟦${tokens.length - 1}⟧`);
  }
  const links: Shielded["links"] = [];
  $("a").each((i, a) => {
    links.push({ ...(a as Element).attribs });
    (a as Element).attribs = { id: `L${i}` };
  });
  return { html: $.html(), tokens, links };
}

/** The translated block with its media, code and links put back; null when the answer lost or repeated any. */
export function unshield(translated: string, s: Shielded): string | null {
  const counts = new Map<number, number>();
  for (const m of translated.matchAll(/⟦(\d+)⟧/g)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  if (counts.size !== s.tokens.length || s.tokens.some((_t, i) => counts.get(i) !== 1)) return null;
  const $ = cheerio.load(translated, null, false);
  const seen = new Set<number>();
  let intact = true;
  $("a").each((_i, a) => {
    const n = /^L(\d+)$/.exec((a as Element).attribs.id ?? "")?.[1];
    const attribs = n === undefined ? undefined : s.links[Number(n)];
    if (!attribs || seen.has(Number(n))) intact = false;
    else {
      seen.add(Number(n));
      (a as Element).attribs = attribs;
    }
  });
  if (!intact || seen.size !== s.links.length) return null;
  return $.html().replace(/⟦(\d+)⟧/g, (_m, n: string) => s.tokens[Number(n)]!);
}

/**
 * 中文正文里照抄下来的英文单位与直角引号，读者一眼就看出来是机器翻的：2026-10-16 在库存译文上量到
 * 直引号 10 条（其中 6 条在已翻全的正文里）、英文单位 6 条（3 条），例："LROC 图像中…" Watters 说。
 * / 24 tonnes / 708 hectares。这一层只做字符级替换——数值与小数位一个都不动，而且只改含汉字的文本节点，
 * 所以未翻全时保留下来的英文块不会被它冒充成译文（那是 #237 的活，不是标点该管的）。
 */
const UNIT_WORDS: Record<string, string> = {
  tonne: "吨", ton: "吨", hectare: "公顷", kilogram: "千克", metre: "米", meter: "米", litre: "升", liter: "升",
};
const UNIT_TOKEN = /\b(\d[\d,.]*)\s*(km2|sq km|tonnes?|tons?|hectares?|kilograms?|metres?|meters?|litres?|liters?)\b/gi;

export function zhText(text: string): string {
  let out = text.replace(UNIT_TOKEN, (_m, num: string, unit: string) => {
    const u = unit.toLowerCase();
    if (u === "km2" || u === "sq km") return `${num} km²`;
    return `${num} ${UNIT_WORDS[u.replace(/s$/, "")] ?? unit}`;
  });
  // 引号只在成对时换：单个 " 可能是缩写或代码片段，猜不得。
  const quotes = (out.match(/"/g) ?? []).length;
  if (quotes >= 2 && quotes % 2 === 0) out = out.replace(/"([^"\n]{2,})"/g, "“$1”");
  return out;
}

export function polishZh(html: string): string {
  const $ = cheerio.load(html, null, false);
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        if (hasChineseCopy(n.data)) n.data = zhText(n.data);
      } else if (n.type === "tag") {
        const el = n as Element;
        if (el.name !== "code" && el.name !== "pre") walk(el.children);
      }
    }
  };
  walk($.root().children().toArray());
  return $.html();
}

export async function translateArticle(articleId: string): Promise<TranslateResult> {
  const [row] = await sql<{ revision: number; channel: string; language: string | null; body_html: string | null; body_text: string | null; x_post: { text?: string } | null; title: string; selected: boolean; body_mode: string; visibility: string }[]>`
    SELECT a.revision, p.channel, a.language, a.body_html, a.body_text, a.x_post, p.title, p.selected, p.body_mode, p.visibility
    FROM publications p JOIN articles a ON a.id = p.article_id WHERE p.article_id = ${articleId}`;
  if (!row) return { articleId, status: "skipped", reason: "not published" };
  const result = (r: Omit<TranslateResult, "articleId" | "revision">): TranslateResult => ({ articleId, revision: row.revision, ...r });
  if (!row.selected || row.visibility !== "public" || row.body_mode !== "full") return result({ status: "skipped", reason: "not a selected full-text item" });

  if (row.channel === "x") {
    const text = String(row.x_post?.text ?? row.body_text ?? "").trim();
    const meaningful = collapseWhitespace(text.replace(/https?:\/\/\S+/g, ""));
    if (bodyIsChinese(row.language, text)) return result({ status: "skipped", reason: "already Chinese" });
    if (meaningful.length < X_MIN_CHARS) return result({ status: "skipped", reason: "short post" });
    const { answers: [t], errors } = await translateAll(articleId, row.revision, [text], SYSTEM_POST);
    // 回声不是译文：把英文原样还回来的答复会被存成"AI 翻译"给读者看（红线：不把英文当中文发布）。
    if (!t || !looksZh(t)) {
      // 但"这一轮根本没拿到答复"（超时、坏答复、熔断前的报错）不能记成终态：skipped 与 partial 都会把
      // 条目从待翻查询里永久排除，一门被墙死的时段会把每一篇都钉在一次失败上。抛出去记 failed，还能再来。
      if (errors.length) throw new Error(`no translation: ${errors[0]!.slice(0, 160)}`);
      return result({ status: "skipped", reason: t ? "answer is not Chinese" : "translation did not line up" });
    }
    await store(articleId, row.revision, row.title, textToHtml(zhText(t)), zhText(t), true);
    return result({ status: "translated", segments: 1 });
  }

  // 只给纯文本正文的采集器不少（RSS 常常只有 text）：没有 html 就把 text 当正文翻。这一腿原来会在
  // `!row.body_html` 处直接 skip，而 skipped 是终态（translatePending 用它排除条目），于是这一类条目
  // 永远不会有中文译文——正是读者要的「英文版还要有中文版」那一条。
  const bodyHtml = row.body_html ?? (row.body_text ? textToHtml(row.body_text) : "");
  if (!bodyHtml || bodyIsChinese(row.language, row.body_text ?? "")) return result({ status: "skipped", reason: "no foreign-language body" });
  const $ = cheerio.load(bodyHtml, null, false);
  const blocks = segmentsOf($);
  if (!blocks.length) return result({ status: "skipped", reason: "no translatable text" });
  // Beyond the cap, only the leading blocks are translated; the rest keep the original text.
  let budget = MAX_CHARS;
  const chosen: Element[] = [];
  for (const el of blocks) {
    const html = $(el).html() ?? "";
    if (html.length > budget) break;
    budget -= html.length;
    chosen.push(el);
  }
  const shielded = chosen.map((el) => shield($(el).html() ?? ""));
  const restore = (answers: Array<string | null>) => answers.map((t, i) => (t === null ? null : unshield(t, shielded[i]!)));
  const first = await translateAll(articleId, row.revision, shielded.map((b) => b.html), SYSTEM_BODY);
  const errors = [...first.errors];
  const translations = restore(first.answers);
  // 回声不是译文：原文有词而答复一个汉字都没有的块按"没翻出来"处理（走下面的一次重问、再不行保留
  // 原文），否则整段英文会被标成"正文 · AI 翻译"贴进正文（红线）。原文本来只有数字/符号的块不算。
  const sourceTexts = chosen.map((el) => $(el).text());
  translations.forEach((t, i) => {
    if (t && !looksZh(t) && /\p{L}{2,}/u.test(sourceTexts[i] ?? "")) translations[i] = null;
  });
  // Blocks whose answer dropped a link or an image are asked once more, on their own receipt.
  const missing = translations.flatMap((t, i) => (t === null ? [i] : []));
  if (missing.length) {
    const again = await translateAll(articleId, row.revision, missing.map((i) => shielded[i]!.html), SYSTEM_BODY, "retry");
    errors.push(...again.errors);
    missing.forEach((i, k) => (translations[i] = again.answers[k] ? unshield(again.answers[k]!, shielded[i]!) : null));
  }
  let done = 0;
  chosen.forEach((el, i) => {
    const t = translations[i];
    if (t) {
      $(el).html(polishZh(t));
      done += 1;
    }
  });
  if (!done) {
    // 一次都没成，且是"报错"造成的：抛给 translatePending 记可重试的 failed。写成 skipped 就是终态，
    // 一整个时段门都被墙死时，每一篇只会有一次机会就被永久排除。
    if (errors.length) throw new Error(`no block translated (${errors.length} batch error${errors.length > 1 ? "s" : ""}): ${errors[0]!.slice(0, 160)}`);
    return result({ status: "skipped", reason: "no batch translated" });
  }
  const complete = done === blocks.length;
  // 没翻全的原因要能在账上区分开：是模型有几块没答好，还是正文本来就超了 60,000 字的预算。
  // 不写出来的话两种情况都只剩一个 `partial`，下一次没人知道该修哪一头。
  const failed = chosen.length - done;
  const dropped = blocks.length - chosen.length;
  const html = sanitizeBody($.html());
  await store(articleId, row.revision, row.title, html, cheerio.load(html, null, false).root().text().trim(), complete);
  return result({
    status: complete ? "translated" : "partial",
    segments: done,
    reason: complete ? undefined : failed > 0 ? `${failed} of ${chosen.length} blocks kept in the original` : `${dropped} blocks over the ${MAX_CHARS}-character budget`,
  });
}

async function store(articleId: string, revision: number, title: string, html: string, text: string, complete: boolean) {
  // Never over a translation of a later revision (a slow run finishing after a newer one).
  await sql`
    INSERT INTO translations (article_id, lang, revision, title, body_html, body_text, complete, origin)
    VALUES (${articleId}, 'zh', ${revision}, ${title}, ${html}, ${text}, ${complete}, 'model')
    ON CONFLICT (article_id, lang) DO UPDATE SET revision = EXCLUDED.revision, title = EXCLUDED.title, body_html = EXCLUDED.body_html,
      body_text = EXCLUDED.body_text, complete = EXCLUDED.complete, origin = 'model', created_at = now()
    WHERE translations.origin <> 'source' AND translations.revision <= EXCLUDED.revision`;
}

/** A quoted post worth translating: at least a few letters beyond its links, and not already Chinese. */
function quoteTranslatable(text: string): boolean {
  const words = collapseWhitespace(text.replace(/https?:\/\/\S+/g, " "));
  return words.length >= 10 && (words.match(/\p{L}/gu) ?? []).length >= 2 && !hasChineseCopy(words);
}

/**
 * 解析失败的重问要封顶：这个循环每 5 分钟跑一遍、窗口 3 天，一条系统性解不开的引用帖本会一直付费
 * 重问（≈288 次/天）。按 (tweet, 文本哈希) 记失败次数，单个进程内至多问 3 次；文本一变哈希就变、
 * 重新计数，进程重启后清零——封顶的目的是把"解不开"的成本按住，不是禁掉重试。
 */
const quoteFailures = new Map<string, number>();

/**
 * The posts that selected X posts of the last `days` quote, translated once per quoted post: the
 * translation of the quoted post's own item is reused when it was collected and translated, else
 * DeepSeek (the translate model) translates it. Returns how many were stored.
 */
export async function translateQuotes(opts: { days?: number; limit?: number; budgetMs?: number } = {}): Promise<number> {
  const started = Date.now();
  const rows = await sql<{ tweet_id: string; text: string; text_hash: string | null; own_zh: string | null }[]>`
    SELECT DISTINCT ON (q.tweet_id) q.tweet_id, a.x_post->'quoted'->>'text' AS text, qt.text_hash,
      (SELECT tr.body_text FROM articles o JOIN translations tr ON tr.article_id = o.id AND tr.lang = 'zh' AND tr.revision >= o.revision
       WHERE o.identity_key = 'x:' || q.tweet_id AND tr.complete AND coalesce(tr.body_text, '') <> '') AS own_zh
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
    LEFT JOIN quote_translations qt ON qt.tweet_id = q.tweet_id
    WHERE p.channel = 'x' AND p.selected AND p.visibility = 'public' AND p.body_mode = 'full'
      AND p.discovered_at > now() - make_interval(days => ${opts.days ?? 3})
      AND q.tweet_id IS NOT NULL AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
    ORDER BY q.tweet_id, p.discovered_at DESC`;
  let stored = 0;
  for (const r of rows) {
    if (stored >= (opts.limit ?? 30) || Date.now() - started > (opts.budgetMs ?? 2 * 60_000) || shutdownSignal.signal.aborted) break;
    const hash = sha256(r.text);
    if (r.text_hash === hash || !quoteTranslatable(r.text)) continue;
    const failKey = `${r.tweet_id}:${hash}`;
    if ((quoteFailures.get(failKey) ?? 0) >= 3) continue;
    // Reuse our own translation of that tweet only if it is Chinese; an English copy would be stored as a
    // "译文" and shown as one.
    let zh = r.own_zh && looksZh(r.own_zh) ? r.own_zh : null;
    let origin: "reused" | "model" = "reused";
    if (!zh) {
      origin = "model";
      const subject = `quote:${r.tweet_id}`;
      try {
        const res = await chatJson({
          model: await modelFor("translate", r.tweet_id), purpose: "translate_quoted", subject, promptVersion: TRANSLATE_PROMPT_VERSION,
          system: SYSTEM_POST, user: JSON.stringify({ segments: [r.text] }), schema: Output, temperature: 0.2,
          maxTokens: Math.min(4000, Math.ceil(r.text.length * 1.5) + 200), timeoutMs: 120_000,
        });
        zh = res.data.t.length === 1 ? res.data.t[0]!.trim() : null;
      } catch (error) {
        // Switched-off calls or an exhausted budget stop the run; one unusable answer is counted and
        // skipped. A reply that did not parse left its receipt `failed`, so the next run would pay for
        // that one again — `quoteFailures` bounds how many times it may (a reply that parsed but says
        // nothing usable stays replayed for free; an answer that is empty is empty tomorrow too).
        if (/disabled|not configured|budget/i.test((error as Error).message)) throw error;
        quoteFailures.set(failKey, (quoteFailures.get(failKey) ?? 0) + 1);
        continue;
      }
    }
    if (!zh || !looksZh(zh)) continue;
    await sql`
      INSERT INTO quote_translations (tweet_id, text_hash, text_zh, origin) VALUES (${r.tweet_id}, ${hash}, ${zh}, ${origin})
      ON CONFLICT (tweet_id) DO UPDATE SET text_hash = EXCLUDED.text_hash, text_zh = EXCLUDED.text_zh, origin = EXCLUDED.origin, created_at = now()`;
    quoteFailures.delete(failKey);
    stored += 1;
  }
  return stored;
}

/**
 * 翻译腿只看这个窗口内的条目。3 天是站内还没有全文时的旧值——那时待翻的只有几条，宽窄无所谓。
 * 2026-10-16 打开 260 道"feed 自带全文"的门之后，精选外文条目一下变成 3,147 条，而这一腿是**单条串行**
 * （一个 for 循环 + 每次跑 ≤30 条 / 4 分钟预算），实测 ≈36 条/时。3 天窗口于是等于：3–7 天档 1,786 条、
 * 7–30 天档 217 条**永远是 0 条译文**（当天实测），读者点开就只看到原文。窗口调成与重投影同一口径，
 * 旧的条目按"从新到旧"随队列自己消化；要收紧就改 GEOHOT_TRANSLATE_WINDOW_DAYS。
 */
/** 窗口天数：环境变量给就用，给的是垃圾就用默认值，最小 1 天（0 或负数会把这一腿整个关死）。 */
export function translateWindowDays(raw: string | undefined = process.env.GEOHOT_TRANSLATE_WINDOW_DAYS, dflt = 30): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

const TRANSLATE_WINDOW_DAYS = translateWindowDays();

/** 同时翻几篇（1–6，默认 3）。0 / 负数 / 非数字退回默认，超过 6 一律压到 6：worker 只有 240 MB。 */
export function translateConcurrency(raw: string | undefined = process.env.GEOHOT_TRANSLATE_CONCURRENCY, dflt = 3): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(6, n) : dflt;
}

/**
 * Every few minutes: selected full-text items discovered or revised within TRANSLATE_WINDOW_DAYS that
 * lack a translation of their current revision, then the posts selected X posts quote. Stops after a time
 * budget. A translation of an older revision is not shown (items.ts), so a revised item is translated
 * again whatever its age.
 *
 * 「翻出来一部分」不是终态（2026-10-16 实测）：账上 5 条 partial 的 reason 是 "N of M blocks kept in the
 * original"（nature-geoscience 3/43、ecsociety 16/89、phys-org 12/35、dw 9/25、copernicus-essd 1/5），
 * 每条 attempts=1 就被这两个谓词一起排除——旧的那道是 `tr.revision < a.revision`（存了就不算缺），
 * 新的一道是 outcome 里有 'partial'。于是读者面上永久留着「中文正文里夹几段英文」。重问的成本有界：
 * 已经翻出来的块走 receipts 缓存（logical_key 里有正文哈希与 model，同一篇同一 revision 命中同一把门），
 * 只有没答上的块才是真请求；再加 attempts>=3 封顶。另一类 partial 是 "over the 60000-character budget"
 * （6 条，frontiers 系列），尾巴按预算就不翻，重试只是把缺的几块补上，补完仍是 partial——那也符合本意：
 * 读者渲染只有 20,000 字（BODY_CAP_CHARS），超出部分是永远不会印出来的。
 */
export async function translatePending(opts: { limit?: number; budgetMs?: number } = {}): Promise<{ done: TranslateResult[]; quotes: number }> {
  const started = Date.now();
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh'
    WHERE p.selected AND p.visibility = 'public' AND p.body_mode = 'full' AND coalesce(a.language, '') <> 'zh'
      AND (p.discovered_at > now() - ${TRANSLATE_WINDOW_DAYS} * interval '1 day'
           OR EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id = a.id AND r.revision = a.revision AND r.revision > 1
                      AND r.created_at > now() - ${TRANSLATE_WINDOW_DAYS} * interval '1 day'))
      AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND (tr.revision < a.revision OR NOT tr.complete)))
      AND NOT EXISTS (SELECT 1 FROM translation_attempts t WHERE t.article_id = p.article_id AND t.revision = a.revision
                      AND (t.outcome IN ('skipped', 'translated') OR t.attempts >= 3))
    ORDER BY p.discovered_at DESC LIMIT ${opts.limit ?? 30}`;
  const done: TranslateResult[] = [];
  // 逐条 await 时这一腿的吞吐由对端墙钟决定（2026-10-16 实测一次 translate_body 调用平均 130 秒
  // ⇒ 一轮 4 分钟只吃得下 1–2 篇，3,123 篇待翻要 6–11 天）。并发的不是"同一篇的分段"而是"篇与篇"，
  // 每篇内部仍是一次一批、批内不并行，所以每条在飞的请求仍各自走闸门与回执；正文平均只有 3–5k 字
  // （>20,000 字的只有 113 条），多开几路多花的是个位数 MB，上限 6 是留给 240 MB worker 的硬顶。
  const conc = translateConcurrency();
  let stop = false;
  let next = 0;
  async function lane() {
    while (!stop && next < rows.length) {
      if (Date.now() - started > (opts.budgetMs ?? 4 * 60_000) || shutdownSignal.signal.aborted) { stop = true; return; }
      const r = rows[next++]!;
      let outcome: "translated" | "partial" | "skipped" | "failed";
      let reason: string | null = null;
      // The attempt is recorded against the revision actually read: when the text was revised while the
      // model was answering, the new revision still has no attempt and is translated on the next run.
      let revision: number | null = null;
      try {
        const result = await translateArticle(r.article_id);
        done.push(result);
        outcome = result.status;
        reason = result.reason ?? null;
        revision = result.revision ?? null;
      } catch (error) {
        // A deploy stops between paid fragments, never aborts a sent request. Received answers stay
        // in receipts and are reused next run; do not mark an interrupted article terminal/partial.
        // 停机、被关掉、没配置、熔断四类停整轮且不计尝试——批次层吞错时问的是同一个判据 stopsTheRun()，
        // 两层不一致就会把"熔断"当成一块坏文本咽下去，整轮继续对着墙死的门敲门。
        if (stopsTheRun(error)) { stop = true; return; }
        const message = (error as Error).message;
        done.push({ articleId: r.article_id, status: "skipped", reason: message.slice(0, 200) });
        outcome = "failed";
        reason = message.slice(0, 300);
      }
      await sql`
        INSERT INTO translation_attempts (article_id, revision, attempts, outcome, reason)
        SELECT ${r.article_id}, coalesce(${revision}::int, a.revision), 1, ${outcome}, ${reason} FROM articles a WHERE a.id = ${r.article_id}
        ON CONFLICT (article_id) DO UPDATE SET
          attempts = CASE WHEN translation_attempts.revision = EXCLUDED.revision THEN translation_attempts.attempts + 1 ELSE 1 END,
          revision = EXCLUDED.revision, outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, updated_at = now()`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, rows.length) }, () => lane()));
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  let quotes = 0;
  const left = budgetMs - (Date.now() - started);
  if (left > 0 && !shutdownSignal.signal.aborted) {
    try {
      quotes = await translateQuotes({ budgetMs: left });
    } catch (error) {
      if (error instanceof TranslationInterruptedError || /disabled|not configured|budget/i.test((error as Error).message)) return { done, quotes };
      throw error;
    }
  }
  return { done, quotes };
}
