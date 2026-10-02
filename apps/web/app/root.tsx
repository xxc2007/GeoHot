import { titled } from "./lib/seo";
import { SITE } from "@aihot/industry/site";
import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { Sidebar } from "./components/shell/Sidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { THEME_BOOT_SCRIPT } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { appPath, basePath, publicPath } from "./lib/public-path";

/**
 * React Router resolves a root target under a basename to the *bare* base — `to="/"` or `/?category=x`
 * becomes `/geohot` — and its own matcher then fails on that exact string, so the reader lands on the
 * 404 route. That one behaviour produced three separate bugs on this site (the home tab, the report
 * tabs, the home filter chips), each fixed at its call site.
 *
 * This is the general guard: normalise the bare base in the history API itself, so any link, loader
 * redirect or programmatic navigation that hands over `/geohot` is stored as `/geohot/`. Only an exact
 * match is rewritten — a deeper path like `/geohot/all` is left alone — and it only runs in the
 * browser, so the server keeps rendering whatever path it was asked for.
 */
if (typeof window !== "undefined" && basePath) {
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
      if (url != null) {
        const next = new URL(String(url), window.location.origin);
        if (next.pathname === basePath) {
          next.pathname = `${basePath}/`;
          url = `${next.pathname}${next.search}${next.hash}`;
        }
      }
      return original(data, unused, url as string | URL | null);
    }) as History[typeof method];
  }
}
import { useHydratedFlag } from "./lib/hydration";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: publicPath("/favicon.ico"), sizes: "any" },
  { rel: "icon", type: "image/png", href: publicPath("/icon.png") },
  { rel: "apple-touch-icon", href: publicPath("/apple-icon.png") },
  { rel: "manifest", href: publicPath("/manifest.webmanifest") },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: publicPath("/feed.xml") },
];

interface SiteMeta {
  changelogVersion: string | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    return await apiGet<SiteMeta>("/api/site/meta", { signal: request.signal });
  } catch {
    return { changelogVersion: null } satisfies SiteMeta;
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

/** Whether a location belongs to the admin, with or without the deployment's path prefix. */
function isAdminPath(pathname: string): boolean {
  const path = appPath(pathname);
  return path === "/admin" || path.startsWith("/admin/");
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#13191c" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, children }: { changelogVersion: string | null; children: ReactNode }) {
  const navigation = useNavigation();
  const { pathname } = useLocation();
  // A client-side navigation removes the link the reader just activated, so focus falls back to
  // <body>: the next Tab restarts at the skip link and walks the whole sidebar again, on every page
  // change. Moving focus to the main region is also what makes "跳到正文" actually land somewhere —
  // a bare fragment target only moves the sequential-focus starting point. The first render is
  // skipped: on a cold load the reader belongs at the top of the document, not inside main.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        跳到正文
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* The one thing said out loud when scripts are off. Expansions ("另有 N 家信源报道", "展开 N 条
          进展"), the filter controls and the canvas charts fetch or draw on the client, so their buttons
          are inert without JavaScript — the lists they open are never in the served HTML, so no CSS
          could reveal them either. Everything a reader came for is still here: every card is a real
          anchor, the daily issue, a story and its sources read top to bottom, and /all answers by form.
          Saying which half is missing is cheaper than letting someone hunt for a broken button. */}
      <noscript>
        <p className="mx-4 mt-3 rounded-control border border-line bg-raised p-3 text-[12.5px] leading-relaxed text-ink-2">
          当前浏览器未启用 JavaScript：正文、日报、事件页与全部链接照常可读，但卡片上的「另有 N 家信源报道」「展开 N 条进展」这类按需加载的列表、筛选控件与走势图无法使用。
        </p>
      </noscript>
      {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] outline-none lg:px-7 lg:pb-[72px] lg:pt-6">
        <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">{children}</div>
      </main>
      <MobileTabBar changelogVersion={changelogVersion} />
      <BackToTop />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  // A prefixed deployment: the location can carry the prefix, the admin paths never do.
  const admin = isAdminPath(useLocation().pathname);
  // The admin has its own chrome.
  if (admin) return <Outlet />;
  return (
    <SiteShell changelogVersion={meta.changelogVersion}>
      <Outlet />
    </SiteShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const { pathname } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? "这里没有内容" : "暂时无法加载"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? "你访问的页面不存在，或内容已不再公开。" : "服务暂时繁忙，请稍后再试。已经加载过的内容不受影响。"}
        </p>
        <div className="mt-6 flex justify-center gap-2.5">
          <Link to="/" reloadDocument className={buttonClass("primary")}>
            回到精选
          </Link>
          <Link to="/all" className={buttonClass("secondary")}>
            浏览全部动态
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (isAdminPath(pathname)) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null}>{body}</SiteShell>;
}
