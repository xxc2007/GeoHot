// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import { sql } from "../db.ts";
import { CAPABILITIES, invalidateModelCache, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { audit } from "./auth.ts";
import { modelStatisticRead, statisticReader } from "./model-statistics-read.ts";

interface UsageRow {
  purpose: string;
  /** Kept beside the model name because two providers can answer under the same model (`agnes-3.0-flash` on
   * both the `.com` and the `.cn` endpoint); grouped by model alone the pool looks like one provider. */
  service: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  actual_cost: string | null;
  currency: string | null;
}

/** Aggregate all attempts against maintained narrow labels: the read never touches request TOAST.
 * A backfill gap is explicitly unavailable, never an incomplete but apparently successful total. */
export async function readModelUsage(db: import("../db.ts").Tx, since: Date) {
  // One single-flight statistics query only: enough memory to avoid sorting saved JSON to disk.
  await db`SET LOCAL work_mem = '16MB'`;
  const [ready] = await db<{ ready: boolean }[]>`SELECT value='true'::jsonb AS ready FROM settings WHERE key='admin.modelLabelsReady'`;
  if (!ready?.ready) throw Object.assign(new Error("model statistics labels are still being backfilled"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  const [metricsReady] = await db<{ ready: boolean }[]>`SELECT value='true'::jsonb AS ready FROM settings WHERE key='admin.modelMetricsReady'`;
  if (!metricsReady?.ready) throw Object.assign(new Error("model metrics are still being backfilled"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  const rows = await db<(UsageRow & { missing_labels: number })[]>`
      WITH attempts AS NOT MATERIALIZED (
        SELECT receipt_id, model, status, latency_ms, cost, cost_basis, currency,
               tokens_in, tokens_out
        FROM admin_model_attempt_metrics
        WHERE started_at >= ${since} AND origin = 'live' AND model IS NOT NULL AND receipt_id IS NOT NULL
      )
      SELECT r.purpose, r.service, a.model, r.prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum(a.tokens_in) AS tokens_in, sum(a.tokens_out) AS tokens_out,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost, max(a.currency) AS currency,
             count(*) FILTER (WHERE r.receipt_id IS NULL)::int AS missing_labels
      FROM attempts a LEFT JOIN receipt_model_labels r ON r.receipt_id = a.receipt_id
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 5 DESC`;
  if (rows.some(row => row.missing_labels > 0)) throw Object.assign(new Error("model statistics labels are still being backfilled"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  return rows.map(({ missing_labels: _missing, ...row }) => row);
}

const usageReaders = new Map<number, () => Promise<import("./model-statistics-read.ts").StatisticResult<UsageRow[]>>>();
const readPrices = statisticReader(() => modelStatisticRead(db =>
  db<{ service: string; model: string; currency: string; input_per_mtok: string | null; output_per_mtok: string | null }[]>`
    SELECT service, model, currency, input_per_mtok, output_per_mtok FROM service_prices`), () => []);
const readBenches = statisticReader(() => modelStatisticRead(db =>
  db<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
    SELECT id, label, sample_size, prompt_version, models,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`), () => []);

export async function modelsOverview(days = 7) {
  days = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.floor(days))) : 7;
  let readUsage = usageReaders.get(days);
  if (!readUsage) {
    const windowDays = days;
    readUsage = statisticReader(() => modelStatisticRead(db =>
      readModelUsage(db, new Date(Date.now() - windowDays * 86400_000))), () => []);
    usageReaders.set(days, readUsage);
  }
  const [sourcesResult, usageResult, pricesResult, historyResult, benchesResult] = await Promise.all([
    modelSources().then(rows => ({ rows, status: { state: "ready" as const, asOf: new Date().toISOString() } }),
      () => ({ rows: null, status: { state: "unavailable" as const, asOf: null, message: "当前模型配置暂时不可用，请稍后刷新。" } })),
    readUsage(), readPrices(),
    // Switch history is always fresh, like model configuration.
    modelStatisticRead(db => db<{ at: Date; actor: string; subject: string; reason: string | null; before: unknown; after: unknown }[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log
      WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`)
      .then(rows => ({ rows, status: { state: "ready" as const, asOf: new Date().toISOString() } }),
        () => ({ rows: [], status: { state: "unavailable" as const, asOf: null, message: "切换记录暂时不可用，请稍后刷新。" } })),
    readBenches(),
  ]);
  const sources = sourcesResult.rows;
  const usage = usageResult.rows;
  const prices = pricesResult.rows;
  const history = historyResult.rows;
  const benches = benchesResult.rows;
  // The receipt row already carries its own service, so price by that. Resolving a provider from the model
  // name instead would misattribute the two Agnes doors, which answer under one model name.
  const priced = (u: UsageRow) => {
    const service = u.service;
    const p = prices.find((x) => x.service === service && x.model === u.model) ?? prices.find((x) => x.service === service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    return { amount: (Number(u.tokens_in ?? 0) / 1e6) * Number(p.input_per_mtok ?? 0) + (Number(u.tokens_out ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0), currency: p.currency };
  };
  const capabilities = sources ? (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose))
      .map((u) => ({
        purpose: u.purpose,
        service: u.service,
        model: u.model,
        promptVersion: u.prompt_version,
        calls: u.calls,
        ok: u.ok,
        failed: u.failed,
        unknown: u.unknown,
        p50: u.p50,
        p95: u.p95,
        tokensIn: Number(u.tokens_in ?? 0),
        tokensOut: Number(u.tokens_out ?? 0),
        actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
        currency: u.currency,
        estimate: priced(u),
      })),
  })) : [];
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities, choices, history, benches, statistics: {
    configuration: sourcesResult.status, usage: usageResult.status, prices: pricesResult.status, history: historyResult.status, benches: benchesResult.status,
  } };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = (CAPABILITIES as Record<string, Capability>)[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    // Object.hasOwn, not `MODELS[model]`: `constructor` and `__proto__` are truthy lookups on a plain object,
    // and one of them reaching chatJson yields a `service` of undefined — which matches no budgets row, and
    // no budgets row means no circuit breaker (receipts.ts returns early).
    if (!Object.hasOwn(MODELS, model)) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    const spec = MODELS[model]!;
    if (!!c.vision !== !!spec.vision) throw Object.assign(new Error(c.vision ? "this capability needs a vision model" : "a vision-only model cannot do this"), { statusCode: 400 });
    // A model that ignores response_format answers in prose, and every step but the title/summary one parses
    // a JSON object — pinning it there would produce nothing and re-pay for the same failure on each retry.
    if (spec.jsonMode === false && !c.freeText) throw Object.assign(new Error("this step parses JSON, so it needs a model with JSON mode"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}
