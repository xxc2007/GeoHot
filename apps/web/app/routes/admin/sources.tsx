import { SITE } from "@aihot/industry/site";
import { Form, Link, useNavigate, useSearchParams, useActionData } from "react-router";
import type { Route } from "./+types/sources";
import { adminGet, adminPost } from "../../lib/admin.server";
import { num } from "../../features/admin/format";
import { HEALTH_LABEL, KIND_LABEL, MODE_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, ButtonLink, Card, DataTable, Dot, FilterChips, healthTone, Input, Select, Stat, Time } from "../../features/admin/ui";
import { LoadMore, useInfiniteRows } from "../../features/admin/infinite";
import { DiscoveryPanel, type DiscoveryData } from "../../features/admin/panels/discovery";
import { loadDiscovery } from "../../features/admin/panels/discovery.server";

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  enabled: boolean;
  reserve_status?: "ready" | "quarantine" | null;
  health: string;
  fail_count: number;
  interval_minutes: number;
  last_ok_at: string | null;
  last_fetch_at: string | null;
  last_error: string | null;
  first_party: boolean;
  next_fetch_at: string | null;
  items_7d: number;
  selected_30d: number;
}

interface RegistryPolicy {
  target_enabled: number | null;
  enabled_count: number;
  policy_version: number;
  target_total: number;
  total: number;
}

interface SourcesData {
  page: number;
  rows: SourceRow[];
  hasMore: boolean;
  totals: { total: number; enabled: number; failing: number; degraded: number; reserves: number; ready: number; reserve_ineligible?: number; retired?: number };
  policy: RegistryPolicy | null;
}
type ListData = SourcesData & { tab: "list" };

// 2026-11-26：信源发现并入本页（?tab=discover）。发现是往同一个池子里加信源的第一步，
// 两页合一后「批准候选 → 去列表启用」不再需要换页面找入口。
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("tab") === "discover") {
    return { tab: "discover" as const, discovery: await loadDiscovery(request) };
  }
  // policy 与列表并行取：任何一个失败都不该让整页打不开（policy 只影响一个卡片）。
  const [list, policy] = await Promise.all([
    adminGet<Omit<SourcesData, "policy">>(request, `/api/admin/sources${url.search}`),
    adminGet<RegistryPolicy>(request, "/api/admin/sources/policy").catch(() => null),
  ]);
  return { tab: "list" as const, ...list, policy };
}

/** 「正式采集目标」的旋钮：只改 policy，不动任何信源；版本变了就提示重新加载。 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const target = Number(form.get("target"));
  const expectedEnabled = Number(form.get("expectedEnabled"));
  const reason = String(form.get("reason") ?? "").trim();
  if (!Number.isSafeInteger(target) || target < 0) return { error: "目标数要是非负整数" };
  if (!reason) return { error: "改容量得写一句原因，审计里会留档" };
  try {
    await adminPost(request, "/api/admin/sources/policy", { target, expectedEnabled, reason });
  } catch (error) {
    const message = (error as { data?: { message?: string } })?.data?.message;
    return { error: message ?? "写入失败，请稍后重试" };
  }
  return { ok: `正式采集目标已改成 ${target}` };
}

export const meta: Route.MetaFunction = () => [{ title: `信源 · ${SITE.name} 后台` }];

export default function Sources({ loaderData }: Route.ComponentProps) {
  const tab = loaderData.tab;
  const [sp] = useSearchParams();
  const hrefFor = (next: "list" | "discover") => {
    const q = new URLSearchParams(sp);
    q.set("tab", next);
    // 切到发现时丢掉列表的筛选，免得地址栏里留着用不上的参数；切回列表则原样保留。
    if (next === "discover") for (const k of ["q", "kind", "health", "mode", "page"]) q.delete(k);
    return `?${q}`;
  };
  return (
    <AdminPage
      title="信源"
      subtitle={tab === "discover"
        ? "多引擎搜索 → 同站交叉验证 → 现场抓 feed → 人工批准。候选不会直接进正式池。"
        : "正式信源持续采集；备用信源定期复核，持续失败时自动替换。历史来源档案不计入可用池。"}
      actions={tab === "list" ? <ButtonLink to="/admin/sources/new" tone="primary">新建信源</ButtonLink> : undefined}
    >
      <nav aria-label="信源分栏" className="-mt-1 flex flex-wrap gap-1 border-b border-line pb-2">
        {([["list", "信源列表"], ["discover", "发现新信源"]] as const).map(([key, label]) => (
          <Link key={key} to={hrefFor(key)} preventScrollReset aria-current={tab === key ? "page" : undefined}
            className={`rounded-control px-3 py-1.5 text-[13px] transition-colors ${tab === key ? "bg-ink text-bg" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "discover" ? <DiscoveryPanel data={(loaderData as { discovery: DiscoveryData }).discovery} /> : <SourceList data={loaderData as ListData} />}
    </AdminPage>
  );
}

function SourceList({ data }: { data: ListData }) {
  const [sp] = useSearchParams();
  const actionData = useActionData<typeof action>();
  const query = new URLSearchParams(sp);
  query.delete("tab");
  const { rows, totals, hasMore, loading, error, loadMore } = { ...data, ...useInfiniteRows<SourceRow>("/api/admin/sources", data, query.toString()) };
  const navigate = useNavigate();
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="全部（实际）" value={num(totals.total)} />
        <Stat label="正式采集" value={num(totals.enabled)} />
        <Stat label="备用候选" value={num(totals.reserves)} />
        <Stat label="备用可用" value={num(totals.ready)} tone={totals.ready ? "ok" : "warn"} />
        <Stat label="失败" value={num(totals.failing)} tone={totals.failing ? "bad" : "ok"} />
      </div>
      {/* 2026-11-15 站长：2000 条信源、1000 正式、1000 备用，且要能自己调。
          2026-11-20 站长：上面的统计卡已经写清数量，这里不再重复抄一遍并集和上限；
          只留调目标的表单，逐条启停仍在下面每一行做，每次改动都写审计。 */}
      {data.policy ? (
        <Card title="采集目标">
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="expectedEnabled" value={data.policy.enabled_count} />
            <label className="text-[12px] text-ink-4">
              新的正式采集目标
              <Input name="target" type="number" min={0} step={1} defaultValue={data.policy.target_enabled ?? 1000} className="mt-1 w-[120px]" />
            </label>
            <label className="text-[12px] text-ink-4">
              原因（写进审计）
              <Input name="reason" className="mt-1 w-[280px]" placeholder="例如：扩到 1200 条观察一周" />
            </label>
            <Button type="submit">保存</Button>
            {actionData && "error" in actionData && actionData.error ? <span className="text-[12px] text-bad">{actionData.error}</span> : null}
            {actionData && "ok" in actionData && actionData.ok ? <span className="text-[12px] text-ok">{actionData.ok}</span> : null}
          </Form>
          <p className="mt-2 text-[11px] text-ink-4">目标只是上限；实际采集由下面列表的启停决定，单条改动同样写审计。</p>
        </Card>
      ) : null}
      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:items-center lg:justify-between">
          <Form method="get" className="flex w-full max-w-md gap-2" preventScrollReset>
            <input type="hidden" name="tab" value="list" />
            {["kind", "health", "mode"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
            <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="名称、ID 或地址" aria-label="搜索信源" />
          </Form>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="health" options={[{ value: "", label: "全部" }, { value: "failing", label: "失败" }, { value: "degraded", label: "不稳定" }, { value: "reserve", label: "备用" }, { value: "paused", label: "暂停" }]} />
            <Select
              aria-label="类型"
              className="!w-auto"
              value={sp.get("kind") ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(sp);
                if (e.target.value) next.set("kind", e.target.value);
                else next.delete("kind");
                next.delete("page");
                navigate(`?${next}`, { preventScrollReset: true });
              }}
            >
              <option value="">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/sources/${encodeURIComponent(r.id)}`)}
          columns={[
            {
              key: "name",
              label: "信源",
              render: (r) => (
                <div className="min-w-[220px]">
                  <Link to={`/admin/sources/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {r.name}
                  </Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  {r.health === "failing" && r.last_error && <div className="mt-1 line-clamp-1 text-[12px] text-hot-ink">{r.last_error}</div>}
                </div>
              ),
            },
            { key: "kind", label: "类型", render: (r) => <Badge>{KIND_LABEL[r.kind] ?? r.kind}</Badge> },
            {
              key: "mode",
              label: "参与",
              render: (r) => (
                <div className="flex gap-1">
                  <Badge tone={r.participation_mode === "editorial" ? "accent" : "muted"}>{MODE_LABEL[r.participation_mode] ?? r.participation_mode}</Badge>
                  <Badge tone="info">{r.tier.replace("_", ".")}</Badge>
                  {r.first_party && <Badge tone="ok">一手</Badge>}
                </div>
              ),
            },
            {
              key: "health",
              label: "健康",
              render: (r) => (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Dot tone={r.enabled ? healthTone(r.health) : "muted"} />
                  {r.enabled ? HEALTH_LABEL[r.health] ?? r.health : r.reserve_status === "ready" ? "备用可用" : r.reserve_status === "quarantine" ? "隔离待复核" : "已暂停"}
                  {r.fail_count > 0 && <span className="num text-[11.5px] text-ink-4">×{r.fail_count}</span>}
                </span>
              ),
            },
            { key: "ok", label: "上次成功", render: (r) => <Time at={r.last_ok_at} /> },
            { key: "interval", label: "频率", align: "right", render: (r) => `${r.interval_minutes} 分` },
            { key: "items", label: "7 天条目", align: "right", render: (r) => num(r.items_7d) },
            { key: "sel", label: "30 天精选", align: "right", render: (r) => num(r.selected_30d) },
          ]}
        />
      </Card>
      <LoadMore hasMore={hasMore} loading={loading} error={error} onLoad={loadMore} empty="没有更多了" />
    </>
  );
}
