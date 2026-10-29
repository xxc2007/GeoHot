import type { OfficialCostReport } from "@aihot/contracts/model-costs";
import { officialCosts, type PricingBucket } from "./official-pricing.ts";
import type { Tx } from "../db.ts";
import {snapshotReader,snapshotStore} from "./statistic-snapshot.ts";
import { readResourceSample } from "../operations/resource-budget.ts";
import { modelStatisticRead } from "./model-statistics-read.ts";
import { beijingToday, usageDate, usageMonth } from "@aihot/contracts/usage-date";

export const USAGE_RANGES = ["today", "7", "30", "90", "all", "date"] as const;
export type UsageRange = typeof USAGE_RANGES[number];
export function usageRange(value?: string): UsageRange {
  return USAGE_RANGES.includes(value as UsageRange) ? value as UsageRange : "all";
}
export interface UsageMetric {
  rangeKey: UsageRange;
  pricing?: OfficialCostReport;
  kind: "total" | "model" | "purpose" | "day" | "hour" | "currency";
  service: string | null; model: string | null; purpose: string | null;
  day: string | null; dow: number | null; hour: number | null; currency: string | null;
  calls: number; ok: number; failed: number; pending: number; unknown: number;
  tokensIn: number; tokensOut: number; missingUsage: number; unpriced: number;
  actualCost: number | null; estimatedCost: number | null; latencyMs: number | null;
}

/** Narrow, trigger-maintained attempt data only; no request/response bodies or model calls. */
export async function readUsage(db: Tx, range: UsageRange | "*", service: string, model: string, date: string | null = null) {
  if (range === 'date' && !usageDate(date ?? undefined)) throw new Error('Invalid usage date');
  const [ready] = await db`SELECT
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.modelLabelsReady') AND
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.modelMetricsReady') AS ready,
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.usageCacheReady') AS fees_ready`;
  if (!ready?.ready) throw Object.assign(new Error("statistics backfill pending"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  await db`SET LOCAL work_mem='16MB'`;
  // Date and shared reads use the same prepared shape: fold the day bounds for each call.
  await db`SET LOCAL plan_cache_mode='force_custom_plan'`;
  // Compilation costs more than execution for this short-lived dashboard aggregate. A discouraged
  // sort can also inflate estimated cost and trigger JIT; do not spend the read deadline compiling.
  await db`SET LOCAL jit=off`;
  // Bucket cardinality is much smaller than the planner's independent-column estimate. Prefer
  // bounded hash aggregation to repeated external sorts; scoped to this read transaction only.
  await db`SET LOCAL enable_sort=off`;
  const rows = await db<(Omit<UsageMetric,"kind"> & PricingBucket & {kind:UsageMetric["kind"]|"pricing";missingLabels:number})[]>`
    WITH hourly AS MATERIALIZED (
      SELECT (CASE WHEN a.started_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' THEN 1 ELSE 0 END
        + CASE WHEN a.started_at >= now()-interval '7 days' THEN 2 ELSE 0 END
        + CASE WHEN a.started_at >= now()-interval '30 days' THEN 4 ELSE 0 END
        + CASE WHEN a.started_at >= now()-interval '90 days' THEN 8 ELSE 0 END) AS range_mask,
        r.service,a.model,r.purpose,a.currency,date_trunc('hour',a.started_at) AS bucket,
        count(*)::int AS calls,count(*) FILTER(WHERE a.status='received')::int AS ok,
        count(*) FILTER(WHERE a.status='failed')::int AS failed,count(*) FILTER(WHERE a.status='pending')::int AS pending,
        count(*) FILTER(WHERE a.status='unknown')::int AS unknown,sum(a.tokens_in) AS tokens_in,sum(a.tokens_out) AS tokens_out,
        count(*) FILTER(WHERE a.tokens_in IS NOT NULL AND a.tokens_out IS NOT NULL)::int AS pricing_calls,
        sum(a.tokens_in) FILTER(WHERE a.tokens_out IS NOT NULL) AS priced_in,
        sum(a.tokens_out) FILTER(WHERE a.tokens_in IS NOT NULL) AS priced_out,
        sum(a.tokens_cached) FILTER(WHERE a.tokens_in IS NOT NULL AND a.tokens_out IS NOT NULL) AS cached_tokens,
        sum(a.tokens_in) FILTER(WHERE a.tokens_out IS NOT NULL AND a.tokens_cached IS NULL) AS unknown_cache_in,
        count(*) FILTER(WHERE a.tokens_in IS NOT NULL AND a.tokens_out IS NOT NULL AND a.tokens_cached IS NULL)::int AS cache_unknown_calls,
        count(*) FILTER(WHERE a.tokens_in IS NULL OR a.tokens_out IS NULL)::int AS missing_usage,
        count(*) FILTER(WHERE a.cost IS NULL OR a.currency IS NULL OR a.cost_basis IS NULL)::int AS unpriced,
        sum(a.cost) FILTER(WHERE a.cost_basis='actual' AND a.currency IS NOT NULL) AS actual_cost,
        sum(a.cost) FILTER(WHERE a.cost_basis='estimated' AND a.currency IS NOT NULL) AS estimated_cost,
        sum(a.latency_ms)::float8 AS latency_sum,count(a.latency_ms)::int AS latency_count,
        count(*) FILTER(WHERE r.receipt_id IS NULL)::int AS missing_labels
      FROM admin_model_attempt_metrics a LEFT JOIN receipt_model_labels r ON r.receipt_id=a.receipt_id
      WHERE a.origin='live' AND a.model IS NOT NULL
        AND (${range} <> 'date' OR (a.started_at >= (${date}::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND a.started_at < ((${date}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
        AND (${service}='' OR r.service=${service}) AND (${model}='' OR a.model=${model})
      GROUP BY range_mask,r.service,a.model,r.purpose,a.currency,date_trunc('hour',a.started_at)
    ), base AS MATERIALIZED (
      SELECT hourly.*,scope.range_key,(bucket AT TIME ZONE 'Asia/Shanghai')::date::text AS day,
        extract(isodow FROM bucket AT TIME ZONE 'Asia/Shanghai')::int AS dow,
        extract(hour FROM bucket AT TIME ZONE 'Asia/Shanghai')::int AS hour FROM hourly CROSS JOIN (VALUES ('all',0),('today',1),('7',2),('30',4),('90',8),('date',0)) AS scope(range_key,mask)
      -- The date-only scope is emitted only for a bounded date read, never the shared five-range scan.
      WHERE (range_mask & scope.mask)=scope.mask AND ((${range}='*' AND scope.range_key<>'date') OR scope.range_key=${range})
    )
    SELECT range_key AS "rangeKey",CASE WHEN grouping(service)=0 AND grouping(hour)=0 THEN 'pricing' WHEN grouping(service)=0 THEN 'model' WHEN grouping(purpose)=0 THEN 'purpose'
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
      coalesce(sum(missing_labels),0)::int AS "missingLabels",
      coalesce(sum(pricing_calls),0)::int AS "pricingCalls",coalesce(sum(priced_in),0)::float8 AS "pricedIn",
      coalesce(sum(priced_out),0)::float8 AS "pricedOut",coalesce(sum(cached_tokens),0)::float8 AS "cachedTokens",
      coalesce(sum(unknown_cache_in),0)::float8 AS "unknownCacheIn",coalesce(sum(cache_unknown_calls),0)::int AS "cacheUnknownCalls"
    FROM base GROUP BY GROUPING SETS((range_key),(range_key,service,model),(range_key,purpose),(range_key,day),(range_key,dow,hour),(range_key,currency),(range_key,service,model,day,dow,hour))`;
  if (rows.some(r => r.missingLabels)) throw Object.assign(new Error("statistics label gap"), { code: "MODEL_LABEL_BACKFILL_PENDING" });
  const pricingFor=(rangeKey:UsageRange)=>officialCosts(rows.filter(r=>r.kind==="pricing"&&r.rangeKey===rangeKey),!!ready.fees_ready);
  const result: UsageMetric[] = rows.filter(r=>r.kind!=="pricing").map(({ missingLabels: _missing, pricingCalls:_pc,pricedIn:_pi,pricedOut:_po,cachedTokens:_ct,unknownCacheIn:_uc,cacheUnknownCalls:_cc, ...r }) => ({ ...r,kind:r.kind as UsageMetric["kind"],...(r.kind==="total"?{pricing:pricingFor(r.rangeKey)}:{}), tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0,
    // Costs only have meaning within a currency group; never add USD to CNY.
    actualCost: r.kind === "currency" ? r.actualCost : null, estimatedCost: r.kind === "currency" ? r.estimatedCost : null }));
  // An empty successful filtered read is zero; unavailable scans still throw.
  if (!result.length && range !== "*") result.push(emptyUsage(range, !!ready.fees_ready));
  return result;
}

function emptyUsage(rangeKey: UsageRange, pricingReady = true): UsageMetric {
  return {rangeKey,kind:'total',service:null,model:null,purpose:null,day:null,dow:null,hour:null,currency:null,calls:0,ok:0,failed:0,pending:0,unknown:0,tokensIn:0,tokensOut:0,missingUsage:0,unpriced:0,actualCost:null,estimatedCost:null,latencyMs:null,pricing:officialCosts([],pricingReady)};
}

// The compact metrics table has a eight-second SQL deadline, and ranges share one scan.
// Admit this bounded read under ordinary workflow pressure; still defer under severe pressure.
function usageHeadroom(){try{const s=readResourceSample();return s.availableMiB>=64&&s.memoryFull<15&&s.ioFull<40&&s.cpuSome<70&&s.diskFreeMiB>=3072;}catch{return false;}}
const readers = new Map<string, ReturnType<typeof snapshotReader<UsageMetric>>>();
function usageReader(range:UsageRange,service:string,model:string,date:string|null=null){
  const key=JSON.stringify(['usage-standard-v4',service,model,range==='date'?date:null]);let read=readers.get(key);
  if(!read){if(readers.size>=24)readers.delete(readers.keys().next().value!);
    read=snapshotReader(()=>modelStatisticRead(db=>readUsage(db,range==='date'?'date':"*",service,model,date),8_000),snapshotStore<UsageMetric>(key),Date.now,{freshMs:30_000,canRefresh:usageHeadroom});readers.set(key,read);}
  return read;
}
export async function primeUsageSnapshot(range:UsageRange){const reader=usageReader(range,'','');await reader.get();await reader.refresh();return reader.get();}
export async function usageOverview(value?:string,service='',model='',dateValue?:string,monthValue?:string){
  const today=beijingToday(), date=usageDate(dateValue,today);
  if(dateValue!==undefined&&!date)throw Object.assign(new Error('日期无效或尚未到来，请选择有效日期。'),{statusCode:400});
  const range=date?'date':usageRange(value)==='date'?'all':usageRange(value);
  const month=usageMonth(monthValue??date?.slice(0,7),today);
  service=service.slice(0,100);model=model.slice(0,200);
  const snapshot=await usageReader(range,service,model,date).get();
  // Reuse the existing all-range daily aggregate for calendar dots; changing months adds no SQL.
  const calendarSnapshot=range==='date'?await usageReader('all',service,model).get():snapshot;
  const scoped=snapshot.rows.filter(r=>r.rangeKey===range);
  if(snapshot.status.asOf&&!scoped.length)scoped.push(emptyUsage(range));
  return {range,service,model,date,timeZone:'Asia/Shanghai',refreshSeconds:30,...snapshot,
    calendar:{month,today,status:calendarSnapshot.status,days:calendarSnapshot.rows.filter(r=>r.rangeKey==='all'&&r.kind==='day'&&r.day?.startsWith(month)).map(r=>({date:r.day!,calls:r.calls,tokens:r.tokensIn+r.tokensOut}))},
    rows:scoped};
}
