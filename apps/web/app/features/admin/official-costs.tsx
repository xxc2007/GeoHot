import type { CostBounds, OfficialCostReport } from "@aihot/contracts/model-costs";
import { Card } from "./ui";

function money(n:number){return n.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4});}
function bounds(b:CostBounds|null){if(!b)return '未计入';return Math.abs(b.high-b.low)<.00000001?money(b.high):`${money(b.low)}–${money(b.high)}`;}
export function OfficialCosts({report:r}:{report?:OfficialCostReport}){
  if(!r||r.state!=='ready')return <Card className="mb-5" title="官方定价费用估算"><p role="status" className="text-ink-3">正在整理缓存用量明细，完成后显示费用。原始用量和实际账单不受影响。</p></Card>;
  return <Card className="mb-5" title="官方定价费用估算" right={`单价核验 ${r.verifiedOn}`}>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{r.totals.map(t=><div key={t.currency} className="rounded-control bg-bg-sunk p-4">
      <p className="text-[12px] text-ink-3">{t.currency} · 当前优惠价折算</p><p className="num mt-1 text-[26px] font-semibold text-accent">{bounds(t.current)}</p>
      <p className="mt-1 text-[13px] text-ink-3">标准标价折算 {bounds(t.list)}</p>
    </div>)}</div>
    <p className="mt-4 text-[13px] leading-relaxed text-ink-3">已计价 {r.pricedCalls.toLocaleString()} / {r.calls.toLocaleString()} 次请求；{r.missingUsage.toLocaleString()} 次缺少完整 Token，{r.unmappedCalls.toLocaleString()} 次型号或价格未核验。{r.cacheUnknownCalls.toLocaleString()} 次缓存明细缺失，按全部命中至全部未命中的上下界折算。各项缺失可能重叠。</p>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-4">{r.policy} 订阅、赠送额度和网关加价不包含在内；限免金额只适用于当前核验的优惠政策。</p>
    <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-[13px]"><caption className="sr-only">按模型和接入服务分别计算的官方价费用</caption>
      <thead className="text-ink-3"><tr>{['模型 / 服务','币种','当前优惠价折算','标准标价折算','计价请求 / 总请求'].map(h=><th key={h} className="whitespace-nowrap border-b border-line px-2 py-3 font-medium">{h}</th>)}</tr></thead>
      <tbody>{r.models.map(m=><tr key={`${m.service}/${m.model}`}><td className="max-w-[320px] break-all border-b border-line-soft px-2 py-3"><p>{m.name}</p><p className="mt-1 text-[11px] text-ink-4">{m.model} · {m.service}</p>{m.reason&&<p className="mt-1 text-[11px] text-ink-3">{m.reason}</p>}</td><td className="border-b border-line-soft px-2 py-3">{m.currency??'—'}</td><td className="num whitespace-nowrap border-b border-line-soft px-2 py-3">{bounds(m.current)}</td><td className="num whitespace-nowrap border-b border-line-soft px-2 py-3">{bounds(m.list)}</td><td className="num whitespace-nowrap border-b border-line-soft px-2 py-3">{m.pricedCalls.toLocaleString()} / {m.calls.toLocaleString()}</td></tr>)}</tbody>
    </table></div>
    <details className="mt-5 text-[12px]"><summary className="cursor-pointer text-accent">查看官方单价与来源（每百万 Token）</summary>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left"><thead><tr>{['模型','币种','输入 / 缓存输入 / 输出','当前优惠单价','计价说明'].map(h=><th key={h} className="whitespace-nowrap border-b border-line px-2 py-2 font-medium">{h}</th>)}</tr></thead><tbody>{r.rates.map(p=><tr key={p.id}><td className="whitespace-nowrap border-b border-line-soft px-2 py-3"><a className="text-accent underline underline-offset-4" href={p.source} target="_blank" rel="noreferrer">{p.name} ↗</a></td><td className="px-2">{p.currency}</td><td className="num whitespace-nowrap px-2">{p.input} / {p.cached} / {p.output}</td><td className="num whitespace-nowrap px-2">{p.currentInput} / {p.currentCached} / {p.currentOutput}</td><td className="min-w-[240px] border-b border-line-soft px-2 py-3 text-ink-3">{p.note}</td></tr>)}</tbody></table></div>
    </details>
  </Card>;
}
