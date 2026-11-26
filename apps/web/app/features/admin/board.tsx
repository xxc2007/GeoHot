// 运行看板的实时面板。
// 版式对齐 magpie 的用量页（站长 2026-11-26 指定）：筛选栏 → 指标卡 → 可切换维度的堆叠柱状图 →
// 模型速度表 → 能力池优先级 → 队列。数据一次来自 /api/admin/model-ops，筛选与维度都在 URL 上，
// 刷新页面或分享链接不会丢筛选。
import { useEffect, useMemo, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import { useAdminAction } from "./action";
import { bj, num } from "./format";
import { Badge, Button, Card, DataTable, Empty, Input, ReasonDialog, Select } from "./ui";

export interface OpsRow {
  service: string;
  model: string;
  calls: number;
  ok: number;
  bad: number;
  pending: number;
  unknown: number;
  avgMs: number;
  maxMs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  speedOut: number;
  speedMs: number;
  cost: number;
  costCalls: number;
}

export interface OpsStage {
  key: string;
  label: string;
  queue: string | null;
  purposes: string[];
  serving: string;
  source: "admin" | "env" | "default";
  pool: string[];
  poolFor: string;
  queued: number;
  active: number;
  retry: number;
  done: number;
  failed24h: number;
  lastDone: string | null;
  lastFailed: string | null;
  totals: Ops["totals"];
  models: Array<OpsRow & { poolRank: number | null; cooling: string | null }>;
}

export interface Ops {
  at: string;
  windowMinutes: number;
  filters: { purpose: string; service: string; model: string; status: string; dimension: Dimension };
  bucketMinutes: number;
  totals: {
    calls: number; ok: number; bad: number; pending: number; unknown: number; avgMs: number;
    tokensIn: number; tokensOut: number; tokensCached: number; tokensReasoning: number;
    speed: number | null; cacheHit: number | null; cacheCalls: number; cost: number | null; costCalls: number;
  };
  models: OpsRow[];
  series: { bucket: string; parts: { key: string; calls: number }[] }[];
  seriesKeys: string[];
  options: { purposes: string[]; services: string[]; models: string[]; statuses: string[] };
  queue: { state: string; n: number }[];
  active: Array<{ name: string; n: number }>;
  heartbeats: Array<{ key: string; role: string; at: string | null; load: number | null }>;
  capabilities: Array<{ key: string; label: string; source: "admin" | "env" | "default"; members: string[]; vision: boolean }>;
  catalog: Array<{ key: string; service: string; vision: boolean; jsonMode: boolean }>;
  workflow: { stages: OpsStage[]; unmapped: OpsStage | null };
  cooldowns: Array<{ model: string; service: string; category: string; until: number }>;
  /** 注册表 `default` 解析出的真实模型名（池里写 default，回执记的是这个名字）。 */
  defaultModel: string;
}

type Dimension = "model" | "service" | "purpose";

export interface Runs {
  checkedAt: string;
  queueSnapshot?: Array<{ name: string; queued: number; active: number; at: string }> | null;
  jobs: Array<{ job: string; started_at: string | null; finished_at: string | null; failed_24h: number; runs_24h: number; status?: string | null }>;
  receipts: { counts: Record<string, number>; unknownTotal: number };
  failedJobs: Array<{ name: string; failed: number; last: string; last_output: string | null }>;
}

const WINDOWS = [
  { value: "15", label: "15 分钟" },
  { value: "60", label: "1 小时" },
  { value: "360", label: "6 小时" },
  { value: "1440", label: "24 小时" },
  { value: "10080", label: "7 天" },
] as const;

const DIMENSIONS: Array<{ value: Dimension; label: string }> = [
  { value: "model", label: "按模型" },
  { value: "service", label: "按供应商" },
  { value: "purpose", label: "按用途" },
];

// 分类色板：两套主题下都够亮、彼此可分辨；「其它」固定灰色，避免和真模型撞色。
const PALETTE = ["#2f8f9d", "#c25a3f", "#c99a45", "#4f9d76", "#6a7fc1", "#a06fb0", "#4a90c2", "#b0654a"];
const OTHER_COLOR = "#8a8f98";

const STATE_LABEL: Record<string, string> = { created: "排队", active: "执行中", retry: "重试", completed: "完成", failed: "失败", cancelled: "取消" };
const STATUS_LABEL: Record<string, string> = { received: "成功", failed: "失败", pending: "执行中", unknown: "结果未知" };
const PURPOSE_LABEL: Record<string, string> = {
  prefilter_article: "精选预筛", score_article: "精选评分", understand_article: "内容理解", summarize_article: "标题摘要",
  structure_article: "结构抽取", group_article: "事件归组", group_signal: "线索归组", group_review: "归组复核",
  group_story: "事件合并", group_story_review: "合并复核", story_digest: "事件综述",
  translate_body: "全文翻译", translate_quoted: "引用翻译", translate_body_en: "英文全文翻译", translate_fact_titles_en: "英文事实标题",
  report_daily: "地理日报", report_weekly: "地理周报", report_weekly_en: "英文周报", report_monthly: "地理月报",
  report_lead: "报刊导语", report_lead_en: "英文导语", report_period_en: "英文期次", write_english: "英文写作",
};

const compact = (n: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (part: number, all: number, digits = 0) => (all > 0 ? `${((part / all) * 100).toFixed(digits)}%` : "—");
const secs = (ms: number | null | undefined) => (!ms ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
const rate = (ok: number, calls: number) => (calls ? ok / calls : 0);
/**
 * 输出速度 = 已知输出 token 合计 / 已知耗时合计（token/秒）。
 * 不能用「总 token ÷ 平均耗时」——那会把上千次调用摊成一次，算出几万 tok/s 的假数。
 */
const modelSpeed = (r: { speedOut: number; speedMs: number }) => (r.speedMs > 0 ? r.speedOut / (r.speedMs / 1000) : 0);
/**
 * 相对时间只在水合之后算：SSR 与浏览器各算一次「几分钟前」，跨过整分钟时文案不同，
 * React 会报 hydration mismatch（#418）。`now === null` 表示还没上屏，先给 —。
 */
function rel(iso: string | null, now: number | null) {
  if (!iso || now === null) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s} 秒前`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  return `${(s / 3600).toFixed(1)} 小时前`;
}
const purposeLabel = (key: string) => PURPOSE_LABEL[key] ?? key;
/** 派生行里 model/service 为空时按 `-` 分组；界面要说人话，不能让人去猜一个连字符。 */
const blankLabel = (key: string) => (key === "-" ? "未标注" : key);
const partLabel = (key: string, dimension: Dimension) =>
  key === "其它" ? "其它" : dimension === "purpose" ? purposeLabel(key) : blankLabel(key);
/** 池里写的是注册表 key（`default`），读者要看的是它此刻解析成的模型名。 */
const modelLabel = (key: string, defaultModel: string) =>
  key === "default" && defaultModel ? `default（${defaultModel}）` : key;

type SortKey = "calls" | "rate" | "avgMs" | "speed" | "cache" | "tokens" | "cost";

/** 一列能画多高就画多高：先把所有桶的最大值算出来，再按比例铺。 */
function StackedChart({ ops }: { ops: Ops }) {
  const max = Math.max(1, ...ops.series.map((b) => b.parts.reduce((s, p) => s + p.calls, 0)));
  const color = (key: string) => (key === "其它" ? OTHER_COLOR : PALETTE[Math.max(0, ops.seriesKeys.indexOf(key)) % PALETTE.length]!);
  if (!ops.series.length) return <Empty>这个窗口里没有调用记录。换个时间窗口，或清掉筛选。</Empty>;
  const label = (bucket: string) => (ops.bucketMinutes >= 1440 ? bucket.slice(5, 10) : bucket.slice(11));
  const step = Math.max(1, Math.ceil(ops.series.length / 12));
  return (
    <div>
      {/* items-stretch 是承重的：每列被拉到 176px 高，柱子写 height:N% 才有参照。
          用 items-end（列高 auto）时百分比按 auto 解析，实测整排柱子渲染成 0 高——
          图表看着有、其实是空的（2026-11-27 生产实测）。 */}
      <div className="flex h-44 items-stretch gap-[3px]" role="img" aria-label={`${ops.bucketMinutes} 分钟一格的调用量堆叠图`}>
        {ops.series.map((bucket) => {
          const total = bucket.parts.reduce((s, p) => s + p.calls, 0);
          return (
            <div key={bucket.bucket} className="flex min-w-0 flex-1 flex-col justify-end" title={`${label(bucket.bucket)} · ${num(total)} 次`}>
              <div className="flex flex-col-reverse overflow-hidden rounded-[2px]" style={{ height: `${Math.max(2, (total / max) * 100)}%` }}>
                {bucket.parts.map((part) => (
                  <div key={part.key} style={{ height: `${(part.calls / Math.max(1, total)) * 100}%`, background: color(part.key) }}
                    title={`${label(bucket.bucket)} · ${partLabel(part.key, ops.filters.dimension)} · ${num(part.calls)} 次`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-[3px] text-[10.5px] text-ink-4">
        {ops.series.map((bucket, i) => (
          <span key={bucket.bucket} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{i % step === 0 ? label(bucket.bucket) : ""}</span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {ops.seriesKeys.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
            <span className="size-2.5 rounded-[2px]" style={{ background: color(key) }} />
            <span className="max-w-[220px] truncate" title={key}>{partLabel(key, ops.filters.dimension)}</span>
          </span>
        ))}
        <span className="text-[11.5px] text-ink-4">每格 {ops.bucketMinutes >= 1440 ? "1 天" : `${ops.bucketMinutes} 分钟`} · 峰值 {num(max)} 次</span>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-hot-ink" : tone === "warn" ? "text-amber-ink" : "text-ink";
  return (
    <div className="min-w-0 rounded-panel bg-surface px-4 py-3 ring-1 ring-line">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={`num mt-1 truncate text-[21px] font-semibold tracking-tight ${color}`}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11.5px] text-ink-4">{sub}</div>}
    </div>
  );
}

/**
 * 一个工作流环节：摘要行给「队列那一侧」的数字（排队/执行中/窗口完成/24h 失败/最近成功与失败），
 * 展开给「模型那一侧」的明细（池内位次、冷却、调用、成功率、耗时、速度、缓存、Token、费用、最近调用）。
 * 站长 2026-11-27 要的是「实时看到每个环节和它调的模型」——所以两半放在同一行的展开里，
 * 而不是又拆成两张表让人自己对。
 */
function StageRow({ stage, now, defaultModel, muted }: { stage: OpsStage; now: number | null; defaultModel: string; muted?: boolean }) {
  const t = stage.totals;
  const backlog = stage.queued > 1000 ? "text-hot-ink" : stage.queued > 200 ? "text-amber-ink" : "text-ink-2";
  return (
    <details className="group border-b border-line/60 py-2 last:border-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 [&::-webkit-details-marker]:hidden">
        <span className={`min-w-[220px] flex-1 text-[13px] font-medium ${muted ? "text-ink-3" : "text-ink"}`}>
          <span aria-hidden className="mr-1 inline-block text-ink-4 transition-transform group-open:rotate-90">▸</span>
          {stage.label}
        </span>
        {stage.queue
          ? <span className="num whitespace-nowrap text-[12px] text-ink-3">排队 <b className={backlog}>{num(stage.queued)}</b> · 执行中 {num(stage.active)}{stage.retry ? ` · 重试 ${num(stage.retry)}` : ""}</span>
          : <span className="whitespace-nowrap text-[12px] text-ink-4">无队列（定时触发）</span>}
        <span className="num whitespace-nowrap text-[12px] text-ink-4">窗口完成 {num(stage.done)} · 24h 失败 {num(stage.failed24h)}</span>
        <span className="whitespace-nowrap text-[12px] text-ink-4">
          最近成功 {rel(stage.lastDone, now)}{stage.lastFailed ? ` · 最近失败 ${rel(stage.lastFailed, now)}` : ""}
        </span>
        <span className="num whitespace-nowrap text-[12px] text-ink-2">
          调用 {num(t.calls)} · 成功 {pct(t.ok, t.calls)} · {secs(t.avgMs)}{t.speed !== null ? ` · ${t.speed.toFixed(1)} tok/s` : ""}
        </span>
        {/* 「配置里的首选」和「实际在跑的」经常不是同一个（各执行器的 env 不同），
            所以摘要行直接把窗口内调用最多的那个模型写出来——这才是读者要看的真相。 */}
        {stage.models.length > 0 && (
          <span className="whitespace-nowrap text-[12px] text-ink-3">
            实际主力 <b className="font-mono">{blankLabel(stage.models[0]!.model)}</b>
            <span className="text-ink-4">（{num(stage.models[0]!.calls)} 次{stage.models.length > 1 ? `，共 ${stage.models.length} 个模型` : ""}）</span>
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-2 pl-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* 池读的是**这台服务器**的环境变量；真正派发的可能是别的执行器（instabox 的
              /opt/geohot-exec/.env 与这里不同），所以措辞写清「本机」，别让人误当成全网配置。 */}
          <span className="text-[11.5px] text-ink-4">本机配置的模型池{stage.poolFor ? ` · ${stage.poolFor}` : ""}（左为首选，来源 {stage.source === "admin" ? "后台覆盖" : stage.source === "env" ? "本机环境变量" : "代码默认"}；实际派发可能在其他执行器）：</span>
          {stage.pool.length === 0
            ? <span className="text-[11.5px] text-ink-4">（不经过模型）</span>
            : <>
              {stage.pool.slice(0, 6).map((m, i) => (
                <Badge key={`${stage.key}-${m}`} tone={i === 0 ? "ok" : "muted"} title={m}>{i + 1}. {modelLabel(m, defaultModel)}</Badge>
              ))}
              {stage.pool.length > 6 && <span className="text-[11.5px] text-ink-4">等 {stage.pool.length} 个</span>}
            </>}
        </div>
        {stage.purposes.length > 0 && (
          <div className="text-[11.5px] text-ink-4">用途：{stage.purposes.map((p) => `${purposeLabel(p)}（${p}）`).join(" · ")}</div>
        )}
        {stage.models.length === 0 ? (
          <div className="text-[12px] text-ink-4">窗口内这个环节没有模型调用。</div>
        ) : (
          <DataTable
            dense
            rows={stage.models}
            rowKey={(m) => `${m.service}|${m.model}`}
            columns={[
              { key: "rank", label: "本机池", className: "whitespace-nowrap", render: (m) => (m.poolRank ? `#${m.poolRank}` : <span className="text-ink-4" title="不在本机配置的任何池里：可能由其他执行器按自己的环境变量派发">—</span>) },
              { key: "m", label: "模型", className: "whitespace-nowrap", render: (m) => <span className="font-mono text-[12px]">{blankLabel(m.model)}<span className="text-ink-4"> · {blankLabel(m.service)}</span></span> },
              { key: "calls", label: "调用", align: "right", render: (m) => <span className="whitespace-nowrap">{num(m.calls)}</span> },
              { key: "rate", label: "成功率", align: "right", render: (m) => <Badge tone={m.bad === 0 ? "ok" : rate(m.ok, m.calls) < 0.5 ? "bad" : "warn"}>{pct(m.ok, m.calls)}</Badge> },
              { key: "avg", label: "平均耗时", align: "right", render: (m) => <span className="whitespace-nowrap">{secs(m.avgMs)}</span> },
              { key: "speed", label: "输出速度", align: "right", render: (m) => <span className="whitespace-nowrap">{m.speedMs > 0 ? `${modelSpeed(m).toFixed(1)} tok/s` : "—"}</span> },
              { key: "cache", label: "缓存", align: "right", render: (m) => <span className="whitespace-nowrap">{m.tokensIn > 0 ? pct(m.tokensCached, m.tokensIn) : "—"}</span> },
              { key: "tok", label: "Token", align: "right", render: (m) => <span className="whitespace-nowrap" title={`输入 ${num(m.tokensIn)} · 输出 ${num(m.tokensOut)}`}>{compact(m.tokensIn + m.tokensOut)}</span> },
              { key: "cost", label: "费用", align: "right", render: (m) => (m.cost ? <span className="whitespace-nowrap">{m.cost.toFixed(3)} 元</span> : <span className="text-ink-4">未返回</span>) },
              { key: "state", label: "状态", render: (m) => (m.cooling ? <Badge tone="warn">冷却：{m.cooling}</Badge> : <span className="text-ink-4">正常</span>) },
            ]}
          />
        )}
      </div>
    </details>
  );
}

export function BoardPanel({ ops, runs }: { ops: Ops; runs: Runs | null }) {
  const [params, setParams] = useSearchParams();
  const refresh = useRevalidator();
  const { run, pending } = useAdminAction();
  const [edit, setEdit] = useState<{ key: string; label: string; members: string[]; source: string; vision: boolean } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "calls", desc: true });
  // 相对时间要等水合完成再算（见文件顶部 rel 的说明），顺便每 30 秒走一格。
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh.state, refresh.revalidate]);

  const setParam = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const t = ops.totals;
  const worker = ops.heartbeats.find((h) => h.key === "heartbeat.worker");
  const workerFresh = worker?.at && now !== null ? now - new Date(worker.at).getTime() < 180_000 : false;

  const rows = useMemo(() => {
    const value: Record<SortKey, (r: OpsRow) => number> = {
      calls: (r) => r.calls,
      rate: (r) => rate(r.ok, r.calls),
      avgMs: (r) => r.avgMs,
      speed: modelSpeed,
      cache: (r) => (r.tokensIn > 0 ? r.tokensCached / r.tokensIn : 0),
      tokens: (r) => r.tokensIn + r.tokensOut,
      cost: (r) => r.cost,
    };
    return [...ops.models].sort((a, b) => (value[sort.key](b) - value[sort.key](a)) * (sort.desc ? 1 : -1));
  }, [ops.models, sort]);

  const head = (key: SortKey, labelText: string) => ({
    label: (
      <button type="button" className={sort.key === key ? "font-semibold text-ink" : "text-ink-3"} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
        {labelText}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    ),
  });

  const anyFilter = !!(ops.filters.purpose || ops.filters.service || ops.filters.model || ops.filters.status);
  const control = "rounded-control border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink focus:outline-accent";

  return (
    <>
      <Card pad={false}>
        <div className="flex flex-col gap-2.5 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 rounded-control bg-bg-sunk p-1">
              {WINDOWS.map((w) => (
                <button key={w.value} type="button" aria-pressed={String(ops.windowMinutes) === w.value} onClick={() => setParam({ window: w.value })}
                  className={`rounded-control px-2.5 py-1 text-[12.5px] ${String(ops.windowMinutes) === w.value ? "bg-surface text-ink shadow-sm" : "text-ink-3"}`}>{w.label}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 rounded-control bg-bg-sunk p-1">
              {DIMENSIONS.map((d) => (
                <button key={d.value} type="button" aria-pressed={ops.filters.dimension === d.value} onClick={() => setParam({ dimension: d.value })}
                  className={`rounded-control px-2.5 py-1 text-[12.5px] ${ops.filters.dimension === d.value ? "bg-surface text-ink shadow-sm" : "text-ink-3"}`}>{d.label}</button>
              ))}
            </div>
            <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-4">
              <Badge tone={workerFresh ? "ok" : "warn"}>{worker ? `worker ${rel(worker.at, now)}` : "worker 无心跳"}</Badge>
              <span>更新 {bj(ops.at)}</span>
              <Button size="sm" tone="ghost" disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>刷新</Button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="用途" className={`${control} !w-auto`} value={ops.filters.purpose} onChange={(e) => setParam({ purpose: e.target.value })}>
              <option value="">全部用途</option>
              {ops.options.purposes.map((p) => <option key={p} value={p}>{purposeLabel(p)}（{p}）</option>)}
            </Select>
            <Select aria-label="供应商" className={`${control} !w-auto`} value={ops.filters.service} onChange={(e) => setParam({ service: e.target.value })}>
              <option value="">全部供应商</option>
              {ops.options.services.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Select aria-label="模型" className={`${control} !w-auto max-w-[260px]`} value={ops.filters.model} onChange={(e) => setParam({ model: e.target.value })}>
              <option value="">全部模型</option>
              {ops.options.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <Select aria-label="状态" className={`${control} !w-auto`} value={ops.filters.status} onChange={(e) => setParam({ status: e.target.value })}>
              <option value="">全部状态</option>
              {ops.options.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
            </Select>
            {anyFilter && <Button size="sm" tone="ghost" onClick={() => setParams(Object.fromEntries([...params].filter(([k]) => k === "window" || k === "dimension" || k === "tab")), { replace: true, preventScrollReset: true })}>清除筛选</Button>}
            <span className="text-[11.5px] text-ink-4">统计口径：派生读模型，按每次上游尝试计；只含 live 调用。</span>
          </div>
        </div>
      </Card>

      {!runs && (
        <Card>
          <p role="status" className="text-[13.5px] text-ink-2">
            队列统计正在生成或连接暂时不可用，页面会自动更新；尚未取得数据，<b>不代表队列为空或工作流停止</b>。
          </p>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Metric label="Token 总量" value={compact(t.tokensIn + t.tokensOut)}
          sub={`输入 ${compact(t.tokensIn)} · 输出 ${compact(t.tokensOut)}${t.tokensReasoning ? ` · 思考 ${compact(t.tokensReasoning)}` : ""}`} />
        <Metric label="请求次数" value={num(t.calls)} sub={`成功 ${num(t.ok)} · 失败 ${num(t.bad)}${t.pending ? ` · 执行中 ${num(t.pending)}` : ""}`} />
        <Metric label="上游费用" value={t.cost === null ? "—" : `${t.cost.toFixed(2)} 元`}
          sub={t.costCalls ? `按 ${num(t.costCalls)} 次实报费用` : "上游未返回实际费用"} />
        <Metric label="缓存命中率" value={t.cacheHit === null ? "—" : pct(t.cacheHit, 1, 1)}
          sub={t.cacheCalls ? `${compact(t.tokensCached)} / ${compact(t.tokensIn)} 输入 token` : "上游未报告缓存"} />
        <Metric label="输出速度" value={t.speed === null ? "—" : `${t.speed.toFixed(1)} tok/s`} sub={`平均耗时 ${secs(t.avgMs)}`} />
        <Metric label="成功率" value={pct(t.ok, t.calls, 1)} sub={t.unknown ? `结果未知 ${num(t.unknown)} 次` : "按上游返回判定"}
          tone={t.calls === 0 ? undefined : rate(t.ok, t.calls) < 0.9 ? "warn" : "ok"} />
      </div>

      <Card title="调用节奏" right={<span>每格 {ops.bucketMinutes >= 1440 ? "1 天" : `${ops.bucketMinutes} 分钟`} · {DIMENSIONS.find((d) => d.value === ops.filters.dimension)?.label}</span>}>
        <StackedChart ops={ops} />
      </Card>

      <Card title="模型速度与用量" pad={false} right={<span>{rows.length} 个模型 · 点表头排序</span>}>
        {rows.length === 0 ? (
          <div className="p-4"><Empty>窗口内没有模型调用。换一个时间窗口，或确认执行器正在领取任务。</Empty></div>
        ) : (
          <DataTable
            dense
            rows={rows}
            rowKey={(r) => `${r.service}|${r.model}`}
            columns={[
              { key: "m", label: "模型", render: (r) => <span className="whitespace-nowrap font-mono text-[12px]">{blankLabel(r.model)}<span className="text-ink-4"> · {blankLabel(r.service)}</span></span> },
              { key: "calls", ...head("calls", "请求"), align: "right", render: (r) => <span className="whitespace-nowrap">{num(r.calls)}</span> },
              { key: "rate", ...head("rate", "成功率"), align: "right", render: (r) => <Badge tone={r.bad === 0 ? "ok" : rate(r.ok, r.calls) < 0.5 ? "bad" : "warn"}>{pct(r.ok, r.calls)}</Badge> },
              { key: "avg", ...head("avgMs", "平均耗时"), align: "right", render: (r) => <span className="whitespace-nowrap">{secs(r.avgMs)}</span> },
              { key: "speed", ...head("speed", "输出速度"), align: "right", render: (r) => <span className="whitespace-nowrap">{r.speedMs > 0 ? `${modelSpeed(r).toFixed(1)} tok/s` : "—"}</span> },
              { key: "cache", ...head("cache", "缓存"), align: "right", render: (r) => <span className="whitespace-nowrap">{r.tokensIn > 0 ? pct(r.tokensCached, r.tokensIn) : "—"}</span> },
              { key: "tok", ...head("tokens", "Token"), align: "right", render: (r) => <span className="num whitespace-nowrap" title={`输入 ${num(r.tokensIn)} · 输出 ${num(r.tokensOut)}`}>{compact(r.tokensIn + r.tokensOut)}</span> },
              { key: "cost", ...head("cost", "费用"), align: "right", render: (r) => (r.cost ? `${r.cost.toFixed(3)} 元` : <span className="text-ink-4">未返回</span>) },
              { key: "bad", label: "失败", align: "right", render: (r) => <span className="whitespace-nowrap">{r.bad ? <span className="text-hot-ink">{num(r.bad)}</span> : <span className="text-ink-4">0</span>}</span> },
            ]}
          />
        )}
      </Card>

      <Card title="信息工作流（每个环节的实时状态）"
        right={<span className="text-[11.5px]">队列数来自 pg-boss，调用数按用途统计 · 点开看该环节用到的每个模型</span>}>
        <div className="space-y-0.5">
          {ops.workflow.stages.map((s) => <StageRow key={s.key} stage={s} now={now} defaultModel={ops.defaultModel} />)}
          {ops.workflow.unmapped && <StageRow stage={ops.workflow.unmapped} now={now} defaultModel={ops.defaultModel} muted />}
        </div>
      </Card>

      <Card title="各步骤的模型池（顺序即优先级，第一名为首选）" right={<span>按本机环境变量显示；后台覆盖对所有执行器生效 · 写入即审计</span>}>
        <div className="space-y-2">
          {ops.capabilities.map((c) => (
            <div key={c.key} className="flex flex-wrap items-center gap-2 border-b border-line/60 pb-2 last:border-0">
              <div className="min-w-[200px] flex-1">
                <div className="text-[13px] font-medium text-ink">{c.label}</div>
                <div className="text-[11.5px] text-ink-4">{c.key} · {c.source === "admin" ? "后台设置" : c.source === "env" ? "环境变量" : "代码默认"}{c.vision ? " · 需要视觉" : ""}</div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {c.members.length === 0 ? <span className="text-[12px] text-ink-4">（继承全局 MODEL_POOL）</span> : <>
                  {c.members.slice(0, 4).map((m, i) => (
                    <Badge key={`${c.key}-${m}-${i}`} tone={i === 0 ? "ok" : "muted"} title={m}>{i + 1}. {modelLabel(m, ops.defaultModel)}</Badge>
                  ))}
                  {/* 继承的池可能有几十个成员：这里只列前四个，其余折成计数，否则十二个步骤各排一整屏。 */}
                  {c.members.length > 4 && <span className="text-[11.5px] text-ink-4">等 {c.members.length} 个</span>}
                </>}
              </div>
              <Button size="sm" tone="ghost" onClick={() => setEdit({ key: c.key, label: c.label, members: [...c.members], source: c.source, vision: c.vision })}>调整顺序</Button>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="队列与执行中">
          <div className="flex flex-wrap gap-2">
            {ops.queue.map((q) => <Badge key={q.state} tone={q.state === "failed" ? "bad" : q.state === "active" ? "ok" : "muted"}>{STATE_LABEL[q.state] ?? q.state} {num(q.n)}</Badge>)}
          </div>
          {ops.active.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
              {ops.active.map((a) => <span key={a.name} className="font-mono">{a.name} ×{a.n}</span>)}
            </div>
          )}
        </Card>
        <Card title="回执与失败" pad={false}>
          <div className="grid grid-cols-2 divide-x divide-line">
            <div className="p-4"><div className="text-[12px] text-ink-3">结果未知回执</div><div className="num mt-1 text-[19px] font-semibold">{runs ? num(runs.receipts.unknownTotal) : "—"}</div></div>
            <div className="p-4"><div className="text-[12px] text-ink-3">24h 失败任务</div><div className="num mt-1 text-[19px] font-semibold">{runs ? num(runs.failedJobs.reduce((s, f) => s + f.failed, 0)) : "—"}</div></div>
          </div>
          {runs && runs.failedJobs.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              {runs.failedJobs.slice(0, 4).map((f) => (
                <div key={f.name} className="flex items-start justify-between gap-2 py-0.5 text-[12px]">
                  <span className="font-mono text-ink-2">{f.name}</span>
                  <span className="num shrink-0 text-ink-4">{f.failed} 次 · {rel(f.last, now)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="worker 心跳" pad={false}>
          <div className="divide-y divide-line">
            {ops.heartbeats.length === 0 && <div className="p-4 text-[12.5px] text-ink-3">还没有任何心跳记录。</div>}
            {ops.heartbeats.map((h) => (
              <div key={h.key} className="flex items-center justify-between gap-2 px-4 py-2 text-[12.5px]">
                <span className="min-w-0 truncate font-mono text-ink-2">{h.key.replace(/^heartbeat\./, "")}</span>
                <span className="shrink-0 text-ink-4">{rel(h.at, now)}{h.load !== null ? ` · load ${h.load}` : ""}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="各队列排队量" pad={false}>
          {runs?.queueSnapshot?.length ? (
            <DataTable dense rows={runs.queueSnapshot} rowKey={(q) => q.name} columns={[
              { key: "n", label: "队列", render: (q) => <span className="font-mono text-[12.5px]">{q.name}</span> },
              { key: "q", label: "排队及重试", align: "right", render: (q) => num(q.queued) },
              { key: "a", label: "执行中", align: "right", render: (q) => num(q.active) },
            ]} />
          ) : <div className="p-4"><Empty>队列快照暂不可用（数据库繁忙时会跳过这一项）。</Empty></div>}
        </Card>
        <Card title="定时任务" pad={false}>
          {runs?.jobs?.length ? (
            <DataTable dense rows={runs.jobs} rowKey={(j) => j.job} columns={[
              { key: "j", label: "任务", render: (j) => <span className="font-mono text-[12.5px]">{j.job}</span> },
              { key: "s", label: "上次", render: (j) => <Badge tone={j.status === "failed" ? "bad" : j.status === "running" ? "warn" : "ok"}>{j.status === "failed" ? "失败" : j.status === "running" ? "运行中" : "成功"}</Badge> },
              { key: "at", label: "时间", render: (j) => <span className="num whitespace-nowrap text-[12px]">{rel(j.started_at, now)}</span> },
              { key: "d", label: "耗时", align: "right", render: (j) => (j.started_at && j.finished_at ? secs(new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) : "—") },
              { key: "f", label: "24h 失败", align: "right", render: (j) => (j.failed_24h ? <span className="text-hot-ink">{j.failed_24h}/{j.runs_24h}</span> : `0/${j.runs_24h}`) },
            ]} />
          ) : <div className="p-4"><Empty>没有定时任务的运行记录。</Empty></div>}
        </Card>
      </div>

      <PoolDialog
        edit={edit}
        catalog={ops.catalog}
        busy={pending === "pool"}
        onClose={() => setEdit(null)}
        onSave={async (members, reason, reset) =>
          (await run("POST", "/api/admin/model-ops/pool", { capability: edit!.key, members, reason, reset }, { label: "pool", success: reset ? "已恢复继承，下一次调用生效" : "顺序已保存，下一次调用生效" })) !== null
        }
      />
    </>
  );
}

/**
 * 模型池排序对话框。
 * 2026-11-26 现场：能力池可能继承 MODEL_POOL 的几十个模型，旧对话框把它们平铺在弹窗里，超出屏幕、
 * 底部按钮点不到，而且一起提交必然超过 8 个上限。现在分三块：已选（可上下移/移除）、候选（可搜）、
 * 恢复继承。写入只提交「已选」这一串，顺序就是优先级。
 */
function PoolDialog({ edit, catalog, busy, onClose, onSave }: {
  edit: { key: string; label: string; members: string[]; source: string; vision: boolean } | null;
  catalog: Ops["catalog"];
  busy: boolean;
  onClose: () => void;
  onSave: (members: string[], reason: string, reset: boolean) => Promise<boolean>;
}) {
  const [members, setMembers] = useState<string[]>([]);
  const [picked, setPicked] = useState(true);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"custom" | "reset">("custom");

  useEffect(() => {
    if (!edit) return;
    // 继承来的池可能比写入上限还长：默认只带上前 8 个，剩下的留在候选区，由操作者决定要不要换。
    setMembers(edit.members.slice(0, 8));
    setPicked(true);
    setQuery("");
    setMode("custom");
  }, [edit]);

  if (!edit) return null;
  const limit = 8;
  const move = (i: number, delta: number) => setMembers((m) => {
    const j = i + delta;
    if (j < 0 || j >= m.length) return m;
    const next = [...m];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });
  const remove = (i: number) => setMembers((m) => m.filter((_, k) => k !== i));
  const add = (key: string) => setMembers((m) => (m.includes(key) || m.length >= limit ? m : [...m, key]));
  const pickable = catalog
    .filter((c) => (edit.vision ? c.vision : !c.vision || c.vision))
    .filter((c) => (query ? c.key.toLowerCase().includes(query.toLowerCase()) || c.service.toLowerCase().includes(query.toLowerCase()) : true))
    .sort((a, b) => a.key.localeCompare(b.key));

  return (
    <ReasonDialog
      open
      wide
      title={`调整模型池：${edit.label}`}
      description={`第一位是首选，后面的按顺序兜底，最多 ${limit} 个。当前来源：${edit.source === "admin" ? "后台设置" : edit.source === "env" ? "环境变量" : "代码默认"}${edit.members.length > limit ? `（继承的池有 ${edit.members.length} 个，保存后只派发你排的这几个）` : ""}。`}
      confirmLabel={mode === "reset" ? "恢复继承" : "保存顺序"}
      busy={busy}
      onClose={onClose}
      onSubmit={async (reason) => onSave(mode === "reset" ? [] : members, reason, mode === "reset")}
    >
      <div className="flex gap-1 rounded-control bg-bg-sunk p-1 text-[12.5px]">
        <button type="button" aria-pressed={mode === "custom"} onClick={() => setMode("custom")} className={`rounded-control px-2.5 py-1 ${mode === "custom" ? "bg-surface text-ink shadow-sm" : "text-ink-3"}`}>自定义顺序</button>
        <button type="button" aria-pressed={mode === "reset"} onClick={() => setMode("reset")} className={`rounded-control px-2.5 py-1 ${mode === "reset" ? "bg-surface text-ink shadow-sm" : "text-ink-3"}`}>恢复继承全局池</button>
      </div>

      {mode === "reset" ? (
        <p className="rounded-control bg-amber/10 px-3 py-2 text-[12.5px] text-amber-ink">
          会删掉这个步骤的后台覆盖，回到环境变量或全局 MODEL_POOL 的顺序。只影响之后的新任务。
        </p>
      ) : (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px] text-ink-4">
              <span>已选 {members.length} / {limit}（从上到下次序即优先级）</span>
              <button type="button" className="text-ink-3 hover:text-ink" onClick={() => setPicked((v) => !v)}>{picked ? "收起" : "展开"}</button>
            </div>
            {picked && (
              <div className="max-h-[38vh] overflow-y-auto rounded-control border border-line-soft">
                {members.length === 0 && <div className="px-3 py-3 text-[12.5px] text-ink-4">还没有选模型。从下面添加。</div>}
                {members.map((m, i) => (
                  <div key={m} className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1 last:border-0">
                    <span className="num w-5 shrink-0 text-[11.5px] text-ink-4">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={m}>{m}</span>
                    {i === 0 && <Badge tone="ok">首选</Badge>}
                    <button type="button" aria-label={`上移 ${m}`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded px-1.5 text-ink-3 disabled:opacity-30 hover:text-ink">↑</button>
                    <button type="button" aria-label={`下移 ${m}`} disabled={i === members.length - 1} onClick={() => move(i, 1)} className="rounded px-1.5 text-ink-3 disabled:opacity-30 hover:text-ink">↓</button>
                    <button type="button" aria-label={`移除 ${m}`} onClick={() => remove(i)} className="rounded px-1.5 text-ink-4 hover:text-hot-ink">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="whitespace-nowrap text-[12px] text-ink-4">候选模型（{pickable.length} 个{edit.vision ? "，只看视觉模型" : ""}）</span>
              <Input className="h-7 w-[170px] shrink-0 text-[12px]" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜模型名或供应商" aria-label="搜索候选模型" />
            </div>
            <div className="max-h-[26vh] overflow-y-auto rounded-control border border-line-soft">
              {pickable.filter((c) => !members.includes(c.key)).length === 0 && <div className="px-3 py-3 text-[12.5px] text-ink-4">没有可加的模型。</div>}
              {pickable.filter((c) => !members.includes(c.key)).map((c) => (
                <div key={c.key} className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1 last:border-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={c.key}>{c.key}<span className="text-ink-4"> · {c.service}</span></span>
                  {!c.jsonMode && <Badge tone="warn">无 JSON</Badge>}
                  <button type="button" disabled={members.length >= limit} onClick={() => add(c.key)}
                    className="rounded-control px-2 py-0.5 text-[12px] text-accent disabled:opacity-30">添加</button>
                </div>
              ))}
            </div>
            {members.length >= limit && <p className="mt-1 text-[11.5px] text-ink-4">已到 {limit} 个上限，先移除再加。</p>}
          </div>
        </>
      )}
    </ReasonDialog>
  );
}
