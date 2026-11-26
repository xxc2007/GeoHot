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
};

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

/** Bucket width for the stacked chart: fine for a live hour, coarse for a week. */
function bucketFor(windowMinutes: number) {
  if (windowMinutes <= 90) return 5;
  if (windowMinutes <= 360) return 15;
  if (windowMinutes <= 1440) return 60;
  return 1440;
}

const DIMENSION_COLUMN: Record<Dimension, "model" | "service" | "purpose"> = {
  model: "model",
  service: "service",
  purpose: "purpose",
};

export async function loadModelOps(windowMinutes = 60, filters: OpsFilters = {}): Promise<ModelOps> {
  const window = Math.max(10, Math.min(10_080, Math.floor(windowMinutes)));
  const since = new Date(Date.now() - window * 60_000);
  const purpose = (filters.purpose ?? "").slice(0, 80);
  const service = (filters.service ?? "").slice(0, 80);
  const model = (filters.model ?? "").slice(0, 200);
  const status = (filters.status ?? "").slice(0, 40);
  const dimension: Dimension = filters.dimension === "service" || filters.dimension === "purpose" ? filters.dimension : "model";
  const bucketMinutes = bucketFor(window);
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

  const [rows, totalRow, seriesRows, optionRow, queue, active, beats, capabilities] = await Promise.all([
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

  return {
    at: new Date().toISOString(),
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
  };
}
