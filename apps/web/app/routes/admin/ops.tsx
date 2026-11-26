import { SITE } from "@aihot/industry/site";
import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/ops";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, ReasonDialog } from "../../features/admin/ui";

interface Ops {
  at: string;
  windowMinutes: number;
  models: Array<{ service: string; model: string; calls: number; ok: number; bad: number; avgMs: number; tokens: number; cost: number }>;
  series: Array<{ minute: string; calls: number; bad: number }>;
  queue: Array<{ state: string; n: number }>;
  active: Array<{ name: string; n: number }>;
  heartbeats: Array<{ key: string; role: string; at: string | null; load: number | null }>;
  capabilities: Array<{ key: string; label: string; source: "admin" | "env" | "default"; members: string[] }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const window = new URL(request.url).searchParams.get("window") ?? "60";
  return adminGet<Ops>(request, `/api/admin/model-ops?window=${encodeURIComponent(window)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型运行看板 · ${SITE.name} 后台` }];

const STATE_LABEL: Record<string, string> = { created: "排队", active: "执行中", retry: "重试", completed: "完成", failed: "失败", cancelled: "取消" };
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s} 秒前`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  return `${(s / 3600).toFixed(1)} 小时前`;
};
const pct = (ok: number, all: number) => (all ? `${Math.round((ok / all) * 100)}%` : "—");
const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

/** Sparkline of call volume with failures marked; plain SVG so it needs no chart dependency. */
function Spark({ series }: { series: Ops["series"] }) {
  const { path, fails, max } = useMemo(() => {
    const n = Math.max(1, series.length - 1);
    const max = Math.max(1, ...series.map((p) => p.calls));
    const pt = (i: number, v: number) => `${(i / n) * 100},${28 - (v / max) * 26}`;
    return {
      max,
      path: series.map((p, i) => `${i ? "L" : "M"}${pt(i, p.calls)}`).join(" "),
      fails: series.filter((p) => p.bad > 0).map((p, i) => ({ i, bad: p.bad })),
    };
  }, [series]);
  if (!series.length) return <div className="h-16 text-[12px] text-ink-4">窗口内没有调用</div>;
  return (
    <div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="每分钟模型调用量">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" className="text-terra" />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11.5px] text-ink-4">
        <span>{series[0]?.minute}</span>
        <span>峰值 {max} 次/分 · 失败 {fails.reduce((s, f) => s + f.bad, 0)}</span>
        <span>{series[series.length - 1]?.minute}</span>
      </div>
    </div>
  );
}

export default function OpsBoard({ loaderData: o }: Route.ComponentProps) {
  const refresh = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh.state, refresh.revalidate]);

  const { run, pending } = useAdminAction();
  const [edit, setEdit] = useState<{ key: string; label: string; members: string[] } | null>(null);

  const worker = o.heartbeats.find((h) => h.key === "heartbeat.worker");
  const queueCreated = o.queue.find((q) => q.state === "created")?.n ?? 0;
  const queueActive = o.queue.find((q) => q.state === "active")?.n ?? 0;
  const calls = o.models.reduce((s, m) => s + m.calls, 0);
  const bad = o.models.reduce((s, m) => s + m.bad, 0);
  const tokens = o.models.reduce((s, m) => s + m.tokens, 0);

  return (
    <AdminPage
      title="模型运行看板"
      subtitle={`近 ${o.windowMinutes} 分钟 · 每 5 秒自动刷新 · 最近更新 ${bj(o.at)}`}
      wide
      actions={<Button tone="ghost" onClick={() => refresh.revalidate()}>立即刷新</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <div className="text-[12px] text-ink-3">worker 心跳</div>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={worker && ago(worker.at) !== "—" && Date.now() - new Date(worker.at!).getTime() < 180_000 ? "ok" : "warn"}>
              {worker ? ago(worker.at) : "无心跳"}
            </Badge>
          </div>
        </Card>
        <Card><div className="text-[12px] text-ink-3">排队 / 执行中</div><div className="num mt-1 text-[20px] font-semibold">{num(queueCreated)} <span className="text-[13px] text-ink-3">/ {num(queueActive)}</span></div></Card>
        <Card><div className="text-[12px] text-ink-3">窗口内调用</div><div className="num mt-1 text-[20px] font-semibold">{num(calls)}</div></Card>
        <Card><div className="text-[12px] text-ink-3">失败 / 成功率</div><div className="num mt-1 text-[20px] font-semibold">{num(bad)} <span className="text-[13px] text-ink-3">{pct(calls - bad, calls)}</span></div></Card>
        <Card><div className="text-[12px] text-ink-3">Token 合计</div><div className="num mt-1 text-[20px] font-semibold">{num(tokens)}</div></Card>
      </div>

      <Card title="调用节奏（每分钟）">
        <Spark series={o.series} />
      </Card>

      <Card title="各模型实时表现">
        {o.models.length === 0 ? (
          <Empty>窗口内没有模型调用。换一个时间窗口，或确认执行器正在领取任务。</Empty>
        ) : (
          <DataTable
            dense
            rows={o.models}
            rowKey={(m) => `${m.service}|${m.model}`}
            columns={[
              { key: "m", label: "模型", render: (m) => <span className="whitespace-nowrap font-mono text-[12px]">{m.model}<span className="text-ink-4"> · {m.service}</span></span> },
              { key: "calls", label: "调用", align: "right", render: (m) => num(m.calls) },
              { key: "ok", label: "成功率", align: "right", render: (m) => <Badge tone={m.bad === 0 ? "ok" : m.bad / m.calls > 0.2 ? "bad" : "warn"}>{pct(m.ok, m.calls)}</Badge> },
              { key: "bad", label: "失败", align: "right", render: (m) => num(m.bad) },
              { key: "avg", label: "平均耗时", align: "right", render: (m) => secs(m.avgMs) },
              { key: "tok", label: "Token", align: "right", render: (m) => num(m.tokens) },
              { key: "cost", label: "费用", align: "right", render: (m) => (m.cost ? m.cost.toFixed(3) : "—") },
            ]}
          />
        )}
      </Card>

      <Card title="各步骤的模型池（顺序即优先级，第一名为首选）">
        <div className="space-y-2">
          {o.capabilities.map((c) => (
            <div key={c.key} className="flex flex-wrap items-center gap-2 border-b border-line/60 pb-2 last:border-0">
              <div className="min-w-[220px] flex-1">
                <div className="text-[13px] font-medium text-ink">{c.label}</div>
                <div className="text-[11.5px] text-ink-4">{c.key} · 来源 {c.source === "admin" ? "后台设置" : c.source === "env" ? "环境变量" : "代码默认"}</div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {c.members.length === 0 ? <span className="text-[12px] text-ink-4">（继承全局 MODEL_POOL）</span> : c.members.map((m, i) => (
                  <Badge key={`${c.key}-${m}-${i}`} tone={i === 0 ? "ok" : "muted"}>{i + 1}. {m}</Badge>
                ))}
              </div>
              <Button size="sm" tone="ghost" onClick={() => setEdit({ key: c.key, label: c.label, members: [...c.members] })}>调整顺序</Button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="队列与执行中作业">
        <div className="flex flex-wrap gap-2">
          {o.queue.map((q) => <Badge key={q.state} tone={q.state === "failed" ? "bad" : q.state === "active" ? "ok" : "muted"}>{STATE_LABEL[q.state] ?? q.state} {num(q.n)}</Badge>)}
        </div>
        {o.active.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-ink-3">
            {o.active.map((a) => <span key={a.name} className="font-mono">{a.name} ×{a.n}</span>)}
          </div>
        )}
      </Card>

      <ReasonDialog
        open={!!edit}
        title={`调整模型池顺序：${edit?.label ?? ""}`}
        description="第一位是首选；后面的按顺序兜底。只影响之后的新任务。用 ↑ / ↓ 调整后保存。"
        confirmLabel="保存顺序"
        busy={pending === "pool"}
        onClose={() => setEdit(null)}
        onSubmit={async (reason) =>
          (await run("POST", "/api/admin/model-ops/pool", { capability: edit!.key, members: edit!.members, reason }, { label: "pool", success: "顺序已保存，下一次调用生效" })) !== null
        }
      >
        <div className="space-y-1.5">
          {edit?.members.map((m, i) => (
            <div key={`${m}-${i}`} className="flex items-center gap-2">
              <span className="num w-5 text-[12px] text-ink-4">{i + 1}</span>
              <span className="flex-1 font-mono text-[12px]">{m}</span>
              <Button size="sm" tone="ghost" disabled={i === 0} onClick={() => setEdit((e) => e && { ...e, members: e.members.map((x, j) => (j === i - 1 ? e.members[i]! : j === i ? e.members[i - 1]! : x)) })}>↑</Button>
              <Button size="sm" tone="ghost" disabled={!edit || i === edit.members.length - 1} onClick={() => setEdit((e) => e && { ...e, members: e.members.map((x, j) => (j === i + 1 ? e.members[i]! : j === i ? e.members[i + 1]! : x)) })}>↓</Button>
            </div>
          ))}
        </div>
      </ReasonDialog>
    </AdminPage>
  );
}
