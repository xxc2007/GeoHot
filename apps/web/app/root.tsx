import { serverSiteUrl, titled } from "./lib/seo";
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
import { BackToTop, NavigationProgress, PageBoundary } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { THEME_BOOT_SCRIPT } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { appPath, basePath, publicPath } from "./lib/public-path";
import { localeAppPath, localeFromPath, useLocale } from "./lib/i18n";
import { copy as shellCopy } from "./lib/i18n/shell";
import { useHydratedFlag } from "./lib/hydration";
import { isNetworkRouteError } from "./lib/route-error";

/**
 * The page background of each theme, for the two `<meta name="theme-color">` tags a browser paints into
 * its own chrome before any CSS is loaded. `app.css` is the truth for the page: light `--bg` (its line 93)
 * and dark `--bg` (line 153). SSR cannot read a custom property, so these are the one copy outside that
 * file, and the web manifest (`apps/api/src/routes/static.ts`) names the light value as its `theme_color`.
 */
const THEME_COLORS = { light: "#faf9f6", dark: "#13191c" } as const;

/**
 * The `<noscript>` notice as raw markup. The sentence itself follows the page language
 * (`shell.noscriptNotice` in lib/i18n/shell.ts); only the styled wrapper lives here.
 *
 * React treats `<noscript>` as a text host (`shouldSetTextContent`,
 * react-dom-client.development.js:23891 — which is also why `dangerouslySetInnerHTML` is safe there), and
 * the HTML parser reads its content as rawtext, so JSX *children* never survive intact: the server writes
 * a real `<p>`, the browser keeps one text node holding that markup as text, and the client abandons the
 * child while hydrating and mounts a second paragraph on the first re-render of this shell — which is
 * every pathname change. With `dangerouslySetInnerHTML` the fiber has no children in either path, the
 * served string and the parsed text node are the same bytes, and there is nothing left to reconcile. The
 * cost is that this one paragraph is a string rather than JSX.
 */
const noscriptNoticeHtml = (text: string) =>
  `<p class="mt-3 rounded-control border border-line bg-raised p-3 text-[12.5px] leading-relaxed text-ink-2">${text}</p>`;

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
 *
 * It used to sit between two imports, which bought nothing: every module imported by this file is
 * evaluated before its first statement runs, so the guard can only patch calls the router makes later
 * either way. The remaining step is to move it into `lib/public-path.ts` and delete the four call sites
 * that hand-write the trailing slash (`shell/Sidebar`, `shell/MobileTabBar`, `ui/Tabs` via its `hard`
 * option, `features/feed/Filters`) behind one exported `homeHref()`; that file has another owner this
 * round, so `shell/nav.ts:homeHref` is the interim home for the call sites in the shell.
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


export const links: Route.LinksFunction = () => [
  { rel: "icon", href: publicPath("/favicon.ico"), sizes: "any" },
  { rel: "icon", type: "image/png", href: publicPath("/icon.png") },
  { rel: "apple-touch-icon", href: publicPath("/apple-icon.png") },
  { rel: "manifest", href: publicPath("/manifest.webmanifest") },
  // RSS alternate 不在这里：links() 是模块级的，拿不到页面语言，title 只能硬编码中文。它挪到
  // Layout 的 <head> 里按 locale 渲染（shell.rssAlternateTitle），/en 的 <head> 不再有中文。
];

interface SiteMeta {
  changelogVersion: string | null;
}

/** The api's shell metadata plus the address this document was served from (see `lib/seo.ts` `siteUrl`). */
interface RootData extends SiteMeta {
  siteUrl: string;
  /** `ENGLISH_TEXT` 的当前档位：客户端 meta() 读不到 process.env，靠 <html data-english-text> 传下去。 */
  englishText: "strict" | "fallback";
}

export async function loader({ request }: Route.LoaderArgs): Promise<RootData> {
  const siteUrl = serverSiteUrl();
  const englishText = process.env.ENGLISH_TEXT === "fallback" ? "fallback" : "strict";
  try {
    return { ...(await apiGet<SiteMeta>("/api/site/meta", { signal: request.signal })), siteUrl, englishText };
  } catch {
    return { changelogVersion: null, siteUrl, englishText };
  }
}

/**
 * The shell's loader is deliberately read once per document.
 *
 * Cost, stated so nobody rediscovers it: `changelogVersion` freezes for the session, so the "更新日志"
 * red dot can only appear on a full load, and a meta fetch that failed at SSR leaves it off until the
 * reader reloads. The alternative is worse than the bug. React Router has no per-route revalidation
 * surface — `useRevalidator().revalidate()` re-runs the loaders of *every* matched route, so a
 * focus-triggered refresh of one string would refetch the page's list, its charts and the api behind
 * them each time the reader alt-tabs. Making it cheap means a separate client-side poll of
 * `/api/site/meta`, i.e. a second data path for the chrome and a new store to keep in step with the
 * server value; `local-state.ts` already owns the reader-side half (`changelogSeen`).
 * The dot marks "since you last looked", and a reader who cares opens /changelog. Decided: keep.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

/** Whether a location belongs to the admin, with or without the deployment's path prefix. */
function isAdminPath(pathname: string): boolean {
  const path = appPath(pathname);
  return path === "/admin" || path.startsWith("/admin/");
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Handed to `lib/seo.ts` `siteUrl()` on the browser side: the address is decided once, by the server.
  const root = useRouteLoaderData<typeof loader>("root");
  // `<html lang>` follows the page language: the `/en` chrome reads as `en`, everything else (the
  // Chinese pages and the admin) keeps `SITE.locale`. Both sides derive it from the router's location,
  // so the server and the hydration pass answer identically.
  const locale = localeFromPath(useLocation().pathname);
  const lang = locale === "en" ? "en" : SITE.locale;
  return (
    <html lang={lang} data-site-url={root?.siteUrl} data-english-text={root?.englishText ?? "fallback"} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={THEME_COLORS.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLORS.dark} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
        {/* RSS alternate 的标题随页面语言（shell.rssAlternateTitle）：feed 是同一份中文源，/en 页
            的 head 里不能留着「精选」两个字。放这里而不是模块级 links()，是因为 links() 读不到 location。 */}
        <link rel="alternate" type="application/rss+xml" title={shellCopy[locale].rssAlternateTitle} href={publicPath("/feed.xml")} />
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
export function meta({ error, location }: Route.MetaArgs) {
  if (!error) return [];
  const e = shellCopy[localeFromPath(location.pathname)].error;
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? e.metaNotFound : e.metaUnavailable) }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, children }: { changelogVersion: string | null; children: ReactNode }) {
  const navigation = useNavigation();
  const { pathname } = useLocation();
  const shell = shellCopy[useLocale()];
  // A client-side navigation removes the link the reader just activated, so focus falls back to
  // <body>: the next Tab restarts at the skip link and walks the whole sidebar again, on every page
  // change. Moving focus to the main region is also what makes "跳到正文" actually land somewhere —
  // a bare fragment target only moves the sequential-focus starting point. The first render is
  // skipped: on a cold load the reader belongs at the top of the document, not inside main.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // Search autofocus is deliberate; preserve it when the route mounts its input.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) return;
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        {shell.skipToMain}
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] outline-none lg:px-7 lg:pb-[72px] lg:pt-6">
        {/* The one thing said out loud when scripts are off. Expansions ("另有 N 家信源报道", "展开 N 条
            进展"), the filter controls and the canvas charts fetch or draw on the client, so their buttons
            are inert without JavaScript — the lists they open are never in the served HTML, so no CSS
            could reveal them either. Everything a reader came for is still here: every card is a real
            anchor, the daily issue, a story and its sources read top to bottom, and /all answers by form.
            Saying which half is missing is cheaper than letting someone hunt for a broken button.
            It lives inside <main>, not beside it: the shell's wrapper is `flex`, and a flex item is
            blockified into its own *column*, so a sibling <noscript> sat to the left of the whole page. */}
        <div className="mx-auto w-full max-w-[640px] px-4 lg:max-w-[var(--page-max-wide)] lg:px-0">
          <noscript dangerouslySetInnerHTML={{ __html: noscriptNoticeHtml(shell.noscriptNotice) }} />
          <PageBoundary resetKey={pathname}>{children}</PageBoundary>
        </div>
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
  const { pathname, search, hash } = useLocation();
  // 错误页也说页面自己的语言：文案与两个出口链接（/、/all）都跟着 locale 走。
  const locale = useLocale();
  const e = shellCopy[locale].error;
  const connectionError = isNetworkRouteError(error);
  const status = isRouteErrorResponse(error) ? error.status : connectionError ? 503 : 500;
  const notFound = status === 404;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? e.notFoundTitle : connectionError ? e.connectionTitle : e.unavailableTitle}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? e.notFoundBody : connectionError ? e.connectionBody : e.unavailableBody}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {!notFound && (
            <Link to={{ pathname, search, hash }} reloadDocument className={buttonClass("primary")}>
              {e.reload}
            </Link>
          )}
          <Link to={localeAppPath("/", locale)} reloadDocument className={buttonClass("primary")}>
            {e.backHome}
          </Link>
          <Link to={localeAppPath("/all", locale)} className={buttonClass("secondary")}>
            {e.browseAll}
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (isAdminPath(pathname)) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null}>{body}</SiteShell>;
}
