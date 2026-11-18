import {CNY_FX} from "@aihot/contracts/cny";
import type { OfficialRate, OfficialCostReport, CostBounds } from "@aihot/contracts/model-costs";
import type { Db } from "../db.ts";
import { resolveVersionAt, startedInstant, type PricingVersionRow } from "./pricing-map.ts";

// 2026-10-31 全量重核：9 条官方定价页当日实测（8 条 WebFetch + dots 浏览器实测），与下述常量
// 逐一比对 0 差异；每日闲时由 geohot-pricing-check.timer 复核（deploy/geohot/pricing-check.py）。
const verifiedOn="2026-10-31";
function rate(id:string,name:string,currency:"USD"|"CNY",input:number,cached:number,output:number,source:string,note:string):OfficialRate {
  return {id,name,currency,input,cached,output,currentInput:input,currentCached:cached,currentOutput:output,source,note,verifiedOn};
}
export const OFFICIAL_RATES:OfficialRate[]=[
  rate("deepseek","DeepSeek V4.1 Flash","USD",.15,.003,.60,"https://api-docs.deepseek.com/quick_start/pricing/","谷时单价；工作日北京时间 09–12、14–18 时翻倍，中国法定节假日除外。已核验 2026 年节假日。"),
  rate("hy3","腾讯 HY3","CNY",1,.25,4,"https://cloud.tencent.com/document/product/1823/130055","腾讯官方 API 参考价；WorkBuddy 套餐实际扣费另计。"),
  rate("glm53flash","GLM-5.3-Flash 国内版","CNY",.8,.23,2.8,"https://docs.bigmodel.cn/cn/guide/start/pricing","智谱中国站官方标准价，应用于 WorkBuddy 中国版；不含缓存存储费用。"),
  rate("glm53flash-intl","GLM-5.3-Flash 国际版","USD",.15,.03,.50,"https://docs.z.ai/guides/overview/pricing","Z.AI 国际站官方标准价，应用于国际版通道；不含缓存存储费用。"),
  rate("step5","Step 5 Preview","USD",1,.1,2.7,"https://platform.stepfun.ai/docs/en/guides/pricing/details","国际 API 官方参考价；不代表国内套餐实际扣费。"),
  rate("minimax","MiniMax M3.1 Flash","USD",.15,.015,.60,"https://www.minimax.io/blog/minimax-m31f","官方 API 参考价；MiniMax Code 订阅费用另计。"),
  rate("dots","Dots3 Note Preview","USD",.14,.14,.28,"https://dots.ai/platform/docs","官方标准价；未公布独立缓存折扣，缓存输入按普通输入计价。"),
  rate("agnes","Agnes 3.0 Flash 国际版","USD",.05,.005,.15,"https://wiki.agnes-ai.com/en/docs/pricing","采用官方刊例价，不应用免费体验政策。"),
  rate("agnes-cn","Agnes 3.0 Flash 国内版","CNY",.35,.035,1,"https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash","采用官方刊例价，与国际版分开计价。"),
];
const aliases:Record<string,string>={
  "dots-studio/dots-3-note-preview:free":"dots","dots-studio/dots3-note-prev:free":"dots",
  "deepseek-flash":"deepseek","deepseek-v4.1-flash-1017":"deepseek","codearts/deepseek-v4.1-flash-1017":"deepseek","workbuddy-ai/deepseek-v4.1-flash-1017":"deepseek",
  "deepseek-v4.1-flash":"deepseek","workbuddy-ai/deepseek-v4.1-flash":"deepseek","codearts/deepseek-v4.1-flash":"deepseek",
  "deepseek-v4-flash":"deepseek","deepseek-v4-flash-vision-exp":"deepseek",
  "hy3":"hy3","workbuddy-ai/hy3":"hy3","step-5-preview":"step5","workbuddy-ai/step-5-preview":"step5",
  // 2026-11-16：池子里 hy3 换成 hy4 flash（上游 id `hy4-flash`）后，柜台上**没有**它的刊例价
  // （腾讯只公布了 hy3 那一档）。这里故意不映射：宁可让它在用量页显示为「无官方价」，
  // 也不要拿 hy3 的价冒充 hy4——那会让成本页把两个不同模型的账算成一笔。
  "MiniMax-M3.1-Flash":"minimax","minimax-code/MiniMax-M3.1-Flash":"minimax","dots3-note-prev":"dots",
};
/**
 * 从 pricing_rates 表读最新价卡；表不存在（migration 未跑）或无行时回落 OFFICIAL_RATES 常量。
 * 不打外网、不阻塞页面；stale 标志透传给前端。
 */
export interface PricingRateRow {
  id: string; service: string | null; model: string | null; name: string;
  currency: "USD"|"CNY"|null;
  input: number | null; cached: number | null; output: number | null;
  billing_kind: "equivalent-public-api"|"subscription"|"free"|"no-price"|"unverified";
  source_url: string | null; source_urls: string[];
  effective_at: string | null; fetched_at: string | null; stale: boolean; note: string | null;
}
export async function loadPricingRates(db: Db): Promise<{ rates: PricingRateRow[]; stale: boolean }> {
  try {
    const rows = await db<PricingRateRow[]>`
      SELECT id, service, model, name, currency,
             input_price::float8 AS input, cached_price::float8 AS cached, output_price::float8 AS output,
             billing_kind, source_url,
             COALESCE(source_urls, '[]'::jsonb)::text AS source_urls,
             effective_at::text AS effective_at, fetched_at::text AS fetched_at, stale, note
      FROM pricing_rates`;
    if (!rows.length) return { rates: OFFICIAL_RATES.map(constToRow), stale: true };
    return { rates: rows.map(r => ({ ...r, source_urls: parseUrls(r.source_urls) })), stale: rows.every(r => r.stale) };
  } catch {
    // 表不存在或连接失败：常量兜底，标记 stale。
    return { rates: OFFICIAL_RATES.map(constToRow), stale: true };
  }
}
function parseUrls(raw: unknown): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw as string); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}
function constToRow(r: OfficialRate): PricingRateRow {
  return { id: r.id, service: null, model: null, name: r.name, currency: r.currency, input: r.input, cached: r.cached, output: r.output,
           // 常量兜底也是刊例/等值估算，不是回执 actual 账单。
           billing_kind: "equivalent-public-api", source_url: r.source, source_urls: [r.source],
           effective_at: "2026-10-31", fetched_at: "2026-10-31", stale: false, note: r.note };
}

/** 加载历史价卡版本（按 rateId 分组，时间升序）；表缺失时返回空 Map，估算回落常量。 */
export async function loadPricingVersions(db: Db): Promise<Map<string, PricingVersionRow[]>> {
  try {
    const rows = await db<PricingVersionRow[]>`
      SELECT rate_id AS "rateId", service, model, currency,
             input_price::float8 AS input, cached_price::float8 AS cached, output_price::float8 AS output,
             billing_kind AS "billingKind", effective_at::text AS "effectiveAt", fetched_at::text AS "fetchedAt"
      FROM pricing_rate_versions ORDER BY effective_at ASC`;
    const map = new Map<string, PricingVersionRow[]>();
    for (const r of rows) { const arr = map.get(r.rateId) ?? []; arr.push(r); map.set(r.rateId, arr); }
    return map;
  } catch {
    return new Map();
  }
}
// Cabinet's 2026 holiday notice; weekends remain off-peak, including make-up workdays.
const holidays=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function peakFactor(day:string,hour:number):CostBounds {
  const dow=new Date(`${day}T12:00:00Z`).getUTCDay();
  if(dow===0||dow===6||!(hour>=9&&hour<12||hour>=14&&hour<18))return {low:1,high:1};
  if(!day.startsWith('2026-'))return {low:1,high:2};
  const md=day.slice(5);const holiday=holidays.some(([a,b])=>md>=a&&md<=b);
  return {low:holiday?1:2,high:holiday?1:2};
}
export interface PricingBucket {
  service:string|null;model:string|null;day:string|null;hour:number|null;calls:number;pricedCalls:number;
  pricedIn:number;pricedOut:number;cachedTokens:number;unknownCacheIn:number;cacheUnknownCalls:number;
}
/**
 * 汇率单一来源：优先 fx_rates 表最新行（geohot-pricing-check timer 经官方 refreshFx 每日落库的
 * 欧洲央行价），无行时回落 CNY_FX 兜底常量（packages/contracts/src/cny.ts，商务部核验值）。
 * 独立成纯函数便于单测覆盖「有行/无行」两路。
 */
export function resolveFx(latest: { rate: number; as_of: string; source_url: string | null } | null | undefined): { usdToCny: number; date: string; source: string } {
  if (latest && Number.isFinite(latest.rate) && latest.rate > 0) {
    return { usdToCny: latest.rate, date: latest.as_of, source: latest.source_url ?? "https://api.frankfurter.app/latest?from=USD&to=CNY" };
  }
  return CNY_FX;
}

interface EffRate { id:string; name:string; currency:"USD"|"CNY"|null; input:number|null; cached:number|null; output:number|null; billingKind:string }

/** 常量兜底的型号归并；DB 版本优先时不走这里。 */
function constantId(b: PricingBucket): string | undefined {
  if (b.model === 'agnes-3.0-flash') return b.service === 'agnes-cn' ? 'agnes-cn' : b.service === 'llm' ? 'agnes' : undefined;
  if (b.model === 'glm-5.3-flash') return b.service === 'workbuddy-cn' ? 'glm53flash' : (b.service === 'workbuddy' || b.service === 'workbuddy-ai') ? 'glm53flash-intl' : undefined;
  return aliases[b.model ?? ''];
}

export function officialCosts(buckets:PricingBucket[],ready=true,fx:{usdToCny:number;date:string;source:string}=CNY_FX,versionsByRate?:Map<string,PricingVersionRow[]>):OfficialCostReport {
  const toCnyAt=(value:number,currency:string|null):number|null=>currency==='CNY'?value:currency==='USD'?value*fx.usdToCny:null;
  const report:OfficialCostReport={fx,state:ready?"ready":"backfill",verifiedOn,policy:"按调用时点有效的官方标准单价折算所选历史用量；无当时有效价卡的请求计为未计价，不用最新价倒算。不应用限免、赠送或促销价；DeepSeek 按请求开始时的北京时间峰谷规则计价。缓存明细缺失的请求按缓存命中价折算（单一口径），缺少完整 Token 的请求不计金额。美元按 fx_rates 表最新汇率（无记录时按常量兜底）折合人民币；汇总后取整显示，计算保留原始精度。",models:[],rates:OFFICIAL_RATES,totals:[],calls:0,pricedCalls:0,missingUsage:0,unmappedCalls:0,cacheUnknownCalls:0};
  const groups=new Map<string,OfficialCostReport['models'][number]>();
  for(const b of buckets){
    // 历史价：优先取该调用时点有效的版本；无版本再回落常量。订阅/免费/无价/未核实版本费率为 null，不计估算。
    const instant=startedInstant(b.day,b.hour);
    const v=versionsByRate?resolveVersionAt(versionsByRate,b.service,b.model,instant):null;
    let eff:EffRate|null;
    if(v){eff={id:v.rateId,name:v.model,currency:v.currency,input:v.input,cached:v.cached,output:v.output,billingKind:v.billingKind};}
    else{const r=OFFICIAL_RATES.find(x=>x.id===constantId(b));eff=r?{id:r.id,name:r.name,currency:r.currency,input:r.input,cached:r.cached,output:r.output,billingKind:"equivalent-public-api"}:null;}
    const key=JSON.stringify([b.service,b.model]);
    let m=groups.get(key);if(!m){m={service:b.service??'',model:b.model??'',name:eff?.name??b.model??'',currency:eff?.currency??null,rateId:eff?.id??null,calls:0,pricedCalls:0,missingUsage:0,cacheUnknownCalls:0,list:eff&&ready&&eff.input!=null?{low:0,high:0}:null,current:eff&&ready&&eff.input!=null?{low:0,high:0}:null,...(!eff||eff.input==null?{reason:!eff?"未核验上游型号或官方价格，未计入费用":"该通道为订阅/免费/无价/未核实，无逐 token 公开价，未计入估算"}:{})};groups.set(key,m);}
    m.calls+=b.calls;m.missingUsage+=b.calls-b.pricedCalls;m.cacheUnknownCalls+=b.cacheUnknownCalls;
    report.calls+=b.calls;report.missingUsage+=b.calls-b.pricedCalls;report.cacheUnknownCalls+=b.cacheUnknownCalls;
    if(!eff||eff.input==null||eff.output==null){report.unmappedCalls+=b.calls;continue;}
    m.pricedCalls+=b.pricedCalls;report.pricedCalls+=b.pricedCalls;
    if(!ready)continue;
    const factor=eff.id==='deepseek'?peakFactor(b.day!,b.hour!):{low:1,high:1};
    const knownMiss=Math.max(0,b.pricedIn-b.cachedTokens-b.unknownCacheIn);
    // 缓存未知按缓存命中价单一口径计：是估计，不是区间。
    const cached=eff.cached??eff.input;
    const base=knownMiss*eff.input+b.cachedTokens*cached+b.pricedOut*eff.output;
    m.list!.low+=(base+b.unknownCacheIn*cached)*factor.low/1e6;
    m.list!.high+=(base+b.unknownCacheIn*cached)*factor.high/1e6;
  }
  for(const m of groups.values()){if(!m.currency)continue;for(const type of ['list','current'] as const)if(m[type])m[type]={low:toCnyAt(m[type]!.low,m.currency)!,high:toCnyAt(m[type]!.high,m.currency)!};m.currency='CNY';}
  report.models=[...groups.values()].sort((a,b)=>b.calls-a.calls);
  // Legacy current fields mirror standard prices for older dashboard clients; no promotional calculation.
  for(const m of report.models) m.current=m.list?{...m.list}:null;
  if(ready)for(const m of report.models){if(!m.currency||!m.list||!m.current)continue;let t=report.totals.find(t=>t.currency===m.currency);if(!t){t={currency:m.currency,list:{low:0,high:0},current:{low:0,high:0}};report.totals.push(t);}for(const type of ['list','current'] as const){t[type].low+=m[type]!.low;t[type].high+=m[type]!.high;}}
  for(const t of report.totals)t.current={...t.list};
  return report;
}
