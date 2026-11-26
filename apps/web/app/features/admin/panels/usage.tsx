// 用量面板（原 /admin/usage 页的主体）。
// 2026-11-26 站长要求把用量总览、模型、审计记录、magpie 的主体功能并进运行看板：内容搬到这里，
// 由 /admin/ops?tab=usage 渲染；旧地址 302 到同一个面板，书签不会失效。
// 这个文件只保留「用量」独有的东西：日历热度、官方定价估算、按模型/任务/时段的排行。
// 与看板重复的部分（请求、费用、速度的实时指标卡）不再重复一份。
import { toCny, cnyInteger } from "@aihot/contracts/cny";
import type { OfficialCostReport } from "@aihot/contracts/model-costs";
import { beijingToday } from "@aihot/contracts/usage-date";
import { UsageCalendar, type UsageCalendarData } from "../usage-calendar";
import { OfficialCosts, unpricedModelCount } from "../official-costs";
import { useEffect, useMemo, useState } from "react";
import { Form, useRevalidator, useSearchParams } from "react-router";
import { Badge, Card } from "../ui";
import { bj, num } from "../format";
import { classifyUsageView, type UsageBackendState } from "../../../lib/usage-status";

export interface Metric {
  pricing?: OfficialCostReport;
  kind: string; service: string | null; model: string | null; purpose: string | null;
  day: string | null; dow: number | null; hour: number | null; currency: string | null;
  calls: number; ok: number; failed: number; pending: number; unknown: number;
  tokensIn: number; tokensOut: number; cachedTokens?: number; reasoningTokens: number | null; reasoningMissing: number; missingUsage: number; unpriced: number;
  actualCost: number | null; estimatedCost: number | null; latencyMs: number | null;
}
export interface Usage {
  date: string | null; calendar: UsageCalendarData; range: string; service: string; model: string;
  rows: Metric[];
  status: { state: UsageBackendState; asOf: string | null; message?: string };
}

// 取数在 usage.server.ts：组件文件不能直接 import `.server` 模块，路由构建会拒绝。

const compact = (n: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const value = (r: Metric, mode: string) => mode === "tokens" ? r.tokensIn + r.tokensOut : r.calls;
const names: Record<string, string> = { prefilter_article: "精选预筛", score_article: "精选评分", understand_article: "内容理解", summarize_article: "标题摘要", structure_article: "结构抽取", group_article: "事件归组", group_signal: "线索归组", group_review: "归组复核", story_digest: "事件综述", translate_body: "全文翻译", translate_quoted: "引用翻译", report_daily: "地理日报", report_weekly: "地理周报", report_monthly: "地理月报", report_lead: "报刊导语" };
function amount(n: number | null, currency: string | null, fx?: Parameters<typeof toCny>[2]) { return n === null ? "未返回" : `${cnyInteger(toCny(n, currency, fx))} 元`; }
function Cell({ n, max, label }: { n: number; max: number; label: string }) {
  return <span tabIndex={0} aria-label={label} title={label} className="block aspect-square min-w-0 rounded-[3px] outline-offset-2 focus:outline-2 focus:outline-accent"
    style={{ background: n ? `color-mix(in srgb, var(--accent) ${25 + 75 * Math.sqrt(n / Math.max(1, max))}%, var(--bg-sunk))` : "var(--bg-sunk)" }} />;
}
function Ranking({ rows, mode, kind, empty }: { rows: Metric[]; mode: string; kind: "model" | "purpose"; empty: boolean }) {
  const ordered = [...rows].sort((a, b) => value(b, mode) - value(a, mode));
  const max = Math.max(1, ...ordered.map((r) => value(r, mode)));
  if (!rows.length) return <p className="py-8 text-center text-ink-3">{empty ? "这个范围内没有调用记录。" : "数据暂未取得。"}</p>;
  return <div className="max-h-[420px] space-y-4 overflow-y-auto pr-2">{ordered.map((r, i) => <div key={`${r.service}/${r.model}/${r.purpose}`}>
    <div className="mb-1.5 flex justify-between gap-3 text-[13px]"><span className="min-w-0 break-all text-ink">{kind === "model" ? r.model : names[r.purpose ?? ""] ?? r.purpose}<span className="ml-2 text-ink-4">{kind === "model" ? r.service : ""}</span></span><span className="num shrink-0">{compact(value(r, mode))}</span></div>
    <div className="h-1.5 overflow-hidden rounded-full bg-bg-sunk"><div className="h-full rounded-full bg-accent" style={{ width: `${100 * value(r, mode) / max}%`, opacity: Math.max(.4, 1 - i * .035) }} /></div>
    <div className="mt-1 text-[11.5px] text-ink-4">{num(r.calls)} 次请求 · {r.calls ? Math.round(r.ok / r.calls * 100) : 0}% 返回成功{r.latencyMs !== null ? ` · 平均 ${(r.latencyMs / 1000).toFixed(1)} 秒` : ""}</div>
  </div>)}</div>;
}

export function UsagePanel({ data }: { data: Usage }) {
  // lastGood holds the last successful SAME-SCOPE payload so a transient reload failure does
  // not blank the page. It is rendered labelled stale, never as fresh realtime data.
  const [lastGood, setLastGood] = useState<Usage | null>(data.status.state === "error" ? null : data);
  useEffect(() => { if (data.status.state !== "error") setLastGood(data); }, [data]);
  const sameScope = (a: Usage | null) => a && a.range === data.range && a.date === data.date && a.service === data.service && a.model === data.model && a.calendar.month === data.calendar.month;
  const fallback = data.status.state === "error" && sameScope(lastGood) ? lastGood : null;
  const d = fallback ?? data;

  const today = d.calendar.today ?? beijingToday();
  const view = useMemo(() => classifyUsageView({
    statusState: d.status.state,
    asOf: d.status.asOf,
    totalCalls: d.rows.find((r) => r.kind === "total")?.calls ?? 0,
    range: d.range, selectedDate: d.date, today,
    hasFallback: !!fallback,
    loadError: d.status.state === "error" ? d.status.message ?? "用量数据加载失败。" : null,
  }), [d, today, fallback]);

  const [params, setParams] = useSearchParams();
  const refresh = useRevalidator();
  const [interval, setIntervalSeconds] = useState(30);
  const [mode, setMode] = useState("tokens");
  const tab = params.get("tab") ?? "usage";
  useEffect(() => {
    if (!interval && view.state !== "stale" && view.state !== "generating" && view.state !== "error") return;
    const run = () => { if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate(); };
    const delayMs = (view.state === "error" || view.state === "generating" ? 5 : view.state === "stale" ? 10 : interval) * 1000;
    const id = setInterval(run, delayMs);
    document.addEventListener("visibilitychange", run);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", run); };
  }, [interval, refresh.state, refresh.revalidate, view.state]);

  const total = d.rows.find((r) => r.kind === "total");
  const models = d.rows.filter((r) => r.kind === "model");
  const days = d.rows.filter((r) => r.kind === "day");
  const currencies = d.rows.filter((r) => r.kind === "currency" && r.currency);
  const fx = total?.pricing?.fx;
  const ledgerSum = (key: "actualCost" | "estimatedCost") => { const amounts = currencies.filter((r) => r[key] !== null).map((r) => toCny(r[key]!, r.currency, fx)).filter((n): n is number => n !== null); return amounts.length ? amounts.reduce((a, b) => a + b, 0) : null; };
  const end = new Date(`${d.date ?? today}T00:00:00+08:00`);
  const selectedCount = d.range === "all" ? 366 : d.range === "today" || d.range === "date" ? 1 : Number(d.range);
  const count = Math.max(91, selectedCount);
  const start = new Date(end.getTime() - (count - 1) * 86400000);
  const firstDay = start.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const padding = (new Date(`${firstDay}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((padding + count) / 7) * 7 }, (_, i) => { const index = i - padding; if (index < 0 || index >= count) return null; const day = new Date(start.getTime() + index * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }); return { day, selected: index >= count - selectedCount, row: days.find((r) => r.day === day) }; });
  const maxDay = Math.max(1, ...days.map((r) => value(r, mode)));
  const hours = d.rows.filter((r) => r.kind === "hour");
  const maxHour = Math.max(1, ...hours.map((r) => value(r, mode)));
  const setRange = (range: string) => { const q = new URLSearchParams(params); q.set("tab", tab); q.set("range", range); q.delete("date"); setParams(q, { preventScrollReset: true }); };
  const calendarHref = (updates: Record<string, string>) => { const q = new URLSearchParams(params); for (const [k, v] of Object.entries(updates)) q.set(k, v); return `?${q}`; };
  const control = "rounded-control border border-line bg-surface px-3 py-1.5 text-[13px] text-ink focus:outline-accent";
  const loading = refresh.state !== "idle";
  const unpricedModels = unpricedModelCount(total?.pricing);

  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-1 rounded-control bg-bg-sunk p-1">{[["today", "今天"], ["7", "7 天"], ["30", "30 天"], ["90", "90 天"], ["all", "全部"]].map(([v, l]) => <button key={v} aria-pressed={d.range === v} onClick={() => setRange(v)} className={`rounded-control px-3 py-1.5 text-[13px] ${d.range === v ? "bg-surface text-ink shadow-sm" : "text-ink-3"}`}>{l}</button>)}</div>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-4">
        {view.stale && <Badge tone="warn">数据滞后</Badge>}
        <span>{d.status.asOf ? `统计更新 ${bj(d.status.asOf)}` : "统计尚不可用"}</span>
        <select aria-label="自动刷新频率" className={control} value={interval} onChange={(e) => setIntervalSeconds(Number(e.target.value))}><option value={30}>30 秒刷新</option><option value={60}>60 秒刷新</option><option value={0}>手动刷新</option></select>
        <button className={control} disabled={loading} onClick={() => refresh.revalidate()}>{loading ? "刷新中…" : "刷新"}</button>
      </div>
    </div>

    {(view.state === "error" || view.state === "generating") && !fallback ? (
      <Card>
        <div className="flex flex-col items-start gap-3 py-4">
          <p role="status" className="text-ink-3">{view.notice}</p>
          {view.state === "error" && <p className="text-[12px] text-ink-4">上次成功更新：{d.status.asOf ? bj(d.status.asOf) : "无"}</p>}
          <button className="rounded-lg bg-ink px-4 py-2 text-white disabled:opacity-50" disabled={loading} onClick={() => refresh.revalidate()}>{loading ? "重试中…" : "立即重试"}</button>
        </div>
      </Card>
    ) : (
      <>
        <UsageCalendar calendar={d.calendar} date={d.date ?? (d.range === "today" ? today : null)} href={calendarHref} />
        {d.date && <p className="text-sm text-ink-2">正在查看 {d.date}（北京时间 00:00—次日 00:00）的用量。<button className="ml-3 text-accent" onClick={() => setRange("today")}>返回今天</button></p>}
        <Form key={`${d.service}/${d.model}`} className="flex flex-wrap gap-2" method="get">
          <input type="hidden" name="tab" value={tab} />
          <input type="hidden" name="range" value={d.range} />{d.date && <input type="hidden" name="date" value={d.date} />}<input type="hidden" name="month" value={d.calendar.month} />
          <input aria-label="服务筛选" className={control} name="service" placeholder="全部服务（输入服务名）" defaultValue={d.service} list="usage-services" />
          <datalist id="usage-services">{[...new Set(models.map((r) => r.service))].map((s) => <option key={s} value={s ?? ""} />)}</datalist>
          <input aria-label="模型筛选" className={control} name="model" placeholder="全部模型（输入模型名）" defaultValue={d.model} list="usage-models" />
          <datalist id="usage-models">{[...new Set(models.map((r) => r.model))].map((s) => <option key={s} value={s ?? ""} />)}</datalist>
          <button className={control} type="submit">筛选</button><button className={control} type="button" onClick={() => setParams({ tab, range: d.range, ...(d.date ? { date: d.date } : {}), month: d.calendar.month })}>清除筛选</button>
        </Form>

        {view.notice && <p role="status" className="rounded-control bg-amber/10 px-3 py-2 text-[13px] text-amber-ink">{view.notice}</p>}
        {view.state === "ready-empty" && <p className="text-[13px] text-ink-3">所选范围内没有调用记录；这是真实空数据，不是加载失败。</p>}

        <div className="grid grid-cols-2 overflow-hidden rounded-panel bg-surface ring-1 ring-line md:grid-cols-3 xl:grid-cols-6">
          {[
            ["请求次数", num(total?.calls ?? 0), `${num(total?.failed ?? 0)} 次失败`],
            ["已知 Token", compact((total?.tokensIn ?? 0) + (total?.tokensOut ?? 0)), `输入 ${compact(total?.tokensIn ?? 0)} · 输出 ${compact(total?.tokensOut ?? 0)}${total?.reasoningTokens != null ? ` · 思考 ${compact(total.reasoningTokens)}` : ""}`],
            ["成功返回率", `${total?.calls ? ((total.ok / total.calls) * 100).toFixed(1) : "—"}%`, "返回成功不等于内容入选"],
            ["执行中", num(total?.pending ?? 0), "上游结果尚未返回"],
            ["结果未知", num(total?.unknown ?? 0), "保留回执，待核验"],
            ["未计价请求", num(total?.unpriced ?? 0), unpricedModels ? `${unpricedModels} 个模型无公开价` : "不按零费用计入"],
          ].map(([label, n, sub]) => <div key={label} className="border-b border-r border-line p-4"><div className="num text-[25px] font-semibold tracking-tight text-ink">{n}</div><div className="mt-1 text-[13px] text-ink-2">{label}</div><div className="mt-1 text-[11px] text-ink-4">{sub}</div></div>)}
        </div>

        <OfficialCosts report={total?.pricing} />
        <Card title="用量趋势" right={<div className="flex gap-2">{[["tokens", "Token"], ["calls", "请求"]].map(([v, l]) => <button key={v} aria-pressed={mode === v} className={mode === v ? "font-medium text-accent" : "text-ink-4"} onClick={() => setMode(v)}>{l}</button>)}</div>}>
          <div className="mb-3 flex justify-between text-[12px] text-ink-4"><span>{firstDay} — {d.date ?? today}{d.range === "all" ? "（活动图展示最近一年）" : "（仅着色所选范围）"}</span><span>少 ··· 多</span></div>
          <div className="overflow-x-auto pb-2"><div className="grid grid-flow-col grid-rows-7 gap-[4px]" style={{ gridTemplateColumns: `repeat(${cells.length / 7},minmax(10px,1fr))`, minWidth: d.range === "all" ? 650 : undefined, maxWidth: cells.length / 7 * 20 }}>{cells.map((c, i) => c?.selected ? <Cell key={i} n={c.row ? value(c.row, mode) : 0} max={maxDay} label={`${c.day} · ${compact(c.row ? value(c.row, mode) : 0)} ${mode === "tokens" ? "已知 Token" : "次请求"}`} /> : <span key={i} title={c ? `${c.day} · 不在所选范围` : undefined} className="aspect-square rounded-[3px] border border-line-soft" />)}</div></div>
          <p className="mt-3 text-[12px] text-ink-4">{num(total?.missingUsage ?? 0)} 次请求未返回完整 Token 数据{total && total.reasoningMissing > 0 ? `；${num(total.reasoningMissing)} 次未返回思考 Token` : ""}；图表只累计已知值，思考 Token 单列展示、不并入输出、不重复计费。费用区间与缓存计价规则见上方官方定价估算。</p>
        </Card>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title="模型用量"><Ranking rows={models} mode={mode} kind="model" empty={view.state === "ready-empty"} /></Card>
          <Card title="任务用量"><Ranking rows={d.rows.filter((r) => r.kind === "purpose")} mode={mode} kind="purpose" empty={view.state === "ready-empty"} /></Card>
          <Card title="按时段" right="北京时间"><div className="overflow-x-auto"><div className="min-w-[380px] space-y-1">{Array.from({ length: 7 }, (_, i) => <div key={i} className="grid items-center gap-[3px]" style={{ gridTemplateColumns: "26px repeat(24,minmax(8px,1fr))" }}><span className="text-[11px] text-ink-4">周{["一", "二", "三", "四", "五", "六", "日"][i]}</span>{Array.from({ length: 24 }, (_, h) => { const r = hours.find((r) => r.dow === i + 1 && r.hour === h); return <Cell key={h} n={r ? value(r, mode) : 0} max={maxHour} label={`周${i + 1} ${h}:00 · ${compact(r ? value(r, mode) : 0)} ${mode === "tokens" ? "已知 Token" : "次请求"}`} />; })}</div>)}<div className="ml-7 flex justify-between text-[11px] text-ink-4"><span>0 时</span><span>6 时</span><span>12 时</span><span>18 时</span><span>23 时</span></div></div></div></Card>
          <Card title="上游账单记录"><div className="space-y-4"><div className="border-b border-line pb-3 text-[13px]"><p>上游实报 {amount(ledgerSum("actualCost"), "CNY", fx)}</p><p className="mt-1 text-ink-4">上游估算 {amount(ledgerSum("estimatedCost"), "CNY", fx)}</p></div><p className="text-[12px] leading-relaxed text-ink-3">统一折合人民币，汇总后四舍五入到元；实际金额与估算分开。未返回费用的请求不视为免费；此处不是上游账户余额或套餐剩余额度。</p></div></Card>
        </div>
      </>
    )}
  </>;
}

/** 旧的 /admin/usage 链接（含 ?range= / ?date= 等）由路由重定向到这里，参数原样带过去。 */
