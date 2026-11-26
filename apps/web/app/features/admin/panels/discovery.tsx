// 信源发现面板（原 /admin/discovery 页的主体）：多引擎搜索 → 同站交叉验证 → 现场抓 feed → 人工批准。
// 2026-11-26 并入信源页的「发现」分页签：发现是往同一个池子里加信源的第一步，不该是另一个页面。
import { useEffect, useMemo, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../action";
import { Badge, Button, Card, DataTable, Input, Select, Stat } from "../ui";
import { bj, num } from "../format";

interface Run {
  id: string;
  query: string;
  category: string | null;
  engines: string[];
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  stats: { hits?: number; hosts?: number; probed?: number; staged?: number; skipped?: number; blocked?: number; failures?: Array<{ engine: string; error: string }> };
  error: string | null;
}
interface Engine {
  id: string;
  label: string;
  configured: boolean;
  keyless: boolean;
  note?: string;
}
interface Candidate {
  id: number;
  address: string;
  feed_url: string | null;
  host: string;
  name: string | null;
  title: string | null;
  engines: Array<{ engine: string; rank: number; url: string; title: string }>;
  corroboration: number;
  quality: number;
  verdict: { latest?: string | null; itemCount?: number; hostKind?: string };
  review_note: string | null;
  query: string;
  category: string | null;
  created_at: string;
}
export interface DiscoveryData {
  runs: Run[];
  candidates: Candidate[];
  counts: { pending: number; approved: number; rejected: number };
  engines: Engine[];
  unsupported: Array<{ id: string; label: string; why: string }>;
}

// 取数在 discovery.server.ts（组件文件不能直接 import `.server`）。

const CATEGORIES = [
  ["", "不指定分类"],
  ["physical", "自然地理"],
  ["human", "人文地理"],
  ["regional", "区域地理"],
  ["geopolitics", "政治地理"],
  ["histgeo", "历史地理"],
  ["frontier", "前沿地理"],
  ["geotech", "地理信息系统"],
] as const;

export function DiscoveryPanel({ data }: { data: DiscoveryData }) {
  const { run, pending } = useAdminAction();
  const refresh = useRevalidator();
  const configured = useMemo(() => data.engines.filter((engine) => engine.configured), [data.engines]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [engines, setEngines] = useState<string[]>(() => configured.slice(0, 4).map((engine) => engine.id));
  const running = data.runs.find((row) => row.status === "running");
  const latest = data.runs[0];

  useEffect(() => {
    if (!running || refresh.state !== "idle") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh.revalidate(); }, 4_000);
    return () => clearInterval(timer);
  }, [running, refresh.state, refresh.revalidate]);

  const toggle = (id: string) => setEngines((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  const start = async () => {
    const ok = await run<{ runId: string }>("POST", "/api/admin/discovery/run", { query, category: category || null, engines }, { success: "发现任务已开始，页面会自动刷新", label: "discovery-run" });
    if (ok) refresh.revalidate();
  };
  const approve = (candidate: Candidate) => run("POST", `/api/admin/discovery/candidates/${candidate.id}/approve`, undefined, { success: `已加入信源池：${candidate.name ?? candidate.host}（默认暂停，去「信源列表」启用）` });
  const reject = (candidate: Candidate) => {
    const note = window.prompt(`拒绝 ${candidate.host} 的原因（会留在审核记录里）`);
    if (note?.trim()) void run("POST", `/api/admin/discovery/candidates/${candidate.id}/reject`, { note }, { success: "已拒绝" });
  };

  return <>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="待审核候选" value={num(data.counts.pending)} tone={data.counts.pending ? "warn" : undefined} />
      <Stat label="已批准" value={num(data.counts.approved)} hint={<Link className="text-accent" to="?tab=list">去信源列表</Link>} />
      <Stat label="已拒绝" value={num(data.counts.rejected)} />
      <Stat label="可用引擎" value={`${configured.length} / ${data.engines.length}`} hint="未配 Key 或仅 HTML 的引擎不参与" />
    </div>

    <Card title="运行一次发现">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_auto] lg:items-end">
        <label className="text-[12px] text-ink-4">查询词
          <Input className="mt-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：earthquake monitoring RSS / 城市人口普查 发布" maxLength={120} />
        </label>
        <label className="text-[12px] text-ink-4">分类
          <Select className="mt-1" value={category} onChange={(event) => setCategory(event.target.value)}>
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        <Button type="button" tone="primary" disabled={!!running || pending !== null || query.trim().length < 2 || engines.length === 0} onClick={() => void start()}>{running ? "正在运行…" : "开始发现"}</Button>
      </div>
      <div className="mt-4">
        <div className="mb-2 text-[12px] text-ink-4">搜索引擎（最多 8 个；每次运行会消耗所选引擎的额度）</div>
        <div className="flex flex-wrap gap-2">
          {data.engines.map((engine) => <button key={engine.id} type="button" aria-pressed={engines.includes(engine.id)} disabled={!engine.configured}
            onClick={() => toggle(engine.id)}
            className={`rounded-full border px-3 py-1 text-[12.5px] ${!engine.configured ? "cursor-not-allowed border-line-soft text-ink-4 line-through" : engines.includes(engine.id) ? "border-accent bg-accent/10 text-accent" : "border-line-soft text-ink-3"}`}>
            {engine.label}{engine.keyless ? " · 免Key" : ""}
          </button>)}
        </div>
      </div>
      {latest && <p className="mt-4 text-[12px] text-ink-4">
        最近一次：{latest.query} · {latest.status === "running" ? "运行中" : latest.status === "failed" ? "失败" : "完成"} · {bj(latest.started_at)}
        {latest.stats?.hits !== undefined ? ` · 命中 ${latest.stats.hits} 条 / 站点 ${latest.stats.hosts ?? 0} / 入候选 ${latest.stats.staged ?? 0}` : ""}
        {latest.error ? ` · ${latest.error}` : ""}
      </p>}
    </Card>

    <Card title="待审核候选" pad={false} right={<span>{data.candidates.length} 条</span>}>
      <DataTable
        rows={data.candidates}
        rowKey={(candidate) => candidate.id}
        empty="还没有候选。先在上面运行一次发现。"
        columns={[
          {
            key: "host", label: "站点 / feed",
            render: (candidate) => <div className="min-w-[240px]">
              <div className="font-medium text-ink">{candidate.name ?? candidate.host}</div>
              <div className="text-[11.5px] text-ink-4">{candidate.host}</div>
              {candidate.feed_url && <a className="mt-1 block break-all text-[11.5px] text-accent" href={candidate.feed_url} target="_blank" rel="noreferrer">{candidate.feed_url}</a>}
              {candidate.review_note && <div className="mt-1 text-[11.5px] text-ink-3">{candidate.review_note}</div>}
            </div>,
          },
          {
            key: "quality", label: "质量", align: "right",
            render: (candidate) => <div className="text-right"><span className="num text-[16px] font-semibold text-ink">{candidate.quality}</span><span className="text-[11px] text-ink-4"> / 10</span>
              <div className="text-[11px] text-ink-4">{candidate.verdict?.hostKind ?? ""} · {candidate.corroboration} 引擎</div></div>,
          },
          {
            key: "engines", label: "命中引擎",
            render: (candidate) => <div className="flex max-w-[220px] flex-wrap gap-1">{candidate.engines.map((hit) => <Badge key={hit.engine}>{hit.engine} #{hit.rank}</Badge>)}</div>,
          },
          {
            key: "title", label: "搜索结果",
            render: (candidate) => <span className="line-clamp-2 max-w-[300px] text-[12px] text-ink-3">{candidate.title ?? candidate.address}</span>,
          },
          {
            key: "actions", label: "",
            render: (candidate) => <div className="flex gap-2 whitespace-nowrap">
              <Button size="sm" tone="primary" disabled={pending !== null} onClick={() => void approve(candidate)}>批准</Button>
              <Button size="sm" disabled={pending !== null} onClick={() => reject(candidate)}>拒绝</Button>
            </div>,
          },
        ]}
      />
    </Card>

    <details className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <summary className="cursor-pointer text-[13.5px] font-medium text-ink">引擎清单与未接入说明（{data.engines.length} 个官方 API，{data.unsupported.length} 个未接入）</summary>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {data.engines.map((engine) => <div key={engine.id} className="flex items-start justify-between gap-3 rounded-control border border-line-soft px-3 py-2 text-[12.5px]">
          <span><span className="font-medium text-ink">{engine.label}</span><span className="ml-2 font-mono text-[11px] text-ink-4">{engine.id}</span>{engine.note && <span className="mt-0.5 block text-[11px] text-ink-4">{engine.note}</span>}</span>
          <Badge tone={engine.configured ? "ok" : "muted"}>{engine.configured ? "已配置" : "缺 Key"}</Badge>
        </div>)}
      </div>
      <div className="mt-4 grid gap-1.5">
        {data.unsupported.map((engine) => <div key={engine.id} className="text-[12px] text-ink-4"><span className="text-ink-3">{engine.label}</span> · {engine.why}</div>)}
      </div>
    </details>
  </>;
}
