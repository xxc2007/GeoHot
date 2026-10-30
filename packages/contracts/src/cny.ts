/** CFETS midpoint, last business day before verification. Reference conversion, not settlement FX.
 *  兜底常量：服务端费用折算优先读数据库 fx_rates 表的最新行（geohot-pricing-check timer 每日经
 *  官方 refreshFx 通道落库欧洲央行价），无行时才回落到这里的商务部核验值。 */
export const CNY_FX={usdToCny:6.718,date:"2026-10-23",source:"https://hzf.mofcom.gov.cn/article/zyfw/jrfw/jrfwwh/hlfxglzy/202610/8917.html"} as const;
export function toCny(value:number,currency:string|null):number|null {
  return currency==='CNY'?value:currency==='USD'?value*CNY_FX.usdToCny:null;
}
export function cnyInteger(value:number|null):string {
  if(value===null)return '未折算';
  if(value>0&&value<.5)return '＜1';
  return Math.round(value).toLocaleString('zh-CN',{maximumFractionDigits:0});
}
