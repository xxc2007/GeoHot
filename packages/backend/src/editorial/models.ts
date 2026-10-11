// Model per capability: the code default (`default`, the deployment's own model), an environment
// override, and an admin switch kept in settings (every switch is audited). Read at call time and
// cached for a minute, so a switch applies to the next call without a restart; a changed model only
// affects work done from then on (history is not re-judged).
//
// A capability may name a **pool** — `MODEL_POOL=default,agnes-3.0-flash-cn`, or the same list on one
// step's own variable. Work is then spread across the members by a hash of the shard key, which is the id
// of the thing being processed (an article id, a story id, an issue key).
//
// Two properties decide that choice, and they are why it is a hash of the id rather than round-robin:
//
//  - The receipts cache keys on service, purpose, model and the request's own identity — **not** on the
//    subject (receipts.ts:logicalKeyFor). So the model must be a function of something that stays put
//    while the request stays the same. An id does; a revision does not, because the prompts truncate the
//    body (input.ts caps it at 7,000 characters) — a revision can bump on a change the model never sees,
//    and if the shard key moved with it, half those articles would be handed to the *other* endpoint to
//    re-judge byte-identical words, for a second, different answer.
//  - "Why did this item get this score" has to stay answerable a week later, which round-robin cannot do.
//
// Members that cannot serve are dropped from the pool rather than chosen and failed: an unconfigured key,
// or a model with no JSON mode on a step that parses JSON. A pool is a way to spend more capacity, not a
// way to make work fail loudly. A single explicit model is NOT filtered that way — naming one model and
// having it silently substituted would be worse than the error.
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { MODELS } from "../providers/llm.ts";

export interface Capability {
  label: string;
  env: string;
  default: string;
  /** Receipt purposes this capability produces (for the admin statistics). */
  purposes: string[];
  vision?: boolean;
  /** The step asks the model for plain text instead of a JSON object, so a JSON-mode-only service is fine. */
  freeText?: boolean;
}

export const CAPABILITIES = {
  prefilter: { label: "精选预筛（是否属于这个行业，宽召回）", env: "PREFILTER_MODEL", default: "default", purposes: ["prefilter_article"] },
  score: { label: "精选评分（两次独立评分，按信源分级门槛）", env: "SCORE_MODEL", default: "default", purposes: ["score_article"] },
  understand: { label: "内容理解（入选和接近入选的标题、摘要、推荐理由、标签，能看图时看首图）", env: "UNDERSTAND_MODEL", default: "default", purposes: ["understand_article"] },
  summarize: { label: "标题摘要（其余文章的中文标题与摘要）", env: "SUMMARIZE_MODEL", default: "default", purposes: ["summarize_article"], freeText: true },
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

/** A name the registry actually carries. `Object.hasOwn` and not `MODELS[name] !== undefined`:
 * `constructor`, `__proto__` and `toString` are all "not undefined" on a plain object, and one of those
 * reaching `chatJson` means a `service` of `undefined`, which matches no budgets row — and no budgets row
 * means no circuit breaker at all (receipts.ts returns early). */
const known = (name: string) => Object.hasOwn(MODELS, name);

/** Split a configured value into the model names it lists, dropping anything not in the registry. */
export function poolOf(configured: string): string[] {
  return configured.split(",").map((s) => s.trim()).filter(known);
}

/** Whether this member can actually answer this capability: credentials present, and able to reply in the
 * shape the step parses. */
function usable(name: string, capability: CapabilityKey): boolean {
  const spec = MODELS[name]!;
  const c: Capability = CAPABILITIES[capability];
  if (spec.jsonMode === false && !c.freeText) return false;
  return !!credential("models", spec.baseUrlEnv) && !!credential("models", spec.apiKeyEnv) && !!spec.model;
}

/** The members a capability may use right now. A pool sheds what cannot serve; a single named model is kept
 * as is, so a missing key shows up as its own error instead of a silent substitution. */
export function membersFor(configured: string, capability: CapabilityKey): string[] {
  const listed = poolOf(configured);
  if (listed.length <= 1) return listed;
  return listed.filter((m) => usable(m, capability));
}

/**
 * Which member handles this piece of work. Deterministic in `shardKey`: the same article id always reaches
 * the same model, so a retry or a re-analysis reuses that model's cached answer instead of paying a second
 * model to re-judge identical words.
 */
function pickMember(members: string[], shardKey?: string): string {
  if (members.length === 0) return "";
  if (members.length === 1 || !shardKey) return members[0]!;
  // sha256 rather than a String#hashCode-style loop: the distribution over 2-3 members has to be even
  // whatever shape the ids have, and these ids are base32-ish snowflakes.
  const digest = sha256(`${shardKey}`);
  return members[Number.parseInt(digest.slice(0, 8), 16) % members.length]!;
}

/** The same choice for a configured value that lists no capability, so tests and tools can ask it directly. */
export function pickFromPool(configured: string, shardKey?: string): string {
  return pickMember(poolOf(configured), shardKey);
}

async function overrides(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.overrides;
  const rows = await sql<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const map: Record<string, string> = {};
  // The admin stores one model per capability (switchModel rejects a comma list), so anything else in the
  // settings table is not ours to interpret and is ignored rather than half-applied.
  for (const r of rows) {
    const value = r.value?.model ?? "";
    if (known(value)) map[r.key.slice("models.".length)] = value;
  }
  cache = { at: Date.now(), overrides: map };
  return map;
}

/**
 * Which provider services are failing right now, so a pool stops picking them for a while.
 *
 * Measured 2026-10-10: with four members named, one of them (Agnes 国内版) hit its daily text quota and
 * answered 429 to nearly everything — 1,051 failed attempts in three hours against 112 answers from the
 * other doors. Because a member is chosen by a hash of the article id, that was not a slow quarter of the
 * work but a *dead* quarter of it: those items never reached a model, and the archive band advanced nine
 * items an hour while the two healthy doors sat under-used.
 *
 * Reads what the pipeline already writes (`receipt_attempts`) instead of keeping new state. The rule is a
 * **rate**, not a streak: six or more attempts in ten minutes with *fewer than half answered*. A streak rule
 * is not enough here — a door throttled to one request a minute (which is exactly what the quota exhaustion
 * degrades to) answers often enough to look alive while three of every four calls still fail. Half is the
 * line that says "this member is a worse bet than its peers"; anything above it is "busy, not broken".
 * A door that is merely busy keeps its place, and if every member is below the line the pool still uses them
 * all, because the budget breaker and the retry ladder — not this choice — decide when to stop.
 *
 * That rate only sees ten minutes, so a second rule reads what the door actually *said*: its six newest live
 * attempts (over six hours) all being quota refusals. The shapes are copied from production
 * `receipt_attempts.error` on 2026-10-11 — OpenRouter's `free-models-per-day` day cap, Agnes 国内版's
 * 「今日文本额度已用完，当前处于限速模式：每 1 分钟可请求 1 次」, OpenCode's `FreeTierError`, and the two
 * OpenAI-compatible quota messages. Our own breaker messages (`Budget for dots exhausted (day)`) deliberately
 * do NOT match: that window reopens on a schedule we control, and benching the provider for it would hide a
 * perfectly healthy door. Nor can this rule deadlock: the moment the provider answers once, that answer is
 * among the six newest and the door is a candidate again.
 */
let health: { at: number; sick: Set<string> } | null = null;

/**
 * Every service the registry can hand a call to. Both health queries below are bounded by it, which is not a
 * narrowing: the returned set is only ever read as `sick.has(MODELS[name].service)`, so a service outside the
 * registry could never be bench-able. It is what lets either query use `receipt_attempts_service_time_idx` —
 * without a leading `service` predicate both are a sequential scan of a table with no retention job (measured
 * 2026-10-11 on production: 99,094 rows / 52 MB, and the cache re-runs them every sixty seconds).
 */
const REGISTRY_SERVICES = [...new Set(Object.values(MODELS).map((m) => m.service))];

export async function sickServices(): Promise<Set<string>> {
  if (health && Date.now() - health.at < 60_000) return health.sick;
  let sick = new Set<string>();
  try {
    // A paid answer can arrive but fail the caller's output gate. Discount only the explicitly
    // rejected current attempt; historical attempts and the billing ledger keep their own meaning.
    const rows = await sql<{ service: string }[]>`
      SELECT a.service FROM receipt_attempts a LEFT JOIN receipts r ON r.id = a.receipt_id
       WHERE a.started_at > now() - interval '10 minutes'
         AND a.service = ANY(${REGISTRY_SERVICES}::text[])
         AND a.origin = 'live' AND a.status IN ('received', 'failed', 'unknown')
       GROUP BY a.service
      HAVING count(*) >= 6 AND count(*) FILTER (WHERE a.status = 'received' AND NOT coalesce(
        r.status = 'failed' AND a.attempt = r.attempts
        AND (r.error LIKE 'answer refused:%' OR r.error LIKE 'unusable output:%'), false
      )) * 2 < count(*)`;
    sick = new Set(rows.map((r) => r.service));
    // The burst/forget cycle the rule above closes: measured 2026-10-11, OpenRouter was refused 37 times in
    // half an hour and answered nothing, yet at 07:36 the verdict was `sick=[]` — during a burst the door
    // fails and is benched, then nobody calls it, its failures age out of the ten-minute window, and the very
    // next article is handed to it again. A day quota does not reopen in sixty seconds.
    const refused = await sql<{ service: string }[]>`
      WITH ranked AS (
        SELECT a.service, (a.status = 'failed' AND (a.error LIKE '%free-models-per-day%'
          OR a.error LIKE '%insufficient_quota%' OR a.error LIKE '%exceeded your current quota%'
          OR a.error LIKE '%FreeTierError%' OR a.error LIKE '%今日文本额度已用完%')) AS quota_refusal,
               row_number() OVER (PARTITION BY a.service ORDER BY a.started_at DESC, a.id DESC) AS newest
          FROM receipt_attempts a
         WHERE a.started_at > now() - interval '6 hours'
           AND a.service = ANY(${REGISTRY_SERVICES}::text[])
           AND a.origin = 'live' AND a.status IN ('received', 'failed', 'unknown')
      )
      SELECT service FROM ranked WHERE newest <= 6 GROUP BY service
        HAVING count(*) = 6 AND count(*) FILTER (WHERE quota_refusal) = 6`;
    for (const r of refused) sick.add(r.service);
  } catch {
    // Reading the ledger must never decide the request. If the rate rule could not run, no door is benched;
    // if only the quota rule failed, the rate verdict above still stands (throwing it away would re-open the
    // burst/forget cycle the second rule exists to close). Neither case means "all providers are down".
  }
  health = { at: Date.now(), sick };
  return sick;
}

export function invalidateModelCache() {
  cache = null;
  health = null;
}

/** The model a capability uses now: admin switch, else its own environment, else `MODEL_POOL`, else the code
 * default. `shardKey` is the id of the thing being processed — pass nothing only when there is no such id.
 *
 * A pool skips services that are failing right now (see `sickServices`), but never empties: if every member
 * is down the choice falls back to the full list, because the budget breaker and the retry ladder — not this
 * function — decide when to stop trying. */
export async function modelFor(capability: CapabilityKey, shardKey?: string): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const chosen = (await overrides())[capability] ?? process.env[c.env] ?? process.env.MODEL_POOL ?? c.default;
  const listed = membersFor(chosen, capability);
  if (poolOf(chosen).length <= 1) return pickMember(listed, shardKey) || c.default;
  const sick = await sickServices();
  const healthy = listed.filter((m) => !sick.has(MODELS[m]!.service));
  return pickMember(healthy.length ? healthy : listed, shardKey) || c.default;
}

/** Recovery considers only the currently configured pool, including unhealthy members whose answer
 * may already have arrived. An explicit model outside that pool keeps its own receipt identity. */
export async function recoveryModelsForPurpose(purpose: string, selected: string): Promise<string[]> {
  const entry = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>)
    .find(([, c]) => c.purposes.includes(purpose));
  if (!entry) return [selected];
  const [capability, c] = entry;
  const configured = (await overrides())[capability] ?? process.env[c.env] ?? process.env.MODEL_POOL ?? c.default;
  const members = poolOf(configured);
  return members.includes(selected) ? [...new Set(members)] : [selected];
}

/** Only configured, healthy members able to accept this capability may carry an unsent request whose
 * original service is locally budget-blocked. Cached recovery keeps its broader exact-key candidate set. */
export async function budgetFallbackModelsForPurpose(purpose: string, selected: string, requireVision = false): Promise<string[]> {
  const entry = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>)
    .find(([, c]) => c.purposes.includes(purpose));
  if (!entry) return [];
  const members = await recoveryModelsForPurpose(purpose, selected);
  if (members.length <= 1) return [];
  const sick = await sickServices();
  const index = members.indexOf(selected);
  const ordered = [...members.slice(index + 1), ...members.slice(0, index)];
  return ordered.filter((name) => usable(name, entry[0]) && !sick.has(MODELS[name]!.service)
    && (!requireVision || MODELS[name]!.vision === true));
}

/** Where the current choice comes from, for the admin page. `model` is what was configured and `serving`
 * what can actually answer, so a pool with a member whose key is missing cannot be shown as full capacity. */
export async function modelSources(): Promise<Record<string, { model: string; serving: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides();
  const sick = await sickServices();
  const out: Record<string, { model: string; serving: string; source: "admin" | "env" | "default" }> = {};
  for (const [key, c] of Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>) {
    const configured = o[key]
      ? { model: o[key]!, source: "admin" as const }
      : process.env[c.env] && poolOf(process.env[c.env]!).length > 0
        ? { model: process.env[c.env]!, source: "env" as const }
        : process.env.MODEL_POOL && poolOf(process.env.MODEL_POOL).length > 0
          ? { model: process.env.MODEL_POOL, source: "env" as const }
          : { model: c.default, source: "default" as const };
    // Names listed but dropped are the difference the operator needs to see — including the ones dropped
    // because they are failing right now, so the panel and `modelFor` never disagree about who serves.
    const listed = membersFor(configured.model, key as CapabilityKey);
    const healthy = listed.filter((m) => !sick.has(MODELS[m]!.service));
    const serving = healthy.length ? healthy : listed;
    out[key] = { ...configured, serving: serving.length ? serving.join(",") : configured.model };
  }
  return out;
}
