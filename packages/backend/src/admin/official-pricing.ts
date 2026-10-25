import {CNY_FX,toCny} from "@aihot/contracts/cny";
import type { OfficialRate, OfficialCostReport, CostBounds } from "@aihot/contracts/model-costs";

const verifiedOn="2026-10-25";
function rate(id:string,name:string,currency:"USD"|"CNY",input:number,cached:number,output:number,source:string,note:string,free=false):OfficialRate {
  return {id,name,currency,input,cached,output,currentInput:free?0:input,currentCached:free?0:cached,currentOutput:free?0:output,source,note,verifiedOn};
}
export const OFFICIAL_RATES:OfficialRate[]=[
  rate("deepseek","DeepSeek V4.1 Flash","USD",.15,.003,.60,"https://api-docs.deepseek.com/quick_start/pricing/","谷时单价；工作日北京时间 09–12、14–18 时翻倍，中国法定节假日除外。已核验 2026 年节假日。"),
  rate("hy3","腾讯 HY3","CNY",1,.25,4,"https://hunyuan.tencent.com/research/hy3?langVersion=zh","腾讯官方 API 参考价；WorkBuddy 套餐实际扣费另计。"),
  rate("step5","Step 5 Preview","USD",1,.1,2.7,"https://platform.stepfun.ai/docs/en/guides/pricing/details","国际 API 官方参考价；不代表国内套餐实际扣费。"),
  rate("minimax","MiniMax M3.1 Flash","USD",.15,.015,.60,"https://www.minimax.io/blog/minimax-m31f","官方 API 参考价；MiniMax Code 订阅费用另计。"),
  rate("dots","Dots3 Note Preview","USD",.14,.14,.28,"https://dots.ai/platform/docs","当前限免；未公布独立缓存折扣，标准折算按普通输入计价。",true),
  rate("agnes","Agnes 3.0 Flash 国际版","USD",.05,.005,.15,"https://wiki.agnes-ai.com/en/docs/pricing","当前优惠价为零；标准标价单独保留。",true),
  rate("agnes-cn","Agnes 3.0 Flash 国内版","CNY",.35,.035,1,"https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash","当前优惠价为零；与国际版分开计价。",true),
];
const aliases:Record<string,string>={
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
export function officialCosts(buckets:PricingBucket[],ready=true):OfficialCostReport {
  const report:OfficialCostReport={fx:CNY_FX,state:ready?"ready":"backfill",verifiedOn,policy:"按当前核验的官方单价折算所选历史用量，不还原历史调价；不是实际账单或订阅扣款。缺少缓存明细时显示区间，缺少完整 Token 的请求不计金额。美元按已核验汇率折合人民币；汇总后取整显示，计算保留原始精度。",models:[],rates:OFFICIAL_RATES,totals:[],calls:0,pricedCalls:0,missingUsage:0,unmappedCalls:0,cacheUnknownCalls:0};
  const groups=new Map<string,OfficialCostReport['models'][number]>();
  for(const b of buckets){
    const id=b.model==='agnes-3.0-flash'?(b.service==='agnes-cn'?'agnes-cn':b.service==='llm'?'agnes':undefined):aliases[b.model??''];
    const r=OFFICIAL_RATES.find(r=>r.id===id);const key=JSON.stringify([b.service,b.model]);
    let m=groups.get(key);if(!m){m={service:b.service??'',model:b.model??'',name:r?.name??b.model??'',currency:r?.currency??null,rateId:r?.id??null,calls:0,pricedCalls:0,missingUsage:0,cacheUnknownCalls:0,list:r&&ready?{low:0,high:0}:null,current:r&&ready?{low:0,high:0}:null,...(!r?{reason:"未核验上游型号或官方价格，未计入费用"}:{})};groups.set(key,m);}
    m.calls+=b.calls;m.missingUsage+=b.calls-b.pricingCalls;m.cacheUnknownCalls+=b.cacheUnknownCalls;
    report.calls+=b.calls;report.missingUsage+=b.calls-b.pricingCalls;report.cacheUnknownCalls+=b.cacheUnknownCalls;
    if(!r){report.unmappedCalls+=b.calls;continue;}
    m.pricedCalls+=b.pricingCalls;report.pricedCalls+=b.pricingCalls;
    if(!ready)continue;
    const factor=r.id==='deepseek'?peakFactor(b.day!,b.hour!):{low:1,high:1};
    const knownMiss=Math.max(0,b.pricedIn-b.cachedTokens-b.unknownCacheIn);
    for(const type of ['list','current'] as const){
      const input=type==='list'?r.input:r.currentInput, cached=type==='list'?r.cached:r.currentCached, output=type==='list'?r.output:r.currentOutput;
      const base=knownMiss*input+b.cachedTokens*cached+b.pricedOut*output;
      m[type]!.low+=(base+b.unknownCacheIn*Math.min(input,cached))*factor.low/1e6;
      m[type]!.high+=(base+b.unknownCacheIn*Math.max(input,cached))*factor.high/1e6;
    }
  }
  for(const m of groups.values()){if(!m.currency)continue;for(const type of ['list','current'] as const)if(m[type])m[type]={low:toCny(m[type]!.low,m.currency)!,high:toCny(m[type]!.high,m.currency)!};m.currency='CNY';}
  report.models=[...groups.values()].sort((a,b)=>b.calls-a.calls);
  if(ready)for(const m of report.models){if(!m.currency||!m.list||!m.current)continue;let t=report.totals.find(t=>t.currency===m.currency);if(!t){t={currency:m.currency,list:{low:0,high:0},current:{low:0,high:0}};report.totals.push(t);}for(const type of ['list','current'] as const){t[type].low+=m[type]!.low;t[type].high+=m[type]!.high;}}
  return report;
}
