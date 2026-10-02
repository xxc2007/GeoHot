// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";

const at = process.argv.indexOf("--base");
// A prefixed deployment is naturally written with a trailing slash (`https://host/geohot/`), and every
// URL below is built as `base + path` with `path` already starting at the root — keep one slash.
const base = ((at > 0 ? process.argv[at + 1] : process.env.SITE_URL) ?? "http://localhost:3000").replace(/\/+$/, "");

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
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
  }
  console.log(`${escaping ? "✗" : "✓"} root-absolute URLs stay under ${prefix}`);
  failed += escaping;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
