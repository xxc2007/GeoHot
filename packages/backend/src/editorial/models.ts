// Model per capability: the code default (`default`, the deployment's own model), an environment
// override, and an admin switch kept in settings (every switch is audited). Read at call time and
// cached for a minute, so a switch applies to the next call without a restart; a changed model only
// affects work done from then on (history is not re-judged).
//
// A capability may name a **pool** — `default,agnes-3.0-flash-cn`. Work is then spread across the
// members by a hash of the shard key, which is always the thing being processed (an article id, a story
// id). Hash-of-key rather than round-robin for one reason: a retry, a re-analysis after a correction, or
// a manual re-run must land on the same model that answered the first time, or the receipts cache
// (keyed by service, purpose, model and inputs — receipts.ts:logicalKeyFor) misses and the article gets a
// second, different judgement for the same words. Round-robin would also make "why did this item get this
// score" unanswerable a week later.
//
// Callers pass the receipt `subject` as the shard key — that string is already the name of the work unit.
// Two sites pass something coarser on purpose: a translated body shards per article rather than per batch
// (one article, one prose style), and a story digest per event rather than per revision (one event, one voice).
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { MODELS } from "../providers/llm.ts";

export interface Capability {
  label: string;
  env: string;
  default: string;
  /** Receipt purposes this capability produces (for the admin statistics). */
  purposes: string[];
  vision?: boolean;
}

export const CAPABILITIES = {
  prefilter: { label: "精选预筛（是否属于这个行业，宽召回）", env: "PREFILTER_MODEL", default: "default", purposes: ["prefilter_article"] },
  score: { label: "精选评分（两次独立评分，按信源分级门槛）", env: "SCORE_MODEL", default: "default", purposes: ["score_article"] },
  understand: { label: "内容理解（入选和接近入选的标题、摘要、推荐理由、标签，能看图时看首图）", env: "UNDERSTAND_MODEL", default: "default", purposes: ["understand_article"] },
  summarize: { label: "标题摘要（其余文章的中文标题与摘要）", env: "SUMMARIZE_MODEL", default: "default", purposes: ["summarize_article"] },
  structure: { label: "结构抽取（分类、标签、主体公司、事件事实，不写读者文字）", env: "STRUCTURE_MODEL", default: "default", purposes: ["structure_article"] },
  group: { label: "事件归组（新报道与候选事实的关系：同一次发生、同一事件的进展、无关；被同一篇报道连起来的两个事件是否同一事件）", env: "GROUP_MODEL", default: "default", purposes: ["group_article", "group_signal", "group_story"] },
  groupReview: { label: "归组复核（相似度不高的合并、两个事件的合并，写入前再读一遍；最好换一家模型）", env: "GROUP_REVIEW_MODEL", default: "default", purposes: ["group_review", "group_story_review"] },
  digest: { label: "事件综述", env: "DIGEST_MODEL", default: "default", purposes: ["story_digest"] },
  report: { label: "日报、周报、月报", env: "REPORT_MODEL", default: "default", purposes: ["report_lead", "report_daily", "report_weekly", "report_monthly"] },
  translate: { label: "精选全文翻译（含引用帖）", env: "TRANSLATE_MODEL", default: "default", purposes: ["translate_body", "translate_quoted"] },
  monitor: { label: "Codex 重置公告识别", env: "MONITOR_MODEL", default: "default", purposes: ["monitor.recognize", "monitor.context"] },
} satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;

let cache: { at: number; overrides: Record<string, string> } | null = null;

/** Split a capability's configured value into the pool of models it names, dropping unknown names. */
export function poolOf(configured: string): string[] {
  return configured.split(",").map((s) => s.trim()).filter((s) => MODELS[s] !== undefined);
}

/**
 * Which pool member handles this piece of work. Deterministic in `shardKey`: the same article id always
 * reaches the same model, so a retry or a re-analysis reuses that model's cached answer instead of
 * asking a second model to re-judge identical words.
 */
export function pickFromPool(configured: string, shardKey?: string): string {
  const members = poolOf(configured);
  if (members.length === 0) return "";
  if (members.length === 1 || !shardKey) return members[0]!;
  // sha256 rather than String#hashCode-style loops: the distribution over 2-3 members has to be even
  // whatever shape the ids have, and these ids are base32-ish snowflakes.
  const digest = sha256(`${shardKey}`);
  return members[Number.parseInt(digest.slice(0, 8), 16) % members.length]!;
}

async function overrides(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.overrides;
  const rows = await sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const map: Record<string, string> = {};
  for (const r of rows) {
    const value = r.value?.model ?? "";
    // The admin stores a pool the same way the environment does, so accept a comma list here too —
    // but only when *every* named member exists, or a typo would silently drop half the pool.
    if (value && poolOf(value).length === value.split(",").filter((s) => s.trim()).length) map[r.key.slice("models.".length)] = value;
  }
  cache = { at: Date.now(), overrides: map };
  return map;
}

export function invalidateModelCache() {
  cache = null;
}

/** The model a capability uses now: admin switch, else environment, else the code default. */
export async function modelFor(capability: CapabilityKey, shardKey?: string): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const chosen = (await overrides())[capability] ?? process.env[c.env] ?? c.default;
  return pickFromPool(chosen, shardKey) || c.default;
}

/** Where the current choice comes from, for the admin page. */
export async function modelSources(): Promise<Record<string, { model: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides();
  const out: Record<string, { model: string; source: "admin" | "env" | "default" }> = {};
  for (const [key, c] of Object.entries(CAPABILITIES) as Array<[string, Capability]>) {
    if (o[key]) out[key] = { model: o[key]!, source: "admin" };
    else if (process.env[c.env] && poolOf(process.env[c.env]!).length > 0) out[key] = { model: process.env[c.env]!, source: "env" };
    else out[key] = { model: c.default, source: "default" };
  }
  return out;
}
