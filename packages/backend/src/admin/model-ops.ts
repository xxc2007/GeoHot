// Live operations board for the model layer: what is being called right now, how it is doing, and which
// pool each capability is drawing from. Read-only; writes live in `setCapabilityPool` (admin/models.ts).
//
// 2026-11-26 站长要求把「运行看板」按 magpie 的用量面板重做：筛选栏、Token/请求/费用/缓存命中率/
// 输出速度指标卡、可切换维度的堆叠柱状图、模型速度表。数据源从 receipts 换成派生读模型
// admin_model_attempt_metrics —— 只有它同时带 tokens_in/tokens_out/tokens_cached/tokens_reasoning
// 与 latency_ms，receipts.usage 的键名随上游变化，算不出速度与缓存命中。
import { sql } from "../db.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { modelCooldown } from "../operations/model-cooldown.ts";
import { normalizeWindow, windowSpec, type OpsWindow } from "./ops-window.ts";

export { normalizeWindow };
export type { OpsWindow };

export type ModelOpsRow = {
  service: string;
  model: string;
  calls: number;
  ok: number;
  bad: number;
  pending: number;
  unknown: number;
  avgMs: number;
  maxMs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  /** 输出速度的分子/分母（token / 毫秒），只累计两者都已知的调用。 */
  speedOut: number;
  speedMs: number;
  cost: number;
  costCalls: number;
};

export type ModelOpsTotals = {
  calls: number;
  ok: number;
  bad: number;
  pending: number;
  unknown: number;
  avgMs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  /** 输出速度 = 已知输出 token / 已知耗时，单位 token/秒。没有样本时为 null。 */
  speed: number | null;
  /** 缓存命中率 = 缓存 token / 输入 token，只统计上游确实报告过缓存的调用。 */
  cacheHit: number | null;
  cacheCalls: number;
  cost: number | null;
  costCalls: number;
};

export type ModelOps = {
  at: string;
  /** 当前口径（今天 / 7 天 / 全部），前端高亮用的就是它。 */
  windowKey: OpsWindow;
  /** 该口径折成的分钟数：「今天」是从零点到现在，「全部」是 0（无下界）。 */
  windowMinutes: number;
  filters: { purpose: string; service: string; model: string; status: string; dimension: Dimension };
  bucketMinutes: number;
  totals: ModelOpsTotals;
  models: ModelOpsRow[];
  series: { bucket: string; parts: { key: string; calls: number }[] }[];
  seriesKeys: string[];
  options: { purposes: string[]; services: string[]; models: string[]; statuses: string[] };
  queue: { state: string; n: number }[];
  active: { name: string; n: number }[];
  heartbeats: { key: string; role: string; at: string | null; load: number | null }[];
  capabilities: { key: string; label: string; source: "admin" | "env" | "default"; members: string[]; vision: boolean }[];
  catalog: { key: string; service: string; vision: boolean; jsonMode: boolean }[];
  /** 信息工作流的各环节：队列深度 + 该环节驱动的模型调用。站长 2026-11-27 要求实时看到。 */
  workflow: { stages: OpsStage[]; unmapped: OpsStage | null };
  /** 进程内冷却账本快照（上游拒绝后的短时冷却），按 model 索引到环节里。 */
  cooldowns: Array<{ model: string; service: string; category: string; until: number }>;
  /**
   * 注册表里 `default` 那一条解析出来的真实模型名。池里写的是注册表 key（`default`），
   * 回执记的是上游模型名（`agnes-3.0-flash`）——不把两者对上，环节表会显示「池内 —」。
   */
  defaultModel: string;
};

/** 一个工作流环节的实时数据：队列那一侧 + 模型那一侧。 */
export type OpsStage = {
  key: string;
  label: string;
  queue: string | null;
  purposes: string[];
  serving: string;
  source: "admin" | "env" | "default";
  pool: string[];
  /** 上面这个池属于哪个能力（一个环节可能覆盖多个，这里给首个；明细里的位次跨全部池取最靠前）。 */
  poolFor: string;
  queued: number;
  active: number;
  retry: number;
  done: number;
  failed24h: number;
  lastDone: string | null;
  lastFailed: string | null;
  totals: ModelOpsTotals;
  models: Array<ModelOpsRow & { poolRank: number | null; cooling: string | null }>;
};

/**
 * 环节清单。model 那一侧的用途来自 CAPABILITIES；队列那一侧是真实跑批的 pg-boss 名字
 * （2026-11-27 在生产库读过一遍：sources.fetch / content.extract-body / content.analyze /
 * events.group / events.digest / cron.content.translate / content.english / media.prepare）。
 * 采集、正文抽取、配图不走模型，所以 capabilities 为空——它们照样要出现在环节表里，
 * 因为读者看到的内容断在哪一环，得从这张表上读得出。
 * 日报/周报/月报由定时任务直接触发，没有常驻队列。
 */
const PIPELINE: Array<{ key: string; label: string; queue: string | null; capabilities: string[] }> = [
  { key: "fetch", label: "采集（RSS / 搜索源轮询）", queue: "sources.fetch", capabilities: [] },
  { key: "extract", label: "正文抽取", queue: "content.extract-body", capabilities: [] },
  { key: "analyze", label: "分析（预筛 → 评分 → 理解 → 结构 → 摘要）", queue: "content.analyze", capabilities: ["prefilter", "score", "understand", "structure", "summarize"] },
  { key: "group", label: "事件归组与复核", queue: "events.group", capabilities: ["group", "groupReview"] },
  { key: "digest", label: "事件综述", queue: "events.digest", capabilities: ["digest"] },
  { key: "translate", label: "全文翻译", queue: "cron.content.translate", capabilities: ["translate"] },
  { key: "english", label: "英文稿", queue: "content.english", capabilities: ["english"] },
  { key: "media", label: "配图（媒体预处理）", queue: "media.prepare", capabilities: [] },
  { key: "report", label: "日报 / 周报 / 月报", queue: null, capabilities: ["report"] },
];

type StatRow = {
  purpose: string | null;
  service: string;
  model: string;
  calls: number;
  ok: number;
  bad: number;
  pending: number;
  unknown: number;
  avgMs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  speedOut: number;
  speedMs: number;
  cost: number;
  costCalls: number;
  lastCall: string | null;
};

const emptyTotals = (): ModelOpsTotals => ({
  calls: 0, ok: 0, bad: 0, pending: 0, unknown: 0, avgMs: 0,
  tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0,
  speed: null, cacheHit: null, cacheCalls: 0, cost: null, costCalls: 0,
});

/** Fold one row into a stage's totals. */
function accumulate(t: ModelOpsTotals, r: StatRow) {
  t.calls += r.calls;
  t.ok += r.ok;
  t.bad += r.bad;
  t.pending += r.pending;
  t.unknown += r.unknown;
  t.tokensIn += r.tokensIn;
  t.tokensOut += r.tokensOut;
  t.tokensCached += r.tokensCached;
  t.tokensReasoning += r.tokensReasoning;
  // 平均值不能相加：先用加权和攒着，最后统一算。
  const acc = t as unknown as { _latSum: number; _latN: number; _speedOut: number; _speedMs: number; _cacheIn: number; _cacheN: number };
  acc._latSum = (acc._latSum ?? 0) + r.avgMs * r.calls;
  acc._latN = (acc._latN ?? 0) + r.calls;
  acc._speedOut = (acc._speedOut ?? 0) + r.speedOut;
  acc._speedMs = (acc._speedMs ?? 0) + r.speedMs;
  acc._cacheIn = (acc._cacheIn ?? 0) + (r.tokensCached > 0 ? r.tokensIn : 0);
  acc._cacheN = (acc._cacheN ?? 0) + (r.tokensCached > 0 ? 1 : 0);
  if (r.costCalls > 0) t.cost = (t.cost ?? 0) + r.cost;
  t.costCalls += r.costCalls;
}

/** Turn the accumulated sums into the reported figures. */
function settle(t: ModelOpsTotals) {
  const acc = t as unknown as Record<string, number> & { _latSum: number; _latN: number; _speedOut: number; _speedMs: number; _cacheIn: number };
  t.avgMs = acc._latN ? Math.round(acc._latSum / acc._latN) : 0;
  t.speed = acc._speedMs > 0 ? acc._speedOut / (acc._speedMs / 1000) : null;
  t.cacheHit = acc._cacheIn > 0 ? t.tokensCached / acc._cacheIn : null;
  // 中间量不进载荷：它们只是折叠过程的草稿。
  for (const k of ["_latSum", "_latN", "_speedOut", "_speedMs", "_cacheIn", "_cacheN"]) delete acc[k];
  return t;
}

export type Dimension = "model" | "service" | "purpose";
export type OpsFilters = { purpose?: string; service?: string; model?: string; status?: string; dimension?: Dimension };

/** Per-capability pool: admin override wins, then the capability's own env, then MODEL_POOL. */
async function capabilityPools() {
  const overrides = new Map<string, string>();
  try {
    const rows = await sql<{ key: string; value: { model?: string } }[]>`
      SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
    for (const row of rows) {
      const value = row.value?.model;
      if (typeof value === "string" && value.trim()) overrides.set(row.key.slice("models.".length), value.trim());
    }
  } catch {
    // The board is diagnostic: if settings cannot be read, show env values rather than nothing.
  }
  return Object.entries(CAPABILITIES).map(([key, c]) => {
    const admin = overrides.get(key);
    const env = process.env[(c as { env: string }).env];
    const raw = admin ?? env ?? process.env.MODEL_POOL ?? "";
    const source: "admin" | "env" | "default" = admin ? "admin" : env ? "env" : "default";
    const members = raw.split(",").map((m) => m.trim()).filter(Boolean);
    return { key, label: (c as { label: string }).label, source, members, vision: !!(c as { vision?: boolean }).vision };
  });
}

/** Bucket width for the stacked chart lives in `windowSpec`: one bar per hour today, per 6h for a week. */
const DIMENSION_COLUMN: Record<Dimension, "model" | "service" | "purpose"> = {
  model: "model",
  service: "service",
  purpose: "purpose",
};

export async function loadModelOps(windowKey: string | number = "today", filters: OpsFilters = {}): Promise<ModelOps> {
  const key = normalizeWindow(windowKey);
  const spec = windowSpec(key);
  const since = spec.since;
  const window = spec.minutes;
  const purpose = (filters.purpose ?? "").slice(0, 80);
  const service = (filters.service ?? "").slice(0, 80);
  const model = (filters.model ?? "").slice(0, 200);
  const status = (filters.status ?? "").slice(0, 40);
  const dimension: Dimension = filters.dimension === "service" || filters.dimension === "purpose" ? filters.dimension : "model";
  const bucketMinutes = spec.bucket;
  const bucketInterval = `${bucketMinutes} minutes`;

  // One scope predicate, applied identically to every read so the cards, the chart and the table agree.
  const scope = sql`origin = 'live' AND started_at > ${since}
    AND (${purpose} = '' OR purpose = ${purpose})
    AND (${service} = '' OR service = ${service})
    AND (${model} = '' OR coalesce(model, '-') = ${model})
    AND (${status} = '' OR status = ${status})`;

  const perModel = sql`
    SELECT coalesce(service, '-') AS service,
           coalesce(model, '-') AS model,
           count(*)::int AS calls,
           count(*) FILTER (WHERE status = 'received')::int AS ok,
           count(*) FILTER (WHERE status = 'failed')::int AS bad,
           count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
           coalesce(round(avg(latency_ms)), 0)::int AS "avgMs",
           coalesce(max(latency_ms), 0)::int AS "maxMs",
           coalesce(sum(tokens_in), 0)::float8 AS "tokensIn",
           coalesce(sum(tokens_out), 0)::float8 AS "tokensOut",
           coalesce(sum(tokens_cached), 0)::float8 AS "tokensCached",
           coalesce(sum(tokens_reasoning), 0)::float8 AS "tokensReasoning",
           -- 速度必须用「输出 token 和 / 耗时和」：拿总 token 除以平均耗时会把上千次调用
           -- 摊成一次，算出几万 tok/s 的假数（2026-11-27 看板上一眼看出的错）。
           coalesce(sum(tokens_out) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedOut",
           coalesce(sum(latency_ms) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedMs",
           coalesce(sum(cost) FILTER (WHERE cost_basis = 'actual'), 0)::float8 AS cost,
           count(cost)::int AS "costCalls"
      FROM admin_model_attempt_metrics
     WHERE ${scope}
     GROUP BY service, model
     ORDER BY calls DESC
     LIMIT 40`;

  const totals = sql`
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE status = 'received')::int AS ok,
           count(*) FILTER (WHERE status = 'failed')::int AS bad,
           count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
           coalesce(round(avg(latency_ms)), 0)::int AS "avgMs",
           coalesce(sum(tokens_in), 0)::float8 AS "tokensIn",
           coalesce(sum(tokens_out), 0)::float8 AS "tokensOut",
           coalesce(sum(tokens_cached), 0)::float8 AS "tokensCached",
           coalesce(sum(tokens_reasoning), 0)::float8 AS "tokensReasoning",
           coalesce(sum(tokens_out) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedOut",
           coalesce(sum(latency_ms) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedMs",
           count(*) FILTER (WHERE tokens_cached IS NOT NULL)::int AS "cacheCalls",
           coalesce(sum(tokens_in) FILTER (WHERE tokens_cached IS NOT NULL), 0)::float8 AS "cacheIn",
           coalesce(sum(cost) FILTER (WHERE cost_basis = 'actual'), 0)::float8 AS cost,
           count(cost)::int AS "costCalls"
      FROM admin_model_attempt_metrics
     WHERE ${scope}`;

  const series = sql`
    SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
           coalesce(${sql(DIMENSION_COLUMN[dimension])}, '-') AS part,
           count(*)::int AS calls
      FROM (SELECT date_bin(${bucketInterval}::interval, started_at, timestamptz '2000-01-01') AS b, ${sql(DIMENSION_COLUMN[dimension])}
              FROM admin_model_attempt_metrics
             WHERE ${scope}) t
     GROUP BY b, part
     ORDER BY b`;

  const options = sql`
    SELECT array_agg(DISTINCT purpose ORDER BY purpose) FILTER (WHERE purpose IS NOT NULL) AS purposes,
           array_agg(DISTINCT service ORDER BY service) FILTER (WHERE service IS NOT NULL) AS services,
           array_agg(DISTINCT coalesce(model, '-') ORDER BY coalesce(model, '-')) AS models
      FROM admin_model_attempt_metrics
     WHERE ${scope}`;

  // 环节表的原料：按「用途 × 模型」聚合一次。用途是回执写下来的，不是猜的；
  // 一个环节（能力）对应一到多个用途，折叠在 JS 里做，SQL 只出最小粒度。
  const byPurpose = sql`
    SELECT purpose,
           coalesce(service, '-') AS service,
           coalesce(model, '-') AS model,
           count(*)::int AS calls,
           count(*) FILTER (WHERE status = 'received')::int AS ok,
           count(*) FILTER (WHERE status = 'failed')::int AS bad,
           count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
           coalesce(round(avg(latency_ms)), 0)::int AS "avgMs",
           coalesce(sum(tokens_in), 0)::float8 AS "tokensIn",
           coalesce(sum(tokens_out), 0)::float8 AS "tokensOut",
           coalesce(sum(tokens_cached), 0)::float8 AS "tokensCached",
           coalesce(sum(tokens_reasoning), 0)::float8 AS "tokensReasoning",
           coalesce(sum(tokens_out) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedOut",
           coalesce(sum(latency_ms) FILTER (WHERE latency_ms IS NOT NULL AND tokens_out IS NOT NULL), 0)::float8 AS "speedMs",
           coalesce(sum(cost) FILTER (WHERE cost_basis = 'actual'), 0)::float8 AS cost,
           count(cost)::int AS "costCalls",
           max(started_at) AS "lastCall"
      FROM admin_model_attempt_metrics
     WHERE ${scope}
     GROUP BY purpose, service, model`;

  // 队列那一侧：排队/执行中/重试/24h 失败/窗口内完成 + 最近完成与最近失败的时间。
  // 名字来自 PIPELINE（真实跑批的 pg-boss 队列），不是编的。
  const queueNames = PIPELINE.map((p) => p.queue).filter((q): q is string => !!q);
  const queueStats = sql`
    SELECT name,
           count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS queued,
           count(*) FILTER (WHERE state = 'retry')::int AS retry,
           count(*) FILTER (WHERE state = 'active')::int AS active,
           count(*) FILTER (WHERE state = 'completed' AND completed_on > ${since})::int AS done,
           count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '24 hours')::int AS "failed24h",
           max(completed_on) FILTER (WHERE state = 'completed') AS "lastDone",
           max(completed_on) FILTER (WHERE state = 'failed') AS "lastFailed"
      FROM pgboss.job
     WHERE name IN ${sql(queueNames)}
     GROUP BY name`;

  const [rows, totalRow, seriesRows, optionRow, queue, active, beats, capabilities, purposeRows, queueRows] = await Promise.all([
    perModel,
    totals,
    series,
    options,
    sql<{ state: string; n: number }[]>`SELECT state, count(*)::int AS n FROM pgboss.job GROUP BY state ORDER BY n DESC`,
    sql<{ name: string; n: number }[]>`SELECT name, count(*)::int AS n FROM pgboss.job WHERE state = 'active' GROUP BY name ORDER BY n DESC LIMIT 10`,
    sql<{ key: string; role: string; at: string | null; load: number | null }[]>`
      SELECT key, updated_by AS role, value->>'at' AS at, (value->>'load')::float8 AS load
        FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY updated_at DESC LIMIT 8`,
    capabilityPools(),
    byPurpose,
    queueStats,
  ]);

  const t = (totalRow[0] ?? {}) as unknown as {
    calls: number; ok: number; bad: number; pending: number; unknown: number; avgMs: number;
    tokensIn: number; tokensOut: number; tokensCached: number; tokensReasoning: number;
    speedOut: number; speedMs: number; cacheCalls: number; cacheIn: number; cost: number; costCalls: number;
  };

  // Stacked chart: keep the loudest 8 series visible and fold the tail into 其它, so 40 models cannot
  // turn the legend into a wall of colour nobody can match to a bar.
  const volume = new Map<string, number>();
  for (const row of seriesRows as unknown as { bucket: string; part: string; calls: number }[]) {
    volume.set(row.part, (volume.get(row.part) ?? 0) + row.calls);
  }
  const ranked = [...volume.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keep = new Set(ranked.slice(0, 8));
  const byBucket = new Map<string, Map<string, number>>();
  for (const row of seriesRows as unknown as { bucket: string; part: string; calls: number }[]) {
    const key = keep.has(row.part) ? row.part : "其它";
    const slot = byBucket.get(row.bucket) ?? new Map<string, number>();
    slot.set(key, (slot.get(key) ?? 0) + row.calls);
    byBucket.set(row.bucket, slot);
  }
  const seriesKeys = [...ranked.filter((k) => keep.has(k)), ...(ranked.length > keep.size ? ["其它"] : [])];
  const o = (optionRow[0] ?? {}) as unknown as { purposes?: string[]; services?: string[]; models?: string[] };
  const cooldownSnapshot = cooldownList();

  return {
    at: new Date().toISOString(),
    windowKey: key,
    windowMinutes: window,
    filters: { purpose, service, model, status, dimension },
    bucketMinutes,
    totals: {
      calls: t.calls ?? 0,
      ok: t.ok ?? 0,
      bad: t.bad ?? 0,
      pending: t.pending ?? 0,
      unknown: t.unknown ?? 0,
      avgMs: t.avgMs ?? 0,
      tokensIn: t.tokensIn ?? 0,
      tokensOut: t.tokensOut ?? 0,
      tokensCached: t.tokensCached ?? 0,
      tokensReasoning: t.tokensReasoning ?? 0,
      speed: t.speedMs > 0 ? t.speedOut / (t.speedMs / 1000) : null,
      cacheHit: t.cacheIn > 0 ? t.tokensCached / t.cacheIn : null,
      cacheCalls: t.cacheCalls ?? 0,
      cost: t.costCalls > 0 ? t.cost : null,
      costCalls: t.costCalls ?? 0,
    },
    models: rows as unknown as ModelOpsRow[],
    series: [...byBucket.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([bucket, parts]) => ({
      bucket,
      parts: [...parts.entries()].map(([key, calls]) => ({ key, calls })),
    })),
    seriesKeys,
    options: {
      purposes: o.purposes ?? [],
      services: o.services ?? [],
      models: o.models ?? [],
      statuses: ["received", "failed", "pending", "unknown"],
    },
    queue,
    active,
    heartbeats: beats,
    capabilities,
    catalog: Object.entries(MODELS).map(([key, spec]) => ({
      key,
      service: String(spec.service ?? "-"),
      vision: !!spec.vision,
      jsonMode: spec.jsonMode !== false,
    })),
    workflow: buildStages(
      purposeRows as unknown as StatRow[],
      queueRows as unknown as Array<{
        name: string; queued: number; retry: number; active: number; done: number; failed24h: number;
        lastDone: string | null; lastFailed: string | null;
      }>,
      capabilities,
      cooldownSnapshot,
    ),
    cooldowns: cooldownSnapshot,
    defaultModel: String(MODELS.default?.model ?? ""),
  };
}

/** 进程内的冷却账本：只给分类与到期时间，不回显上游 body（body 可能带凭据）。 */
function cooldownList() {
  return modelCooldown.inspect().map((c) => ({ model: c.model, service: c.service, category: c.category, until: c.until }));
}

const CATEGORY_LABEL: Record<string, string> = {
  quota_day: "日额度用尽",
  rate_minute: "限流",
  auth: "认证/账号",
  config: "配置拒绝",
};

/**
 * 把「用途 × 模型」的聚合折成环节表。
 *
 * 一个能力（CAPABILITIES 的一项）由一到多个用途喂；环节表的每一行就是一个能力，队列那一侧
 * 挂上驱动它的 pg-boss 队列。没被任何环节认领的用途（历史遗留、monitor 之类）折成一行
 * 「未归类」，宁可多一行，也不让总数和上面几张卡对不上。
 */
function buildStages(
  rows: StatRow[],
  queues: Array<{ name: string; queued: number; retry: number; active: number; done: number; failed24h: number; lastDone: string | null; lastFailed: string | null }>,
  capabilities: Array<{ key: string; label: string; source: "admin" | "env" | "default"; members: string[] }>,
  cooldowns: Array<{ model: string; service: string; category: string; until: number }>,
) {
  const queueByName = new Map(queues.map((q) => [q.name, q]));
  const cooling = new Map(cooldowns.map((c) => [c.model, CATEGORY_LABEL[c.category] ?? c.category]));
  const claimed = new Set<string>();
  // 池里写的是注册表 key，回执记的是上游模型名（`loomy-deepseek-v41-flash` ↔ `loomy/DeepSeek-V4.1-Flash`、
  // `default` ↔ `agnes-3.0-flash`）。按 key 精确匹配几乎全部落空，所以先把每个成员解析成真实模型名再比。
  // 一个环节通常覆盖多个能力（分析 = 预筛/评分/理解/结构/摘要），各有各的池：在任一池里出现就算在池内，
  // 取最靠前的那个位次——只查首个能力的池会让别的能力的成员全都显示「—」。
  const rankOf = (pools: string[][], r: StatRow) => {
    const wanted = r.model.toLowerCase();
    let best: number | null = null;
    for (const pool of pools) {
      const exact = pool.indexOf(r.model);
      let rank: number | null = exact >= 0 ? exact + 1 : null;
      if (rank === null) {
        for (let i = 0; i < pool.length; i++) {
          if (String(MODELS[pool[i]!]?.model ?? "").toLowerCase() === wanted) { rank = i + 1; break; }
        }
      }
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
    return best;
  };

  const stages: OpsStage[] = PIPELINE.map((stage) => {
    const caps = stage.capabilities
      .map((key) => (CAPABILITIES as Record<string, { label: string; purposes: string[] }>)[key])
      .filter((c): c is { label: string; purposes: string[] } => !!c);
    const purposes = caps.flatMap((c) => c.purposes);
    for (const p of purposes) claimed.add(p);
    const mine = rows.filter((r) => r.purpose && purposes.includes(r.purpose));
    const cap = capabilities.find((c) => c.key === stage.capabilities[0]);
    const pool = cap?.members ?? [];
    const pools = stage.capabilities
      .map((key) => capabilities.find((c) => c.key === key)?.members)
      .filter((p): p is string[] => Array.isArray(p) && p.length > 0);
    const q = stage.queue ? queueByName.get(stage.queue) : undefined;

    const totals = emptyTotals();
    for (const r of mine) accumulate(totals, r);
    settle(totals);

    // 同一模型可能服务同一环节里的多个用途：按模型再折一次。
    const byModel = new Map<string, StatRow & { name: string }>();
    for (const r of mine) {
      const key = `${r.service}|${r.model}`;
      const prev = byModel.get(key);
      if (!prev) byModel.set(key, { ...r, name: r.model });
      else {
        const calls = prev.calls + r.calls;
        byModel.set(key, {
          ...prev,
          calls,
          ok: prev.ok + r.ok,
          bad: prev.bad + r.bad,
          pending: prev.pending + r.pending,
          unknown: prev.unknown + r.unknown,
          avgMs: Math.round((prev.avgMs * prev.calls + r.avgMs * r.calls) / Math.max(1, calls)),
          tokensIn: prev.tokensIn + r.tokensIn,
          tokensOut: prev.tokensOut + r.tokensOut,
          tokensCached: prev.tokensCached + r.tokensCached,
          tokensReasoning: prev.tokensReasoning + r.tokensReasoning,
          speedOut: prev.speedOut + r.speedOut,
          speedMs: prev.speedMs + r.speedMs,
          cost: prev.cost + r.cost,
          costCalls: prev.costCalls + r.costCalls,
          lastCall: !prev.lastCall || (r.lastCall && r.lastCall > prev.lastCall) ? r.lastCall : prev.lastCall,
        });
      }
    }

    return {
      key: stage.key,
      label: stage.label,
      queue: stage.queue,
      purposes,
      serving: pool[0] ?? "—",
      source: cap?.source ?? "default",
      pool,
      poolFor: stage.capabilities[0] ?? "",
      queued: q?.queued ?? 0,
      active: q?.active ?? 0,
      retry: q?.retry ?? 0,
      done: q?.done ?? 0,
      failed24h: q?.failed24h ?? 0,
      lastDone: q?.lastDone ?? null,
      lastFailed: q?.lastFailed ?? null,
      totals,
      models: [...byModel.entries()]
        .map(([, r]) => ({
          service: r.service,
          model: r.model,
          calls: r.calls,
          ok: r.ok,
          bad: r.bad,
          pending: r.pending,
          unknown: r.unknown,
          avgMs: r.avgMs,
          maxMs: 0,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          tokensCached: r.tokensCached,
          tokensReasoning: r.tokensReasoning,
          speedOut: r.speedOut,
          speedMs: r.speedMs,
          cost: r.cost,
          costCalls: r.costCalls,
          poolRank: rankOf(pools, r),
          cooling: cooling.get(r.model) ?? null,
        }))
        .sort((a, b) => b.calls - a.calls),
    };
  });

  const leftovers = rows.filter((r) => !r.purpose || !claimed.has(r.purpose));
  const unmappedTotals = emptyTotals();
  for (const r of leftovers) accumulate(unmappedTotals, r);
  settle(unmappedTotals);
  const unmapped: OpsStage | null = leftovers.length === 0 ? null : {
    key: "unmapped",
    label: "未归类的调用（历史遗留用途 / 未标注）",
    queue: null,
    purposes: [...new Set(leftovers.map((r) => r.purpose ?? "未标注"))].sort(),
    serving: "—", source: "default", pool: [], poolFor: "",
    queued: 0, active: 0, retry: 0, done: 0, failed24h: 0, lastDone: null, lastFailed: null,
    totals: unmappedTotals,
    models: leftovers.map((r) => ({
      service: r.service, model: r.model, calls: r.calls, ok: r.ok, bad: r.bad, pending: r.pending,
      unknown: r.unknown, avgMs: r.avgMs, maxMs: 0, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      tokensCached: r.tokensCached, tokensReasoning: r.tokensReasoning, speedOut: r.speedOut,
      speedMs: r.speedMs, cost: r.cost, costCalls: r.costCalls, poolRank: null,
      cooling: cooling.get(r.model) ?? null,
    })),
  };
  return { stages, unmapped };
}
