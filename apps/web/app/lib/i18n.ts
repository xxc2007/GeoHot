// Which language a page speaks, decided in one place. The site serves every reader route twice —
// once unprefixed (Chinese, the original pages) and once under `/en` (same component files, English
// chrome; article titles, summaries and report bodies stay Chinese and say so). A page learns its
// language from the pathname it was rendered for, so the server and the browser hydrate the same
// answer: both sides run `useLocation()` (or read the route's `meta()` location) and never touch
// `window`. The deployment prefix (BASE_PATH) is stripped first, through `public-path.ts`, because
// `/geohot/en/hot` and `/en/hot` must read as the same page.
import { useLocation } from "react-router";
import { appPath, publicPath } from "./public-path.ts";

export type Locale = "zh" | "en";

/** `og:locale` for the English pages; the Chinese one comes from `SITE.locale` (`zh-CN`). */
export const EN_OG_LOCALE = "en_US";

/**
 * A path's language: `/en`, `/en/` or anything under `/en/` is English, everything else is Chinese.
 * Admin paths (which keep the Chinese chrome) never start with `/en`, so they read as `zh` — correct.
 */
export function localeFromPath(pathname: string): Locale {
  const path = appPath(pathname);
  return path === "/en" || path.startsWith("/en/") ? "en" : "zh";
}

/** The language of the page this component rendered for. */
export function useLocale(): Locale {
  return localeFromPath(useLocation().pathname);
}

/**
 * The language switch in pure app-path terms — no deployment prefix, query and hash carried over:
 * `"/hot"` ↔ `"/en/hot"`, `"/"` ↔ `"/en"`, `"/all?category=x"` ↔ `"/en/all?category=x"`. This is the
 * right building block for absolute URLs (`lib/seo.ts`): on prefix deployments `SITE_URL` already
 * carries the prefix (`https://host/geohot`), so adding `basePath` again would double it.
 */
export function localeAppPath(path: string, target: Locale): string {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const raw = match?.[1] ?? path;
  const tail = `${match?.[2] ?? ""}${match?.[3] ?? ""}`;
  // Deployments behind a prefix sometimes hand in browser paths (`location.pathname` from a router
  // without a basename); `appPath` strips the prefix when present and is a no-op otherwise.
  const app = appPath(raw);
  const bare = app === "/en" ? "/" : app.startsWith("/en/") ? app.slice(3) : app;
  return `${target === "en" ? (bare === "/" ? "/en" : `/en${bare}`) : bare}${tail}`;
}

/**
 * The same switch as a browser path — what a plain `<a href>` or `window.location.assign()` must say.
 * `"/hot"` ↔ `"/en/hot"`, including the BASE_PATH scenario where the answer is `/geohot/en/hot`; same
 * contract as `publicPath()`, which this wraps.
 *
 * NOT for `<Link to>` / `useNavigate()` / `redirect()`: React Router adds `basename` to those targets
 * itself (router.js `normalizeRedirectLocation` / `useHref`), so a public path handed to a `<Link>`
 * becomes `/geohot/geohot/...` on a prefix deployment. React-router targets take {@link localeAppPath}.
 */
export function localePath(path: string, target: Locale): string {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const raw = match?.[1] ?? path;
  const tail = `${match?.[2] ?? ""}${match?.[3] ?? ""}`;
  return `${publicPath(localeAppPath(raw, target))}${tail}`;
}

/** The opposite language of the page — the language switch's entire job. */
export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh" : "en";
}
