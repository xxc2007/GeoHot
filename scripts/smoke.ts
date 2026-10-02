// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";

const at = process.argv.indexOf("--base");
// A prefixed deployment is naturally written with a trailing slash (`https://host/geohot/`), and every
// URL below is built as `base + path` with `path` already starting at the root — keep one slash.
const base = ((at > 0 ? process.argv[at + 1] : process.env.SITE_URL) ?? "http://localhost:3000").replace(/\/+$/, "");

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/weekly", "/monthly", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/api/v1/weeklies", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/feed/daily.xml", /xml/],
  ["/feed/weekly.xml", /xml/],
  ["/feed/monthly.xml", /xml/],
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
// The leaderboard pages answer 503 until the first round is published (a fresh site computes it when
// the worker starts; with collection off there is nothing to compute).
const LEADERBOARD = FEATURES.leaderboard ? ["/leaderboard", "/leaderboard/rules", "/leaderboard/sources"] : [];
PAGES.push(...LEADERBOARD);
if (FEATURES.codexResetMonitor) PAGES.push("/codex-reset");

let failed = 0;
const pageHtml: Array<[path: string, html: string]> = [];
async function check(path: string, expect: (res: Response, body: string) => string | null) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    if (res.status === 503 && LEADERBOARD.includes(path)) {
      console.log(`– ${path}  no leaderboard round published yet`);
      return;
    }
    const problem = res.status !== 200 ? `HTTP ${res.status}` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

for (const path of PAGES) await check(path, (_res, body) => { pageHtml.push([path, body]); return body.includes(SITE.name) ? null : `the page does not name ${SITE.name}`; });
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));
// MCP: the handshake answers with the site's server name.
const mcp = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }),
}).then((r) => r.text()).catch((e) => String(e));
const mcpOk = mcp.includes(`"name":"${SITE.mcpPrefix}"`);
console.log(`${mcpOk ? "✓" : "✗"} /api/mcp initialize${mcpOk ? "" : `  ${mcp.slice(0, 200)}`}`);
if (!mcpOk) failed += 1;

/**
 * Every root-absolute URL a page hands the browser must stay inside the deployment prefix. A plain
 * `href="/feed.xml"` resolves against the origin, not the base, so behind `…/geohot/` it lands on
 * whatever else lives on that domain — this one mistake produced six broken links (the RSS footer, the
 * three Agent-page resources, the OpenAPI link, and the whole no-JavaScript admin sign-in) before it got
 * a check. `<Link to>` is exempt: React Router prefixes those itself.
 *
 * Scope, and its blind spot: this reads the bytes the server sent. Anything a page only builds during
 * hydration is invisible here — that is exactly how the second canonical survived this check for a day
 * (`siteUrl()` answered `window.location.origin` in the browser, so React Router's client-side `meta()`
 * appended one pointing at the neighbouring site). The hydrated meta surface is guarded by the
 * Lighthouse canonical audit in `deploy/geohot/README-deploy.md`'s manual steps, not by this loop.
 */
const prefix = new URL(base).pathname.replace(/\/+$/, "");
if (prefix) {
  let escaping = 0;
  for (const [path, html] of pageHtml) {
    for (const m of html.matchAll(/(?:href|src|action)="(\/[^"]*)"/g)) {
      const url = m[1]!;
      // Cloudflare's email obfuscation rewrites mailto: links in the bytes it serves; the page rendered
      // them correctly, so the CDN's own path is not an escaping link here.
      if (url.startsWith("/cdn-cgi/")) continue;
      if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) continue;
      console.log(`✗ ${path}  ${url}  escapes the "${prefix}" deployment`);
      escaping += 1;
    }
    // The absolute identity a page claims for itself. `siteUrl()` used to answer `window.location.origin`
    // in the browser, which under a prefix is the *other* site on that domain; hydration then appended a
    // second canonical pointing there. Root-relative checks above cannot see that — it is a full URL.
    for (const m of html.matchAll(/<link rel="canonical" href="([^"]+)"|<meta property="og:url" content="([^"]+)"/g)) {
      const abs = m[1] ?? m[2]!;
      let u: URL;
      try { u = new URL(abs); } catch { console.log(`✗ ${path}  canonical/og:url is not absolute: ${abs}`); escaping += 1; continue; }
      if (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) {
        console.log(`✗ ${path}  ${abs}  claims an address outside the "${prefix}" deployment`);
        escaping += 1;
      }
    }
  }
  console.log(`${escaping ? "✗" : "✓"} root-absolute URLs stay under ${prefix}`);
  failed += escaping;
}

/**
 * The outlets must agree about which issues exist. They read the same table through different caches, and
 * they drifted twice in one day: /sitemap.xml listed eight `/daily/<日期>` locs while /api/site/reports/daily
 * listed one, and /feed/daily.xml carried the same eight — every blank issue the read-layer gate was written
 * to hide. Status codes cannot see that (all eight answered 200 with an honest 「本期没有入选内容」), so this
 * compares the key sets themselves: what the sitemap and the feed advertise must be what the site index and
 * the public API list. Red here means one outlet is publishing a period the others filtered out.
 */
const getText = async (path: string) => (await fetch(base + path, { signal: AbortSignal.timeout(30_000) })).text();
const jsonKeys = (body: string, field: "key" | "date" | "week" | "month") => {
  const parsed = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
  return (parsed.items ?? []).map((i) => String(i[field] ?? i.key ?? "")).filter(Boolean);
};
try {
  const [sitemap, dailyFeed, siteIndex, v1Dailies] = await Promise.all([
    getText("/sitemap.xml"),
    getText("/feed/daily.xml"),
    getText("/api/site/reports/daily"),
    getText("/api/v1/dailies"),
  ]);
  // Keys look like a date, an ISO week or a month. `/daily/archive` is a page, not an edition — matching it
  // by prefix counted the archive itself as a missing issue (a red on a correct deployment, which is its own
  // kind of wrong: the first draft of this check reported "sitemap 4 / feed 3" against the fixed build).
  const sitemapKeys = [...sitemap.matchAll(/<loc>[^<]*\/(daily|weekly|monthly)\/([^<]+)<\/loc>/g)]
    .map(([, kind, key]) => `${kind}/${key}`)
    .filter((k) => /^daily\/\d{4}-\d{2}-\d{2}$/.test(k) || /^weekly\/\d{4}-W\d{2}$/.test(k) || /^monthly\/\d{4}-\d{2}$/.test(k));
  const feedKeys = [...dailyFeed.matchAll(/<link>([^<]+)<\/link>/g)]
    .map((m) => m[1]!.match(/\/(daily\/\d{4}-\d{2}-\d{2})$/)?.[1])
    .filter((k): k is string => Boolean(k));
  const siteDaily = new Set(jsonKeys(siteIndex, "key").map((k) => `daily/${k}`));
  const apiDaily = new Set(jsonKeys(v1Dailies, "date").map((k) => `daily/${k}`));
  const problems: string[] = [];
  const sitemapDaily = sitemapKeys.filter((k) => k.startsWith("daily/"));
  // Advertising an issue the gate filtered out is the failure this check exists for — the sitemap is held
  // to it strictly, but only to it: its own cache is ~5 minutes by design, so a *missing* key right after a
  // publish is lag, not a bug.
  for (const k of sitemapDaily) if (!siteDaily.has(k) || !apiDaily.has(k)) problems.push(`sitemap advertises ${k}, the indexes do not`);
  for (const k of feedKeys) if (!siteDaily.has(k) || !apiDaily.has(k)) problems.push(`/feed/daily.xml advertises ${k}, the indexes do not`);
  // The three live reads (feed, site index, v1) share a ≤60 s cache, so they must agree exactly.
  if (feedKeys.length !== siteDaily.size || siteDaily.size !== apiDaily.size) {
    problems.push(`counts disagree: daily feed ${feedKeys.length} / site index ${siteDaily.size} / v1 ${apiDaily.size}`);
  }
  if (sitemapDaily.length !== siteDaily.size) {
    console.log(`– cross-outlet  sitemap lists ${sitemapDaily.length} daily issue(s) vs ${siteDaily.size} in the indexes（sitemap 自己的缓存约 5 分钟，可能是刚出刊）`);
  }
  for (const p of problems) console.log(`✗ cross-outlet  ${p}`);
  if (!problems.length) console.log(`✓ cross-outlet  sitemap, daily feed, site index and v1 agree on ${siteDaily.size} issue(s)`);
  failed += problems.length;
} catch (error) {
  console.log(`✗ cross-outlet  ${String(error)}`);
  failed += 1;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
