import { SITE } from "@aihot/industry/site";
import { motion } from "motion/react";
import { NavLink, Outlet, useLocation, useNavigation, useRevalidator, type ShouldRevalidateFunction } from "react-router";
import { useEffect, type ReactNode } from "react";
import type { Route } from "./+types/layout";
import { RingMark } from "../../components/Logo";
import { NavigationProgress } from "../../components/shell/Chrome";
import type { AdminMe } from "../../features/admin/action";
import { Toaster } from "../../features/admin/toast";
import { adminGet } from "../../lib/admin.server";
import { publicPath } from "../../lib/public-path";

type Counts = Partial<Record<"feedback" | "sources" | "runs" | "monitor", number>>;

export async function loader({ request }: Route.LoaderArgs) {
  const [me, counts] = await Promise.all([adminGet<AdminMe>(request, "/api/admin/me"), adminGet<Counts>(request, "/api/admin/nav-counts", 1500).catch(() => ({}) as Counts)]);
  return { me, counts };
}

// Each API call still authenticates. Avoid re-reading the shell identity on ordinary page changes;
// actions and an explicit same-page retry must still revalidate it.
export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }) =>
  formMethod && formMethod !== "GET" ? defaultShouldRevalidate
    : currentUrl.pathname !== nextUrl.pathname || currentUrl.search !== nextUrl.search ? false : defaultShouldRevalidate;

export const meta: Route.MetaFunction = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

const NAV: Array<{ group: string; items: Array<{ to: string; label: string; count?: keyof Counts; tone?: "bad" | "accent" }> }> = [
  {
    group: "内容",
    items: [
      { to: "/admin/content", label: "内容诊断" },
      { to: "/admin/sources", label: "信源", count: "sources", tone: "bad" },
      { to: "/admin/feedback", label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "系统",
    items: [
      { to: "/admin/server", label: "服务器" },
      { to: "/admin/runs", label: "运行", count: "runs", tone: "bad" },
      { to: "/admin/magpie", label: "magpie" },
      { to: "/admin/usage", label: "用量总览" },
      { to: "/admin/models", label: "模型" },
      { to: "/admin/audit", label: "审计记录" },
      { to: "/admin/settings", label: "设置" },
    ],
  },
];

function NavItem({ to, label, count, tone }: { to: string; label: string; count?: number; tone?: "bad" | "accent" }) {
  return (
    <NavLink to={to} className="group relative block">
      {({ isActive }) => (
        <span className={`relative flex items-center justify-between rounded-control px-3 py-[7px] text-[13.5px] transition-colors ${isActive ? "font-medium text-ink" : "text-ink-3 hover:text-ink"}`}>
          {isActive && <motion.span layoutId="admin-nav" className="absolute inset-0 rounded-control bg-surface shadow-sm ring-1 ring-line" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
          <span className="relative">{label}</span>
          {!!count && (
            <span className={`num relative min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${tone === "bad" ? "bg-hot text-white" : "bg-accent-soft text-accent"}`}>{count}</span>
          )}
        </span>
      )}
    </NavLink>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return <AdminFrame me={loaderData.me} counts={loaderData.counts}><Outlet /></AdminFrame>;
}

export function ErrorBoundary() {
  const refresh = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate(); }, 15_000);
    return () => clearInterval(id);
  }, [refresh.state, refresh.revalidate]);
  // This shell never supplies an authenticated identity or protected child content on failure.
  return <AdminFrame counts={{}}><section className="mx-auto max-w-3xl p-6 lg:p-10">
    <h1 className="text-xl font-semibold text-ink">后台连接暂时不可用</h1>
    <p role="status" className="mt-3 text-ink-3">尚未完成身份核验或页面读取。正在自动重试，其他后台入口仍可访问。</p>
    <button className="mt-5 rounded-control bg-ink px-4 py-2 text-bg disabled:opacity-50" disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>重新连接</button>
  </section></AdminFrame>;
}

function AdminFrame({ me, counts, children }: { me?: AdminMe; counts: Counts; children: ReactNode }) {
  const navigation = useNavigation();
  const location = useLocation();
  const flat = NAV.flatMap((g) => g.items);
  return (
    <div translate="no" className="notranslate flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-bg-sunk/50 px-3 py-4 lg:flex">
        <a href={publicPath("/")} className="mb-5 flex items-center gap-2 px-2">
          <RingMark className="size-6 text-accent" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">{SITE.name} 后台</span>
        </a>
        <nav className="flex-1 space-y-4 overflow-y-auto">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map((i) => (
                  <NavItem key={i.to} to={i.to} label={i.label} count={i.count ? counts[i.count] : undefined} tone={i.tone} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px] text-ink-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{me?.name ?? "等待身份核验"}</span>
            {me?.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <form method="post" action={publicPath("/api/auth/logout")} className="mt-1.5">
            <button type="submit" className="text-ink-4 hover:text-ink-2">退出登录</button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 px-4 pt-3">
            <RingMark className="size-5 text-accent" />
            <span className="text-[14px] font-semibold text-ink">{SITE.name} 后台</span>
            {me?.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
            {flat.map((i) => {
              const active = location.pathname === i.to || location.pathname.startsWith(`${i.to}/`);
              const n = i.count ? counts[i.count] : 0;
              return (
                <NavLink key={i.to} to={i.to} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[13px] ${active ? "bg-ink text-bg" : "text-ink-3"}`}>
                  {i.label}
                  {!!n && <span className="num ml-1 text-[11px] opacity-70">{n}</span>}
                </NavLink>
              );
            })}
          </nav>
        </div>
        <main className="min-w-0 flex-1">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
