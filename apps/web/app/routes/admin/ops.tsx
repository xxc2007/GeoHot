// 运行看板：一个入口，五个分页签。
// 2026-11-26 站长：把「运行看板 / 用量总览 / 模型 / 审计记录 / magpie」的主体功能合并、去重，
// 页面主体仿 magpie 开源版的观测/用量页（筛选栏 → 指标卡 → 堆叠图 → 速度表 → 优先级）。
// 分页签只由 ?tab= 决定，loader 按 tab 取数：切到「实时看板」不会去等用量的大聚合。
import { SITE } from "@aihot/industry/site";
import { Link, useSearchParams, useRevalidator } from "react-router";
import type { Route } from "./+types/ops";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Button } from "../../features/admin/ui";
import { BoardPanel, type Ops, type Runs } from "../../features/admin/board";
import { UsagePanel } from "../../features/admin/panels/usage";
import { loadUsage, invalidDateUsage } from "../../features/admin/panels/usage.server";
import { ModelsPanel } from "../../features/admin/panels/models";
import { loadModels } from "../../features/admin/panels/models.server";
import { AuditPanel } from "../../features/admin/panels/audit";
import { loadAudit } from "../../features/admin/panels/audit.server";
import { GatewayPanel } from "../../features/admin/panels/gateway";

const TABS = [
  { key: "board", label: "实时看板", hint: "模型与队列的实时状态，可按用途/供应商/模型/状态筛选，可调池内优先级。" },
  { key: "usage", label: "用量", hint: "按天/时段的用量日历、官方定价估算与排行；数据按尝试统计、北京时间。" },
  { key: "models", label: "模型", hint: "每项能力当前用哪个模型、来自哪里、是否在冷却，以及单模型切换记录。" },
  { key: "gateway", label: "模型网关", hint: "服务器上的 magpie：供应商、路由与账号额度。" },
  { key: "audit", label: "审计记录", hint: "所有人工操作：谁、何时、改了什么、为什么。" },
] as const;

type Tab = typeof TABS[number]["key"];
const isTab = (v: string | null): v is Tab => !!v && TABS.some((t) => t.key === v);

// 每个分页签只带自己的参数：从看板跳到审计不该把 window/dimension 也塞进地址栏。
const KEEP: Record<Tab, string[]> = {
  board: ["window", "dimension", "purpose", "service", "model", "status"],
  usage: ["range", "date", "month", "service", "model"],
  models: ["days"],
  gateway: [],
  audit: ["action", "subject"],
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const tab: Tab = isTab(url.searchParams.get("tab")) ? (url.searchParams.get("tab") as Tab) : "board";

  if (tab === "usage") {
    try {
      return { tab, usage: await loadUsage(request) };
    } catch (error) {
      // 非法日期不该让整个看板报错：面板自己会显示错误态和重试入口。
      if (error instanceof Response && error.status === 400) return { tab, usage: invalidDateUsage(url.searchParams.get("range") ?? "all") };
      throw error;
    }
  }
  if (tab === "models") return { tab, models: await loadModels(request) };
  if (tab === "audit") return { tab, audit: await loadAudit(request) };
  if (tab === "gateway") {
    await adminGet(request, "/api/admin/me", 5000);
    return { tab };
  }

  const p = url.searchParams;
  const qs = new URLSearchParams();
  qs.set("window", p.get("window") ?? "today");
  for (const k of ["purpose", "service", "model", "status"]) if (p.get(k)) qs.set(k, p.get(k)!);
  const dimension = p.get("dimension");
  qs.set("dimension", dimension === "service" || dimension === "purpose" ? dimension : "model");
  const [ops, runs] = await Promise.all([
    adminGet<Ops>(request, `/api/admin/model-ops?${qs}`, 20_000),
    adminGet<Runs>(request, "/api/admin/runs", 25_000).catch(() => null),
  ]);
  return { tab, ops, runs };
}

export const meta: Route.MetaFunction = () => [{ title: `运行看板 · ${SITE.name} 后台` }];

export default function OpsHub({ loaderData }: Route.ComponentProps) {
  const [sp] = useSearchParams();
  const refresh = useRevalidator();
  const tab = loaderData.tab;
  const hint = TABS.find((t) => t.key === tab)?.hint ?? "";
  const hrefFor = (next: Tab) => {
    const q = new URLSearchParams();
    for (const k of KEEP[next]) if (sp.get(k)) q.set(k, sp.get(k)!);
    q.set("tab", next);
    return `?${q}`;
  };

  return (
    <AdminPage wide title="运行看板"
      subtitle={hint}
      actions={tab === "board" ? <Button tone="ghost" disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>立即刷新</Button> : undefined}
    >
      <nav aria-label="运行看板分栏" className="-mt-1 flex flex-wrap gap-1 border-b border-line pb-2">
        {TABS.map((t) => (
          <Link key={t.key} to={hrefFor(t.key)} preventScrollReset aria-current={t.key === tab ? "page" : undefined}
            className={`rounded-control px-3 py-1.5 text-[13px] transition-colors ${t.key === tab ? "bg-ink text-bg" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "board" && <BoardPanel ops={loaderData.ops!} runs={loaderData.runs ?? null} />}
      {tab === "usage" && <UsagePanel data={loaderData.usage!} />}
      {tab === "models" && <ModelsPanel data={loaderData.models!} />}
      {tab === "gateway" && <GatewayPanel />}
      {tab === "audit" && <AuditPanel data={loaderData.audit!} />}
    </AdminPage>
  );
}
