import type { OfficialCostReport } from "@aihot/contracts/model-costs";
import { officialCosts, resolveFx, loadPricingVersions, loadPricingRates, pricingRowsToDetail, type PricingBucket } from "./official-pricing.ts";
import { type Tx } from "../db.ts";
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
  billingKind: string | null;
  subscriptionCalls: number; freeCalls: number; noPriceCalls: number; unverifiedCalls: number;
  equivalentCalls: number; unmappedModelCalls: number;
  reasoningTokens: number | null; reasoningMissing: number;
}

/** Narrow, trigger-maintained attempt data only; no request/response bodies or model calls. */
export async function readUsage(db: Tx, range: UsageRange | "*", service: string, model: string, date: string | null = null) {
  if (range === 'date' && !usageDate(date ?? undefined)) throw new Error('Invalid usage date');
  // 2026-11-18：标签/指标回填状态不再整页阻断。派生 metrics 表若不存在或查询失败，由快照层保留
  // 上次成功数据并标 unavailable；标签缺口只作为行上的 missingLabels 提示，不抛 MODEL_LABEL_BACKFILL_PENDING。
  const [ready] = await db`SELECT
    (SELECT value='true'::jsonb FROM settings WHERE key='admin.usageCacheReady') AS fees_ready`;
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
        sum(a.tokens_reasoning) AS reasoning_tokens,
        count(*) FILTER(WHERE a.tokens_reasoning IS NULL)::int AS reasoning_missing,
        sum(a.tokens_in) FILTER(WHERE a.tokens_out IS NOT NULL AND a.tokens_cached IS NULL) AS unknown_cache_in,
        count(*) FILTER(WHERE a.tokens_in IS NOT NULL AND a.tokens_out IS NOT NULL AND a.tokens_cached IS NULL)::int AS cache_unknown_calls,
        count(*) FILTER(WHERE a.tokens_in IS NULL OR a.tokens_out IS NULL)::int AS missing_usage,
        count(*) FILTER(WHERE a.cost IS NULL OR a.currency IS NULL OR a.cost_basis IS NULL)::int AS unpriced,
        sum(a.cost) FILTER(WHERE a.cost_basis='actual' AND a.currency IS NOT NULL) AS actual_cost,
        sum(a.cost) FILTER(WHERE a.cost_basis='estimated' AND a.currency IS NOT NULL) AS estimated_cost,
        -- 按价卡 billing_kind 分列；actual 只来自回执 cost_basis='actual'，价卡刊例/等值不进 actual。
        count(*) FILTER(WHERE pr.billing_kind='subscription')::int AS subscription_calls,
        count(*) FILTER(WHERE pr.billing_kind='free')::int AS free_calls,
        count(*) FILTER(WHERE pr.billing_kind='no-price')::int AS no_price_calls,
        count(*) FILTER(WHERE pr.billing_kind='unverified')::int AS unverified_calls,
        count(*) FILTER(WHERE pr.billing_kind='equivalent-public-api')::int AS equivalent_calls,
        count(*) FILTER(WHERE pr.id IS NULL)::int AS unmapped_model_calls,
        pr.billing_kind AS pricing_kind,
        sum(a.latency_ms)::float8 AS latency_sum,count(a.latency_ms)::int AS latency_count,
        count(*) FILTER(WHERE r.receipt_id IS NULL)::int AS missing_labels
      FROM admin_model_attempt_metrics a
      LEFT JOIN receipt_model_labels r ON r.receipt_id=a.receipt_id
      LEFT JOIN pricing_rates pr ON pr.id = r.service || '::' || a.model
      WHERE a.origin='live' AND a.model IS NOT NULL
        AND (${range} <> 'date' OR (a.started_at >= (${date}::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND a.started_at < ((${date}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
        AND (${service}='' OR r.service=${service}) AND (${model}='' OR a.model=${model})
      GROUP BY range_mask,r.service,a.model,r.purpose,a.currency,pr.billing_kind,date_trunc('hour',a.started_at)
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
      coalesce(sum(subscription_calls),0)::int AS "subscriptionCalls",
      coalesce(sum(free_calls),0)::int AS "freeCalls",
      coalesce(sum(no_price_calls),0)::int AS "noPriceCalls",
      coalesce(sum(unverified_calls),0)::int AS "unverifiedCalls",
      coalesce(sum(equivalent_calls),0)::int AS "equivalentCalls",
      coalesce(sum(unmapped_model_calls),0)::int AS "unmappedModelCalls",
      max(pricing_kind) AS "billingKind",
      (sum(latency_sum)/nullif(sum(latency_count),0))::float8 AS "latencyMs",
      coalesce(sum(missing_labels),0)::int AS "missingLabels",
      coalesce(sum(pricing_calls),0)::int AS "pricedCalls",coalesce(sum(priced_in),0)::float8 AS "pricedIn",
      coalesce(sum(priced_out),0)::float8 AS "pricedOut",coalesce(sum(cached_tokens),0)::float8 AS "cachedTokens",
      coalesce(sum(reasoning_tokens),0)::float8 AS "reasoningTokens",coalesce(sum(reasoning_missing),0)::int AS "reasoningMissing",
      coalesce(sum(unknown_cache_in),0)::float8 AS "unknownCacheIn",coalesce(sum(cache_unknown_calls),0)::int AS "cacheUnknownCalls"
    FROM base GROUP BY GROUPING SETS((range_key),(range_key,service,model),(range_key,purpose),(range_key,day),(range_key,dow,hour),(range_key,currency),(range_key,service,model,day,dow,hour))`;
  if (rows.some(r => r.missingLabels)) {
    // 标签回填未完成不阻塞真实调用数/token/actual cost；只在结果上挂提示。
    // 后台用量页必须能看到「实际打了多少次模型」，不能因为注册表标签没追上就整页 503。
    // missingLabels 已聚合到 rows 里，前端可据此显示「标签回填中」。
  }
  // 汇率单一来源：fx_rates 表最新一行（pricing-check timer 每日落库），无行回落 CNY_FX 常量。
  const [fxRow] = await db<{ rate: number; as_of: string; source_url: string | null }[]>`
    SELECT rate, as_of::text AS as_of, source_url FROM fx_rates WHERE pair = 'USD/CNY' ORDER BY as_of DESC LIMIT 1`;
  const fx = resolveFx(fxRow);
  // 历史价卡版本：按调用时点选有效版本；表缺失回落空 Map（传入 Map 后不再用常量倒算）。
  const versionsByRate = await loadPricingVersions(db);
  // 明细价表：只纳 DB 中可计价行；verifiedOn 取最近成功核验/seed 抓取时点，不写死日期。
  const { rates: rateRows } = await loadPricingRates(db);
  const pricingDetail = pricingRowsToDetail(rateRows);
  const pricingFor=(rangeKey:UsageRange)=>officialCosts(rows.filter(r=>r.kind==="pricing"&&r.rangeKey===rangeKey),!!ready.fees_ready,fx,versionsByRate,pricingDetail);
  const result: UsageMetric[] = rows.filter(r=>r.kind!=="pricing").map(({ missingLabels: _missing, pricedCalls:_pc,pricedIn:_pi,pricedOut:_po,cachedTokens:_ct,unknownCacheIn:_uc,cacheUnknownCalls:_cc, ...r }) => ({ ...r,kind:r.kind as UsageMetric["kind"],...(r.kind==="total"?{pricing:pricingFor(r.rangeKey)}:{}), tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0,
    subscriptionCalls: r.subscriptionCalls ?? 0, freeCalls: r.freeCalls ?? 0, noPriceCalls: r.noPriceCalls ?? 0,
    unverifiedCalls: r.unverifiedCalls ?? 0, equivalentCalls: r.equivalentCalls ?? 0, unmappedModelCalls: r.unmappedModelCalls ?? 0,
    billingKind: r.billingKind ?? null,
    // reasoning 仅展示口径：全部调用都缺 reasoning 字段时保持 null；有值才给和值，不并入 output、不叠加计费。
    reasoningMissing: r.reasoningMissing ?? 0,
    reasoningTokens: (r.reasoningMissing ?? 0) === r.calls ? null : (r.reasoningTokens ?? 0),
    // Costs only have meaning within a currency group; never add USD to CNY.
    actualCost: r.kind === "currency" ? r.actualCost : null, estimatedCost: r.kind === "currency" ? r.estimatedCost : null }));
  // An empty successful filtered read is zero; unavailable scans still throw.
  if (!result.length && range !== "*") result.push(emptyUsage(range, !!ready.fees_ready, fx));
  return result;
}

function emptyUsage(rangeKey: UsageRange, pricingReady = true, fx?: { usdToCny: number; date: string; source: string }): UsageMetric {
  return {rangeKey,kind:'total',service:null,model:null,purpose:null,day:null,dow:null,hour:null,currency:null,calls:0,ok:0,failed:0,pending:0,unknown:0,tokensIn:0,tokensOut:0,missingUsage:0,unpriced:0,actualCost:null,estimatedCost:null,latencyMs:null,billingKind:null,subscriptionCalls:0,freeCalls:0,noPriceCalls:0,unverifiedCalls:0,equivalentCalls:0,unmappedModelCalls:0,reasoningTokens:null,reasoningMissing:0,pricing:officialCosts([],pricingReady,fx)};
}

// The compact metrics table has a eight-second SQL deadline, and ranges share one scan.
// Admit this bounded read under ordinary workflow pressure; still defer under severe pressure.
/**
 * 2026-11-20：这台 891MiB 的读者机在正常爬虫流量下 memoryFull 实测 20–32、ioFull 18–39；
 * 旧阈值 memoryFull<15 会让用量快照永远没有第一次成功写盘的机会，页面只能一直显示「正在生成」。
 * 与 resource-cron 的 <40 口径对齐，同时保留 available/disk 硬底线；快照仍由 aggregateBusy
 * 全局串行、单次读 30 秒截止，不会因页面轮询并发叠加。
 */
export function usageHeadroomFor(s: {availableMiB:number;memoryFull:number;ioFull:number;cpuSome:number;diskFreeMiB:number}){
  return s.availableMiB>=64&&s.memoryFull<40&&s.ioFull<40&&s.cpuSome<70&&s.diskFreeMiB>=3072;
}
function usageHeadroom(){try{return usageHeadroomFor(readResourceSample());}catch{return false;}}
const readers = new Map<string, ReturnType<typeof snapshotReader<UsageMetric>>>();
function usageReader(range:UsageRange,service:string,model:string,date:string|null=null){
  const key=JSON.stringify(['usage-standard-v5',service,model,range==='date'?date:null]);let read=readers.get(key);
  if(!read){if(readers.size>=24)readers.delete(readers.keys().next().value!);
    read=snapshotReader(()=>modelStatisticRead(db=>readUsage(db,range==='date'?'date':"*",service,model,date),30_000),snapshotStore<UsageMetric>(key),Date.now,{freshMs:30_000,canRefresh:usageHeadroom});readers.set(key,read);}
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
