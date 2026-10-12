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

export async function sickServices(): Promise<Set<string>> {
  if (health && Date.now() - health.at < 60_000) return health.sick;
  let sick = new Set<string>();
  try {
    // A paid answer can arrive but fail the caller's output gate. Discount only the explicitly
    // rejected current attempt; historical attempts and the billing ledger keep their own meaning.
    const rows = await sql<{ service: string }[]>`
      SELECT a.service FROM receipt_attempts a LEFT JOIN receipts r ON r.id = a.receipt_id
       WHERE a.started_at > now() - interval '10 minutes'
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
    //
    // `usage exceeds frequency limit` is WorkBuddy's own wording (2026-10-12 生产实测：抬到 40/900 后
    // 10 分钟 49 次、退回 30/600 之后今天下午仍在 25 分钟内拒绝 168 次，报文形状
    // `workbuddy rate limited (HTTP 429): {"code":…,"msg":"usage exceeds frequency limit, but don't worry,
    // your usage will resume…"}`). It matched none of the five patterns below, so this rule — the only one
    // that survives the burst/forget cycle — could never bench that door: the pool kept handing it the
    // shards pinned by article id, and after `MAX_OUTPUT_FAILURES` those articles land in `failed` with no
    // Chinese copy at all. That is the same failure mode the comment under `refusesThisStep` documents for
    // `opencode`, reached through the provider's 429 instead of our output gate.
    const refused = await sql<{ service: string }[]>`
      WITH ranked AS (
        SELECT a.service, (a.status = 'failed' AND (a.error LIKE '%free-models-per-day%'
          OR a.error LIKE '%insufficient_quota%' OR a.error LIKE '%exceeded your current quota%'
          OR a.error LIKE '%FreeTierError%' OR a.error LIKE '%今日文本额度已用完%'
          OR a.error LIKE '%usage exceeds frequency limit%')) AS quota_refusal,
               row_number() OVER (PARTITION BY a.service ORDER BY a.started_at DESC, a.id DESC) AS newest
          FROM receipt_attempts a
         WHERE a.started_at > now() - interval '6 hours'
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

/**
 * A door can answer in JSON, on time, and still be unable to do *this step's* copy. That is not "busy" and
 * it is not a provider outage, so neither rule above sees it: our own output gate refuses the answer, which
 * `sickServices` deliberately discounts, so the door keeps its share forever.
 *
 * Measured on production 2026-10-11 over 24 h: `opencode` was refused 660 times on `summarize_article`
 * (「answer refused: answer has no Chinese copy」) against 208 answers, while on prefilter, score and
 * structure it barely was refused at all. Because a member is pinned by a hash of the article id, those 660
 * were not slow items but dead ones: the same article came back to the same door, and after three refusals
 * (`MAX_OUTPUT_FAILURES`) it lands in `failed` with no Chinese title or summary — which is precisely what
 * keeps an item out of the pool and out of the paper.
 *
 * The verdict is per **(model, step)**, not per door. Health and budgets are per door because the provider and
 * its quota are — but the ability to write Chinese copy is a property of one model, and seven registry members
 * share the service `openrouter`. Keyed on the service, one bad model there would bench six siblings; keyed on
 * the model, each answers for itself. The cost of that precision: a provider that is uniformly bad at a step
 * now has to reach the floor once per model rather than once in total.
 *
 * It cannot empty a pool: if every member is refused for a step they all stay eligible, because the retry
 * ladder, not this choice, decides when to stop. It is not a latch either — the window is 24 h of the model's
 * own receipts, and a benched model produces none for that step, so the bench expires by *ageing out*, roughly
 * a day later; it then takes ≥10 fresh refusals to bench again. One accepted reply is not enough to clear 660
 * refusals, and pretending otherwise would make this look self-healing when it is really time-limited.
 */
const MIN_STEP_REFUSALS = 10;

/** Whether these counts say "this model cannot do this step". Exported so the threshold itself is testable. */
export function refusesThisStep(counts: { refused: number; accepted: number }): boolean {
  return counts.refused >= MIN_STEP_REFUSALS && counts.refused > counts.accepted;
}

let stepRefusals: { at: number; pairs: Map<string, { refused: number; accepted: number }> } | null = null;

/** The ledger read costs about a second on production (`receipts` is ~100k rows and the window is 17k of them),
 * so it is cached five minutes rather than the health rule's minute. That is not freshness lost: a day quota
 * reopens on a schedule we do not control, which is why `sickServices` re-decides every minute, while a door
 * that cannot write Chinese copy does not start to in the next four minutes. */
const REFUSAL_CACHE_MS = 300_000;
const REGISTRY_SERVICES = [...new Set(Object.values(MODELS).map((m) => m.service))];

/** Refused-versus-accepted counts for every (model, purpose) the ledger shows in the last 24 hours. */
async function refusalPairs(): Promise<Map<string, { refused: number; accepted: number }>> {
  if (stepRefusals && Date.now() - stepRefusals.at < REFUSAL_CACHE_MS) return stepRefusals.pairs;
  const pairs = new Map<string, { refused: number; accepted: number }>();
  const refused = sql`status = 'failed' AND (error LIKE 'answer refused:%' OR error LIKE 'unusable output:%')`;
  try {
    // `service = ANY(...)`: without it the plan seq-scans all 98,670 rows (14,886 pages, 956 ms measured on
    // production 2026-10-11); with it the same answer comes off receipts_service_time_idx in 3,546 pages.
    // `model IS NOT NULL`: a receipt without the model name cannot accuse one model of anything.
    const rows = await sql<{ model: string; purpose: string; refused: number; accepted: number }[]>`
      SELECT model, purpose,
        count(*) FILTER (WHERE ${refused})::int AS refused,
        count(*) FILTER (WHERE status IN ('received', 'completed'))::int AS accepted
      FROM receipts
      WHERE created_at > now() - interval '24 hours' AND origin = 'live' AND service = ANY(${REGISTRY_SERVICES})
        AND model IS NOT NULL
      GROUP BY 1, 2`;
    for (const r of rows) pairs.set(`${r.model}|${r.purpose}`, { refused: r.refused, accepted: r.accepted });
  } catch {
    // Same rule as the health read: a ledger query that fails must not decide the request.
  }
  stepRefusals = { at: Date.now(), pairs };
  return pairs;
}

/** A capability spends several purposes (report writes a lead and an issue); the model is judged on the sum. */
function stepCounts(pairs: Map<string, { refused: number; accepted: number }>, model: string, capability: CapabilityKey) {
  let refused = 0;
  let accepted = 0;
  for (const purpose of CAPABILITIES[capability].purposes) {
    const counts = pairs.get(`${model}|${purpose}`);
    if (counts) {
      refused += counts.refused;
      accepted += counts.accepted;
    }
  }
  return { refused, accepted };
}

/** Drop the members whose model cannot write this step's copy; keep them all if that would leave nothing. */
export function shedRefusingMembers(members: string[], capability: CapabilityKey, pairs: Map<string, { refused: number; accepted: number }>): string[] {
  const kept = members.filter((m) => !refusesThisStep(stepCounts(pairs, MODELS[m]!.model ?? "", capability)));
  return kept.length ? kept : members;
}

export function invalidateModelCache() {
  cache = null;
  health = null;
  stepRefusals = null;
}

/** The model a capability uses now: admin switch, else its own environment, else `MODEL_POOL`, else the code
 * default. `shardKey` is the id of the thing being processed — pass nothing only when there is no such id.
 *
 * A pool skips services that are failing right now (see `sickServices`) and members that cannot write this
 * step's copy (see `refusesThisStep`), but never empties: if every member is down the choice falls back to
 * the full list, because the budget breaker and the retry ladder — not this function — decide when to stop trying. */
export async function modelFor(capability: CapabilityKey, shardKey?: string): Promise<string> {
  const c: Capability = CAPABILITIES[capability];
  const chosen = (await overrides())[capability] ?? process.env[c.env] ?? process.env.MODEL_POOL ?? c.default;
  const listed = membersFor(chosen, capability);
  if (poolOf(chosen).length <= 1) return pickMember(listed, shardKey) || c.default;
  return pickMember(await servingMembers(listed, capability), shardKey) || c.default;
}

/**
 * Who can actually answer this step, in the order they were listed: skip the services that are failing right
 * now (see `sickServices`), then skip the members that cannot write *this step's* copy (see `refusesThisStep`),
 * and never empty — if every member is out, the list stands, because the budget breaker and the retry ladder,
 * not this choice, decide when to stop trying.
 *
 * `modelFor` and `modelSources` must run exactly this: the admin panel that says who serves is the one place an
 * operator looks when routing looks wrong, and two copies of the rule would let them disagree.
 * (`budgetFallbackModelsForPurpose` deliberately does NOT share it: it answers "who may carry an unsent
 * request", so it is allowed to answer *nobody* — no capability entry for the purpose, or a pool of one.
 * Inside those candidates the same never-empty refusal-shed still applies, so it is not "no shedding",
 * it is "no substitute for the configured pool".)
 */
async function servingMembers(listed: string[], capability: CapabilityKey): Promise<string[]> {
  const sick = await sickServices();
  const healthy = listed.filter((m) => !sick.has(MODELS[m]!.service));
  return shedRefusingMembers(healthy.length ? healthy : listed, capability, await refusalPairs());
}

/** Which capability a purpose is charged to — the one place the `purposes` lists get searched.
 * Both fallback selectors need it, and a third copy would be a third answer for a renamed purpose. */
function capabilityForPurpose(purpose: string): [CapabilityKey, Capability] | undefined {
  return (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>)
    .find(([, c]) => c.purposes.includes(purpose));
}

/** Recovery considers only the currently configured pool, including unhealthy members whose answer
 * may already have arrived. An explicit model outside that pool keeps its own receipt identity. */
export async function recoveryModelsForPurpose(purpose: string, selected: string): Promise<string[]> {
  const entry = capabilityForPurpose(purpose);
  if (!entry) return [selected];
  const [capability, c] = entry;
  const configured = (await overrides())[capability] ?? process.env[c.env] ?? process.env.MODEL_POOL ?? c.default;
  const members = poolOf(configured);
  return members.includes(selected) ? [...new Set(members)] : [selected];
}

/** Only configured, healthy members able to accept this capability may carry an unsent request whose
 * original service is locally budget-blocked. Cached recovery keeps its broader exact-key candidate set. */
export async function budgetFallbackModelsForPurpose(purpose: string, selected: string, requireVision = false): Promise<string[]> {
  const entry = capabilityForPurpose(purpose);
  if (!entry) return [];
  const members = await recoveryModelsForPurpose(purpose, selected);
  if (members.length <= 1) return [];
  const sick = await sickServices();
  const pairs = await refusalPairs();
  const index = members.indexOf(selected);
  const ordered = [...members.slice(index + 1), ...members.slice(0, index)];
  const candidates = ordered.filter((name) => usable(name, entry[0]) && !sick.has(MODELS[name]!.service)
    && (!requireVision || MODELS[name]!.vision === true));
  // A door that cannot write this step's copy is not a fallback; if that leaves nothing, the candidates stand.
  return shedRefusingMembers(candidates, entry[0], pairs);
}

/** Where the current choice comes from, for the admin page. `model` is what was configured and `serving`
 * what can actually answer, so a pool with a member whose key is missing cannot be shown as full capacity. */
export async function modelSources(): Promise<Record<string, { model: string; serving: string; source: "admin" | "env" | "default" }>> {
  const o = await overrides();
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
    const serving = await servingMembers(membersFor(configured.model, key as CapabilityKey), key as CapabilityKey);
    // The empty case is reachable and is not dead code: `poolOf()` drops names that aren't in the registry,
    // so an admin value or MODEL_POOL that lists only typos yields `listed = []` — and `servingMembers()`
    // is never-empty *relative to its input*, so an empty input stays empty. Show what was configured there,
    // because a blank cell would read as "this capability has no model" rather than "the name is wrong".
    out[key] = { ...configured, serving: serving.length ? serving.join(",") : configured.model };
  }
  return out;
}
