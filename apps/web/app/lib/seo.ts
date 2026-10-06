// Page metadata from one place: title template, canonical address, OG images, robots. The site's name
// and wording come from the industry pack (industry/site.ts); its address from SITE_URL.
import type { MetaDescriptor } from "react-router";
import { SITE } from "@aihot/industry/site";
import { basePath } from "./public-path";

/**
 * The site's address — one value, decided by the server and read back by the browser.
 *
 * The obvious browser answer, `window.location.origin`, is wrong twice over. Behind a prefixing
 * deployment the origin (`xxc2007.me`) is not where this site lives (`xxc2007.me/geohot`), and the bare
 * origin is a **different website**: React Router re-runs every route's `meta()` during hydration, so an
 * origin-only base appended a second `rel=canonical` (plus `og:url`, `og:image` and the JSON-LD
 * addresses) pointing at the neighbour — Lighthouse failed the canonical audit on it, and a JS-rendering
 * crawler saw our pages as canonicalising to someone else's. Second, whenever the page is opened at an
 * address other than `SITE_URL` — a developer's `127.0.0.1:3000`, an alias host — the server and the
 * client disagree on every absolute URL and React reports a hydration mismatch (measured on the home
 * page's JSON-LD, 2026-10-05).
 *
 * So the server writes its own answer into `<html data-site-url>` from the root loader and the browser
 * reads it instead of guessing. `basePath` remains only as the fallback for a document that never got
 * root loader data (an error page).
 */
export function siteUrl(): string {
  if (typeof window === "undefined") return serverSiteUrl();
  return document.documentElement.dataset.siteUrl ?? `${window.location.origin}${basePath}`;
}

/** What the server answers with, and what the browser is handed back. */
export function serverSiteUrl(): string {
  return (process.env.SITE_URL || SITE.defaultUrl).replace(/\/+$/, "");
}

export const HOME_TITLE = SITE.homeTitle;
export const SITE_DESCRIPTION = SITE.description;

export interface PageMetaInput {
  title?: string | null;
  /** Use `title` verbatim as the document title (no " · <site>" suffix). */
  rawTitle?: boolean;
  description?: string | null;
  path: string;
  image?: string | null;
  noindex?: boolean;
  nofollow?: boolean;
  type?: "website" | "article";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
}

/**
 * A list page's own address (canonical, og:url) from the filters it applied: tracking and unknown
 * parameters (`?from=timeline`, `utm_*`) never become part of it. The page caches keep one copy across
 * such parameters, so the address in that copy must not depend on them either.
 */
export function listPath(path: string, params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** "Title · Site". */
export function titled(title: string): string {
  return `${title} · ${SITE.name}`;
}

/**
 * Metadata is display, and some of what feeds it comes from material rather than from us: one ingested
 * item's "title" is an entire lead paragraph, and it was going into `<title>`, `og:title` and the share
 * image's alt text verbatim (2026-10-02 sweep). Clamp here — browser tabs and share cards truncate anyway,
 * and a clamped metadata title never changes the page body, which still shows every character.
 */
const clampMeta = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export function pageMeta(input: PageMetaInput): MetaDescriptor[] {
  const base = siteUrl();
  const title = input.title ? (input.rawTitle ? clampMeta(input.title, 60) : titled(clampMeta(input.title, 60))) : HOME_TITLE;
  const description = clampMeta(input.description ?? SITE_DESCRIPTION, 160);
  const url = `${base}${input.path}`;
  const image = input.image ? (input.image.startsWith("http") ? input.image : `${base}${input.image}`) : `${base}/og/site.png`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:site_name", content: SITE.name },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: clampMeta(input.title ?? HOME_TITLE, 60) },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:alt", content: clampMeta(`${input.title ?? HOME_TITLE} — ${SITE.name}`, 120) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:locale", content: SITE.locale.replace("-", "_") },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: input.title ?? HOME_TITLE },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  if (input.noindex) tags.push({ name: "robots", content: input.nofollow ? "noindex, nofollow" : "noindex, follow" });
  if (input.jsonLd) tags.push({ "script:ld+json": input.jsonLd });
  return tags;
}

export function organizationLd() {
  const base = siteUrl();
  const founder = SITE.organization.founder;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.organization.name,
    url: base,
    logo: `${base}/icon.png`,
    ...(founder ? { founder: { "@type": "Person", name: founder.name, ...(founder.description ? { description: founder.description } : {}), ...(founder.url ? { sameAs: [founder.url] } : {}) } } : {}),
  };
}

export function breadcrumbLd(items: Array<{ name: string; path: string }>) {
  const base = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: `${base}${it.path}` })),
  };
}
