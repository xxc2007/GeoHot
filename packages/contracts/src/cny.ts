/** CFETS midpoint, last business day before verification. Reference conversion, not settlement FX. */
export const CNY_FX={usdToCny:6.718,date:"2026-10-23",source:"https://hzf.mofcom.gov.cn/article/zyfw/jrfw/jrfwwh/hlfxglzy/202610/8917.html"} as const;
export function toCny(value:number,currency:string|null):number|null {
  return currency==='CNY'?value:currency==='USD'?value*CNY_FX.usdToCny:null;
}
export function cnyInteger(value:number|null):string {
  if(value===null)return '未折算';
  if(value>0&&value<.5)return '＜1';
  return Math.round(value).toLocaleString('zh-CN',{maximumFractionDigits:0});
}
