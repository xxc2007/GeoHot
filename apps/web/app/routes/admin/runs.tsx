import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/runs";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { ago, bj, duration, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Dot, Empty, Field, Json, ReasonDialog, Select, Stat, Time } from "../../features/admin/ui";

type Row = Record<string, any>;
interface Runs {
  checkedAt: string;
  processesCheckedAt?: string | null;
  queueSnapshot?: Array<{name:string;queued:number;active:number;at:string}> | null;
  stale?: boolean;
  processes: Array<{ role: string; pid: number; host: string; release: string; startedAt: string; at: string; alive: boolean }>;
  jobs: Row[];
  timeline: Row[];
  queues: Array<{ name: string; state: string; n: number; oldest: string }>;
  failedJobs: Row[];
  lagging: Row[];
  receipts: { counts: Record<string, number>; issues: Row[]; unknownTotal: number };
  errors: Row[];
  retrying: { count: number; next: string | null };
  ingest: Row[];
  leaderboard: { at: string; sources: Array<{ key: string; ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } | null;
}
type RunsLoad = { overview: Runs | null; unavailable: boolean };


/**
 * `job_runs.status` 说的是「这一轮跑完了没有」。一小时里九期日报一期都没排出来，这一轮仍然是
 * `ok`，失败名单只写在返回值的 `failed` 里、只存在 `detail` 那一列——而操作员扫的就是状态这一列。
 * 所以把名单摊在状态旁边（不藏进悬停标题），绿色行才不至于替它说"没事"。
 */
function Result({ row }: { row: Row }) {
  const status = row.status ?? "运行中";
  const badge = <Badge tone={status === "ok" ? "ok" : status === "failed" ? "bad" : "muted"} title={row.error ?? undefined}>{status}</Badge>;
  if (!row.failures) return badge;
  return (
    <div className="whitespace-nowrap">
      {badge}
      <div className="mt-1 max-w-[280px] truncate text-[11.5px] text-hot" title={row.failures}>{row.failures}</div>
    </div>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    // SSR loader 直连 127.0.0.1:3001；服务器 io 压力常态偏高时（PSI full avg10 曾实测 27.78）该聚合
    // 会贴着 10s 超时——放宽到 25s，配合下方 lastGood+20s 轮询兜底，页面不再一进就 unavailable。
    const result = await adminGet<Runs | { unavailable: true }>(request, "/api/admin/runs", 25_000);
    // Keep the flat success fields for tabs opened before this release; their polling code still
    // reads queues/jobs directly. The recovery-aware client uses overview and the unavailable flag.
    return { ...result, overview: "unavailable" in result ? null : result, unavailable: "unavailable" in result } satisfies RunsLoad;
  } catch (error) {
    if (error instanceof Response || request.signal.aborted) throw error;
    return { overview: null, unavailable: true } satisfies RunsLoad;
  }
}

export const meta: Route.MetaFunction = () => [{ title: `运行 · ${SITE.name} 后台` }];

export function ErrorBoundary() {
  const refresh = useRevalidator();
  useEffect(() => {
    const retry = () => { if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate(); };
    const timer = setInterval(retry, 20_000);
    document.addEventListener("visibilitychange", retry);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", retry); };
  }, [refresh.revalidate, refresh.state]);
  return <AdminPage title="运行"><Card><p className="text-[14px] text-ink-2">运行统计暂时读取失败，页面会自动重试，也可立即重新加载。</p><div className="mt-4"><Button disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>重新加载</Button></div></Card></AdminPage>;
}

const STATE_LABEL: Record<string, string> = { created: "排队", retry: "等待重试", active: "执行中" };

export default function RunsAdmin({ loaderData }: Route.ComponentProps) {
  const refresh = useFetcher<typeof loader>();
  const [lastGood, setLastGood] = useState(loaderData.overview);
  const r = refresh.data?.overview ?? lastGood ?? loaderData.overview;
  useEffect(() => {
    const value = refresh.data === undefined ? loaderData.overview : refresh.data.overview;
    if (value) setLastGood(value);
  }, [refresh.data, loaderData.overview]);
  const { run, pending } = useAdminAction();
  const [receipt, setReceipt] = useState<Row | null>(null);
  const [billed, setBilled] = useState("false");
  // Failure group to put back into processing ("" = every failure of the last 30 days).
  const [requeue, setRequeue] = useState<string | null>(null);

  // Live view: refresh every 20 s while visible.
  useEffect(() => {
    const reload = () => { if (document.visibilityState === "visible" && refresh.state === "idle") refresh.load("/admin/runs"); };
    const t = setInterval(reload, 20_000);
    document.addEventListener("visibilitychange", reload);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", reload); };
  }, [refresh.load, refresh.state]);

  if (!r) return <AdminPage title="运行"><Card><p role="status" className="text-[14px] text-ink-2">运行统计正在生成或连接暂时不可用，页面会自动更新；尚未取得数据，不代表队列为空或工作流停止。</p><div className="mt-4"><Button disabled={refresh.state !== "idle"} onClick={() => refresh.load("/admin/runs")}>重新加载</Button></div></Card></AdminPage>;

  const backlog = new Map<string, Record<string, { n: number; oldest: string }>>();
  for (const q of r.queues) backlog.set(q.name, { ...(backlog.get(q.name) ?? {}), [q.state]: { n: q.n, oldest: q.oldest } });
  if (r.queueSnapshot) {
    backlog.clear();
    for (const q of r.queueSnapshot) backlog.set(q.name, {created:{n:q.queued,oldest:""},active:{n:q.active,oldest:""}});
  }
  const queueStates: Array<"created"|"retry"|"active"> = r.queueSnapshot ? ["created","active"] : ["created","retry","active"];
  const queued = r.queueSnapshot ? r.queueSnapshot.reduce((n,q)=>n+q.queued,0) : r.queues.filter((q) => q.state !== "active").reduce((a, q) => a + q.n, 0);
  const queueAt = r.queueSnapshot?.reduce((old,q)=>q.at<old?q.at:old,r.queueSnapshot[0]!.at);
  const worker = r.processes.find((p) => p.role === "worker");
  const failing = r.jobs.filter((j) => j.status === "failed");

  return (
    <AdminPage title="运行" subtitle={<>任务、队列、信源延迟与需要人工核对的回执。每 20 秒自动刷新 · 最近检查 {bj(r.checkedAt)}</>}>
      {(r.stale || refresh.data?.unavailable) && <p role="status" className="mb-5 rounded-panel border border-line bg-surface p-4 text-[13px] text-ink-2">详细统计暂时显示上方“最近检查”时间的快照；心跳与队列使用各自的检测时间。页面会继续尝试刷新。</p>}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="worker"
          value={<span className="inline-flex items-center gap-2 text-[18px]"><Dot tone={worker?.alive ? "ok" : "bad"} />{worker ? (worker.alive ? "运行中" : "心跳中断") : "无心跳"}</span>}
          hint={worker ? `${worker.host} · 心跳 ${ago(worker.at, new Date(r.processesCheckedAt ?? r.checkedAt).getTime())}` : "worker 未上报心跳"}
        />
        <Stat label="队列积压" value={num(queued)} tone={queued > 500 ? "warn" : undefined} hint={queueAt ? `排队与等待重试 · 检测 ${bj(queueAt)}` : "排队与等待重试（详细统计快照）"} />
        <Stat label="失败的定时任务" value={num(failing.length)} tone={failing.length ? "bad" : "ok"} hint="最近一次运行失败" />
        <Stat label="回执结果未知" value={num(r.receipts.unknownTotal)} tone={r.receipts.unknownTotal ? "bad" : "ok"} hint={`7 天 ${num(Object.values(r.receipts.counts).reduce((a, b) => a + b, 0))} 条请求回执`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="队列" pad={false}>
          <DataTable
            dense
            rows={[...backlog.entries()]}
            rowKey={([name]) => name}
            empty="队列是空的"
            columns={[
              { key: "n", label: "队列", render: ([name]) => <span className="font-mono text-[12.5px]">{name}</span> },
              ...queueStates.map((st) => ({
                key: st,
                label: r.queueSnapshot && st === "created" ? "排队及重试" : STATE_LABEL[st],
                align: "right" as const,
                render: ([, v]: [string, Record<string, { n: number; oldest: string }>]) => (v[st] ? <span title={`最早 ${bj(v[st]!.oldest, true)}`}>{num(v[st]!.n)}</span> : <span className="text-ink-4">0</span>),
              })),
              { key: "old", label: "最早排队", render: ([, v]) => <Time at={v.created?.oldest ?? v.retry?.oldest ?? null} /> },
            ]}
          />
        </Card>
        <Card title="定时任务" pad={false}>
          <DataTable
            dense
            rows={r.jobs}
            rowKey={(j) => j.job}
            columns={[
              { key: "j", label: "任务", render: (j) => <span className="font-mono text-[12.5px]">{j.job}</span> },
              { key: "s", label: "上次", render: (j) => <Result row={j} /> },
              { key: "at", label: "时间", render: (j) => <Time at={j.started_at} /> },
              { key: "d", label: "耗时", align: "right", render: (j) => duration(j.started_at, j.finished_at) },
              { key: "f", label: "24h 失败", align: "right", render: (j) => (j.failed_24h ? <span className="text-hot">{j.failed_24h}/{j.runs_24h}</span> : `0/${j.runs_24h}`) },
            ]}
          />
        </Card>
      </div>

      {r.failedJobs.length > 0 && (
        <Card className="mt-5" title="24 小时内失败的队列任务" pad={false}>
          <DataTable
            dense
            rows={r.failedJobs}
            rowKey={(j) => j.name}
            columns={[
              { key: "n", label: "队列", render: (j) => <span className="font-mono text-[12.5px]">{j.name}</span> },
              { key: "c", label: "失败", align: "right", render: (j) => num(j.failed) },
              { key: "l", label: "最近", render: (j) => <Time at={j.last} /> },
              { key: "o", label: "最近错误", render: (j) => <span className="line-clamp-2 font-mono text-[11.5px] text-ink-3">{j.last_output}</span> },
            ]}
          />
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="需要核对的付费回执" right={<span>{Object.entries(r.receipts.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>} pad={false}>
          <DataTable
            dense
            rows={r.receipts.issues}
            rowKey={(x) => x.id}
            empty="没有待处理的回执"
            columns={[
              { key: "id", label: "回执", render: (x) => <span className="num">#{x.id}</span> },
              { key: "s", label: "状态", render: (x) => <Badge tone={x.status === "unknown" ? "bad" : "warn"}>{x.status}</Badge> },
              { key: "w", label: "服务", render: (x) => <span className="whitespace-nowrap">{x.service}{x.model ? ` · ${x.model}` : ""}</span> },
              { key: "p", label: "用途", render: (x) => (x.subject && /^[\w-]{10,}$/.test(x.subject) && x.purpose.includes("analy") ? <Link className="text-accent" to={`/admin/content/${x.subject}`}>{x.purpose}</Link> : x.purpose) },
              { key: "e", label: "错误", render: (x) => <span className="line-clamp-2 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              { key: "a", label: "", render: (x) => (x.status === "unknown" ? <Button size="sm" onClick={() => setReceipt(x)}>核对</Button> : null) },
            ]}
          />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="延迟或失败的信源" right={<Link className="text-accent" to="/admin/sources?health=failing">全部失败信源</Link>} pad={false}>
          <DataTable
            dense
            rows={r.lagging}
            rowKey={(s) => s.id}
            empty="信源都按时采集"
            columns={[
              { key: "n", label: "信源", render: (s) => <Link className="text-ink hover:text-accent" to={`/admin/sources/${encodeURIComponent(s.id)}`}>{s.name}</Link> },
              { key: "h", label: "健康", render: (s) => <Badge tone={s.health === "failing" ? "bad" : s.health === "degraded" ? "warn" : "muted"}>{s.health}</Badge> },
              { key: "ok", label: "上次成功", render: (s) => <Time at={s.last_ok_at} /> },
              { key: "nx", label: "应抓", render: (s) => <Time at={s.next_fetch_at} /> },
              { key: "e", label: "错误", render: (s) => <span className="line-clamp-1 text-[12px] text-ink-3" title={s.last_error ?? ""}>{s.last_error}</span> },
            ]}
          />
        </Card>
        <Card
          title="处理失败（30 天，按错误归类）"
          right={
            <span className="flex items-center gap-3">
              {r.retrying.count > 0 && <span>等待重试 {num(r.retrying.count)} 条 · 下一次 <Time at={r.retrying.next} /></span>}
              {r.errors.length > 0 && <Button size="sm" onClick={() => setRequeue("")}>全部重新处理</Button>}
            </span>
          }
          pad={false}
        >
          <DataTable
            dense
            rows={r.errors}
            rowKey={(e) => e.error}
            empty="没有处理失败"
            columns={[
              { key: "e", label: "错误", render: (e) => <span className="font-mono text-[11.5px] text-ink-2">{e.error}</span> },
              { key: "n", label: "条数", align: "right", render: (e) => num(e.n) },
              { key: "x", label: "示例", render: (e) => <Link className="text-accent" to={`/admin/content/${e.example}`}>查看</Link> },
              { key: "l", label: "最近", render: (e) => <Time at={e.last} /> },
              { key: "a", label: "", align: "right", render: (e) => <Button size="sm" onClick={() => setRequeue(e.error)}>重新处理</Button> },
            ]}
          />
        </Card>
      </div>

      {r.leaderboard && (
        <Card
          className="mt-5"
          title="模型榜评测来源"
          right={<span>最近抓取 {bj(r.leaderboard.at)} · 成功 {r.leaderboard.sources.filter((x) => x.ok).length}/{r.leaderboard.sources.length}</span>}
          pad={false}
        >
          <div className="max-h-[360px] overflow-y-auto">
            <DataTable
              dense
              rows={r.leaderboard.sources}
              rowKey={(x) => x.key}
              columns={[
                { key: "k", label: "来源", render: (x) => <span className="font-mono text-[12.5px]">{x.key}</span> },
                { key: "s", label: "上次抓取", render: (x) => <Badge tone={x.ok ? "ok" : "bad"}>{x.ok ? (x.changed ? "有更新" : "无变化") : "失败"}</Badge> },
                { key: "ok", label: "上次成功", render: (x) => <Time at={x.lastOkAt} /> },
                { key: "n", label: "行数", align: "right", render: (x) => (x.rows == null ? "—" : num(x.rows)) },
                { key: "e", label: "错误", render: (x) => <span className="line-clamp-1 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              ]}
            />
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="任务时间线" pad={false}>
          <div className="max-h-[420px] overflow-y-auto">
            <DataTable
              dense
              rows={r.timeline}
              rowKey={(t) => t.id}
              columns={[
                { key: "at", label: "开始", render: (t) => <span className="num whitespace-nowrap">{bj(t.started_at)}</span> },
                { key: "j", label: "任务", render: (t) => <span className="font-mono text-[12px]">{t.job}</span> },
                { key: "s", label: "结果", render: (t) => <Result row={t} /> },
                { key: "d", label: "耗时", align: "right", render: (t) => duration(t.started_at, t.finished_at) },
              ]}
            />
          </div>
        </Card>
        <Card title="外部上报" pad={false}>
          {r.ingest.length ? (
            <DataTable
              dense
              rows={r.ingest}
              rowKey={(e) => `${e.client}-${e.created_at}`}
              columns={[
                { key: "at", label: "时间", render: (e) => <Time at={e.created_at} /> },
                { key: "c", label: "客户端", render: (e) => e.client },
                { key: "k", label: "类型", render: (e) => e.kind },
                { key: "s", label: "结果", render: (e) => <Badge tone={e.status === "ok" ? "ok" : e.status === "error" ? "bad" : "muted"} title={e.error ?? undefined}>{e.status}</Badge> },
                { key: "x", label: "摘要", render: (e) => <Json value={e.summary} label="摘要" /> },
              ]}
            />
          ) : (
            <Empty>还没有外部上报（公众号截图监控、采集脚本）</Empty>
          )}
        </Card>
      </div>

      {r.processes.length > 0 && (
        <Card className="mt-5" title="进程">
          <ul className="grid gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            {r.processes.map((p) => (
              <li key={p.role} className="flex items-center gap-2">
                <Dot tone={p.alive ? "ok" : "bad"} />
                <span className="font-medium">{p.role}</span>
                <span className="text-ink-3">{p.host} · pid {p.pid} · {p.release} · 启动于 {bj(p.startedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReasonDialog
        open={!!receipt}
        title={`核对回执 #${receipt?.id ?? ""}`}
        description="结果未知的请求不会自动重发。先到供应商控制台确认这次请求有没有计费，再放行：放行后下一次处理会重新发起调用。"
        confirmLabel="记录并放行"
        busy={pending === "release"}
        onClose={() => setReceipt(null)}
        onSubmit={async (note) => (await run("POST", `/api/admin/receipts/${receipt!.id}/release`, { billed: billed === "true", note }, { label: "release", success: "已放行" })) !== null}
      >
        <Field label="供应商是否计费">
          <Select value={billed} onChange={(e) => setBilled(e.target.value)}>
            <option value="false">未计费（请求没有被接受）</option>
            <option value="true">已计费（结果没有取回）</option>
          </Select>
        </Field>
      </ReasonDialog>
      <ReasonDialog
        open={requeue !== null}
        title={requeue ? "重新处理这一类失败" : "重新处理全部失败"}
        description="这些文章会重新进入处理队列（正文、判断、发布）。模型调用会重新计费；供应商拒绝的内容可能再次失败。"
        confirmLabel="重新处理"
        busy={pending === "requeue"}
        onClose={() => setRequeue(null)}
        onSubmit={async (reason) => (await run("POST", "/api/admin/processing/requeue", { group: requeue || null, reason }, { label: "requeue", success: "已重新排队" })) !== null}
      />
    </AdminPage>
  );
}
