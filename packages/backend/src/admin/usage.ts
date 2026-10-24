import type { Tx } from "../db.ts";
import { modelStatisticRead, statisticReader } from "./model-statistics-read.ts";

export const USAGE_RANGES = ["today", "7", "30", "90", "all"] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export function usageRange(value?: string): UsageRange {
  return USAGE_RANGES.includes(value as UsageRange) ? value as UsageRange : "7";
}
export interface UsageMetric {
  kind: "total" | "model" | "purpose" | "day" | "hour" | "currency";
  service: string | null; model: string | null; purpose: string | null;
  day: string | null; dow: number | null; hour: number | null; currency: string | null;
  calls: number; ok: number; failed: number; pending: number; unknown: number;
  tokensIn: number; tokensOut: number; missingUsage: number; unpriced: number;
  actualCost: number | null; estimatedCost: number | null; latencyMs: number | null;
}

/** Narrow, trigger-maintained attempt data only; no request/response bodies or model calls. */
export async function readUsage(db: Tx, range: UsageRange, service: string, model: string) {
  const [ready] = await db`SELECT
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.modelLabelsReady') AND
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.modelMetricsReady') AS ready`;
  if (!ready?.ready) throw Object.assign(new Error("statistics backfill pending"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  await db`SET LOCAL work_mem='16MB'`;
  // Bucket cardinality is much smaller than the planner's independent-column estimate. Prefer
  // bounded hash aggregation to repeated external sorts; scoped to this read transaction only.
  await db`SET LOCAL enable_sort=off`;
  const rows = await db<(UsageMetric & { missingLabels: number })[]>`
    WITH hourly AS MATERIALIZED (
      SELECT r.service,a.model,r.purpose,a.currency,date_trunc('hour',a.started_at) AS bucket,
        count(*)::int AS calls,count(*) FILTER(WHERE a.status='received')::int AS ok,
        count(*) FILTER(WHERE a.status='failed')::int AS failed,count(*) FILTER(WHERE a.status='pending')::int AS pending,
        count(*) FILTER(WHERE a.status='unknown')::int AS unknown,sum(a.tokens_in) AS tokens_in,sum(a.tokens_out) AS tokens_out,
        count(*) FILTER(WHERE a.tokens_in IS NULL OR a.tokens_out IS NULL)::int AS missing_usage,
        count(*) FILTER(WHERE a.cost IS NULL OR a.currency IS NULL OR a.cost_basis IS NULL)::int AS unpriced,
        sum(a.cost) FILTER(WHERE a.cost_basis='actual' AND a.currency IS NOT NULL) AS actual_cost,
        sum(a.cost) FILTER(WHERE a.cost_basis='estimated' AND a.currency IS NOT NULL) AS estimated_cost,
        sum(a.latency_ms)::float8 AS latency_sum,count(a.latency_ms)::int AS latency_count,
        count(*) FILTER(WHERE r.receipt_id IS NULL)::int AS missing_labels
      FROM admin_model_attempt_metrics a LEFT JOIN receipt_model_labels r ON r.receipt_id=a.receipt_id
      WHERE a.origin='live' AND a.model IS NOT NULL
        AND (${range}='all' OR a.started_at >= CASE WHEN ${range}='today'
          THEN date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
          ELSE now()-make_interval(days => ${range === "today" || range === "all" ? 7 : Number(range)}) END)
        AND (${service}='' OR r.service=${service}) AND (${model}='' OR a.model=${model})
      GROUP BY r.service,a.model,r.purpose,a.currency,date_trunc('hour',a.started_at)
    ), base AS MATERIALIZED (
      SELECT hourly.*,(bucket AT TIME ZONE 'Asia/Shanghai')::date::text AS day,
        extract(isodow FROM bucket AT TIME ZONE 'Asia/Shanghai')::int AS dow,
        extract(hour FROM bucket AT TIME ZONE 'Asia/Shanghai')::int AS hour FROM hourly
    )
    SELECT CASE WHEN grouping(service)=0 THEN 'model' WHEN grouping(purpose)=0 THEN 'purpose'
      WHEN grouping(day)=0 THEN 'day' WHEN grouping(dow)=0 THEN 'hour'
      WHEN grouping(currency)=0 THEN 'currency' ELSE 'total' END AS kind,
      service,model,purpose,day,dow,hour,currency,
      coalesce(sum(calls),0)::int AS calls,coalesce(sum(ok),0)::int AS ok,
      coalesce(sum(failed),0)::int AS failed,coalesce(sum(pending),0)::int AS pending,
      coalesce(sum(unknown),0)::int AS unknown,
      sum(tokens_in)::float8 AS "tokensIn",sum(tokens_out)::float8 AS "tokensOut",
      coalesce(sum(missing_usage),0)::int AS "missingUsage",coalesce(sum(unpriced),0)::int AS unpriced,
      sum(actual_cost)::float8 AS "actualCost",sum(estimated_cost)::float8 AS "estimatedCost",
      (sum(latency_sum)/nullif(sum(latency_count),0))::float8 AS "latencyMs",
      coalesce(sum(missing_labels),0)::int AS "missingLabels"
    FROM base GROUP BY GROUPING SETS((),(service,model),(purpose),(day),(dow,hour),(currency))`;
  if (rows.some(r => r.missingLabels)) throw Object.assign(new Error("statistics label gap"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  return rows.map(({ missingLabels: _missing, ...r }) => ({ ...r, tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0,
    // Costs only have meaning within a currency group; never add USD to CNY.
    actualCost: r.kind === "currency" ? r.actualCost : null, estimatedCost: r.kind === "currency" ? r.estimatedCost : null }));
}

const readers = new Map<string, ReturnType<typeof statisticReader<UsageMetric>>>();
export async function usageOverview(value?: string, service = "", model = "") {
  const range=usageRange(value);
  service=service.slice(0,100);model=model.slice(0,200);
  const key=JSON.stringify([range,service,model]);let read=readers.get(key);
  if(!read){if(readers.size>=32)readers.delete(readers.keys().next().value!);
    read=statisticReader(() => modelStatisticRead(db => readUsage(db,range,service,model)),()=>[]);readers.set(key,read);}
  const result=await read();
  return {range,service,model,timeZone:"Asia/Shanghai",refreshSeconds:30,...result};
}
