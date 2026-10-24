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
  const rows = await db<(UsageMetric & { missingLabels: number })[]>`
    WITH base AS NOT MATERIALIZED (
      SELECT a.*,r.service,r.purpose,
        to_char(a.started_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
        extract(isodow FROM a.started_at AT TIME ZONE 'Asia/Shanghai')::int AS dow,
        extract(hour FROM a.started_at AT TIME ZONE 'Asia/Shanghai')::int AS hour,
        r.receipt_id IS NULL AS missing_label
      FROM admin_model_attempt_metrics a LEFT JOIN receipt_model_labels r ON r.receipt_id=a.receipt_id
      WHERE a.origin='live' AND a.model IS NOT NULL
        AND (${range}='all' OR a.started_at >= CASE WHEN ${range}='today'
          THEN date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
          ELSE now()-make_interval(days => ${range === "today" || range === "all" ? 7 : Number(range)}) END)
        AND (${service}='' OR r.service=${service}) AND (${model}='' OR a.model=${model})
    )
    SELECT CASE WHEN grouping(service)=0 THEN 'model' WHEN grouping(purpose)=0 THEN 'purpose'
      WHEN grouping(day)=0 THEN 'day' WHEN grouping(dow)=0 THEN 'hour'
      WHEN grouping(currency)=0 THEN 'currency' ELSE 'total' END AS kind,
      service,model,purpose,day,dow,hour,currency,
      count(*)::int AS calls,count(*) FILTER(WHERE status='received')::int AS ok,
      count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status='pending')::int AS pending,
      count(*) FILTER(WHERE status='unknown')::int AS unknown,
      sum(tokens_in)::float8 AS "tokensIn",sum(tokens_out)::float8 AS "tokensOut",
      count(*) FILTER(WHERE tokens_in IS NULL OR tokens_out IS NULL)::int AS "missingUsage",
      count(*) FILTER(WHERE cost IS NULL OR currency IS NULL OR cost_basis IS NULL)::int AS unpriced,
      sum(cost) FILTER(WHERE cost_basis='actual' AND currency IS NOT NULL)::float8 AS "actualCost",
      sum(cost) FILTER(WHERE cost_basis='estimated' AND currency IS NOT NULL)::float8 AS "estimatedCost",
      percentile_disc(0.5) WITHIN GROUP(ORDER BY latency_ms)::float8 AS "latencyMs",
      count(*) FILTER(WHERE missing_label)::int AS "missingLabels"
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
