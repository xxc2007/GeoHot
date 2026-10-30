import {CNY_FX} from "@aihot/contracts/cny";
import type { OfficialRate, OfficialCostReport, CostBounds } from "@aihot/contracts/model-costs";

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
  "MiniMax-M3.1-Flash":"minimax","minimax-code/MiniMax-M3.1-Flash":"minimax","dots3-note-prev":"dots",
};
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
  service:string|null;model:string|null;day:string|null;hour:number|null;calls:number;pricingCalls:number;
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

export function officialCosts(buckets:PricingBucket[],ready=true,fx:{usdToCny:number;date:string;source:string}=CNY_FX):OfficialCostReport {
  const toCnyAt=(value:number,currency:string|null):number|null=>currency==='CNY'?value:currency==='USD'?value*fx.usdToCny:null;
  const report:OfficialCostReport={fx,state:ready?"ready":"backfill",verifiedOn,policy:"按最新核验的官方标准单价折算所选历史用量，不应用限免、赠送或促销价；DeepSeek 按请求开始时的北京时间峰谷规则计价，不还原历史调价；不是实际账单或订阅扣款。缓存明细缺失的请求按缓存命中价折算（单一口径，不显示区间），缺少完整 Token 的请求不计金额。美元按 fx_rates 表最新汇率（无记录时按常量兜底）折合人民币；汇总后取整显示，计算保留原始精度。",models:[],rates:OFFICIAL_RATES,totals:[],calls:0,pricedCalls:0,missingUsage:0,unmappedCalls:0,cacheUnknownCalls:0};
  const groups=new Map<string,OfficialCostReport['models'][number]>();
  for(const b of buckets){
    const id=b.model==='agnes-3.0-flash'?(b.service==='agnes-cn'?'agnes-cn':b.service==='llm'?'agnes':undefined):b.model==='glm-5.3-flash'?(b.service==='workbuddy-cn'?'glm53flash':b.service==='workbuddy'||b.service==='workbuddy-ai'?'glm53flash-intl':undefined):aliases[b.model??''];
    const r=OFFICIAL_RATES.find(r=>r.id===id);const key=JSON.stringify([b.service,b.model]);
    let m=groups.get(key);if(!m){m={service:b.service??'',model:b.model??'',name:r?.name??b.model??'',currency:r?.currency??null,rateId:r?.id??null,calls:0,pricedCalls:0,missingUsage:0,cacheUnknownCalls:0,list:r&&ready?{low:0,high:0}:null,current:r&&ready?{low:0,high:0}:null,...(!r?{reason:"未核验上游型号或官方价格，未计入费用"}:{})};groups.set(key,m);}
    m.calls+=b.calls;m.missingUsage+=b.calls-b.pricingCalls;m.cacheUnknownCalls+=b.cacheUnknownCalls;
    report.calls+=b.calls;report.missingUsage+=b.calls-b.pricingCalls;report.cacheUnknownCalls+=b.cacheUnknownCalls;
    if(!r){report.unmappedCalls+=b.calls;continue;}
    m.pricedCalls+=b.pricingCalls;report.pricedCalls+=b.pricingCalls;
    if(!ready)continue;
    const factor=r.id==='deepseek'?peakFactor(b.day!,b.hour!):{low:1,high:1};
    const knownMiss=Math.max(0,b.pricedIn-b.cachedTokens-b.unknownCacheIn);
    // 缓存未知（unknownCacheIn）的请求按缓存命中价单一口径计：它是一个估计，不是区间——上下界
    // 各取 min/max 价曾把 6.1 万次缓存未知请求撑成 5,443–5,463 元的假区间；按 cached 价（大多数
    // 提供商对重复前缀给出命中）是这批请求最可能落的档，合计因此显示为单值。
    for(const type of ['list'] as const){
      const input=type==='list'?r.input:r.currentInput, cached=type==='list'?r.cached:r.currentCached, output=type==='list'?r.output:r.currentOutput;
      const base=knownMiss*input+b.cachedTokens*cached+b.pricedOut*output;
      m[type]!.low+=(base+b.unknownCacheIn*cached)*factor.low/1e6;
      m[type]!.high+=(base+b.unknownCacheIn*cached)*factor.high/1e6;
    }
  }
  for(const m of groups.values()){if(!m.currency)continue;for(const type of ['list','current'] as const)if(m[type])m[type]={low:toCnyAt(m[type]!.low,m.currency)!,high:toCnyAt(m[type]!.high,m.currency)!};m.currency='CNY';}
  report.models=[...groups.values()].sort((a,b)=>b.calls-a.calls);
  // Legacy current fields mirror standard prices for older dashboard clients; no promotional calculation.
  for(const m of report.models) m.current=m.list?{...m.list}:null;
  if(ready)for(const m of report.models){if(!m.currency||!m.list||!m.current)continue;let t=report.totals.find(t=>t.currency===m.currency);if(!t){t={currency:m.currency,list:{low:0,high:0},current:{low:0,high:0}};report.totals.push(t);}for(const type of ['list','current'] as const){t[type].low+=m[type]!.low;t[type].high+=m[type]!.high;}}
  for(const t of report.totals)t.current={...t.list};
  return report;
}
