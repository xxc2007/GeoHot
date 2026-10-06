// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
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

/**
 * Every reader-facing item must carry Chinese copy. This is the invariant the 2026-10-02 leak violated: the
 * local editing brain echoed English source titles into `title_zh`, so twelve untranslated items reached the
 * public pool, the front page and the daily paper while the pipeline believed they were translated. The
 * pipeline holds such items as `unknown` until a human writes the Chinese (editorial/analyze.ts), and the
 * stub no longer manufactures one; this check makes the promise machine-visible instead of hoping the
 * default stays honest.
 *
 * It runs over the outlets, not one of them: the same rule is written as one SQL predicate shared by the
 * lists (items.ts `chineseCopyCondition`), and a check on a single outlet would not notice the next outlet
 * reading the other predicate — which is exactly how the front page kept leaking English cards while /all
 * was already clean.
 */
const HAN = new RegExp(CJK_COPY_PATTERN);
/** An English source title that no one has rewritten in Chinese: Latin words, no Han character at all. */
const englishCopy = (t: unknown): t is string => typeof t === "string" && /[A-Za-z]{3,}/.test(t) && !HAN.test(t);
const titlesOfJson = (body: string, pick: (parsed: any) => unknown[]): string[] => {
  try { return (pick(JSON.parse(body)) ?? []).filter(Boolean).map(String); } catch { return []; }
};
/** The `<item><title>` entries of an RSS feed, CDATA unwrapped (the channel title is not an item). */
const titlesOfFeed = (xml: string): string[] =>
  [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/g)].map((m) => (m[1] ?? m[2] ?? "").trim());

try {
  const topics = JSON.parse(await getText("/api/site/topics")) as { topics?: Array<{ slug: string; name: string; total: number }> };
  const busiest = (topics.topics ?? []).slice().sort((a, b) => b.total - a.total)[0];
  const outlets: Array<[name: string, titles: string[]]> = [
    ["首页时间线", titlesOfJson(await getText("/api/site/timeline?limit=40"), (p) => p.cards?.map((c: any) => c.item?.title))],
    ["v1 精选", titlesOfJson(await getText("/api/v1/items?mode=selected&limit=100"), (p) => p.items?.map((i: any) => i.title))],
    ["v1 全部", titlesOfJson(await getText("/api/v1/items?mode=all&limit=100"), (p) => p.items?.map((i: any) => i.title))],
    ["精选 RSS", titlesOfFeed(await getText("/feed.xml"))],
    // 主题目录本身不参与这条判定：/topics 上那 45 条是主题名，IPCC、OpenStreetMap 这类专有名词本来就没有
    // 中文写法，把它们当"没有中文标题的条目"是这条检查的误报。条目标题由下面的主题页和上面的时间线覆盖。
    // 主题页只查内容最多的那一个：它一定有内容，也不会因为空主题页而假绿。
    ...(busiest ? [[`主题页 ${busiest.slug}`, titlesOfJson(await getText(`/api/site/topics/${busiest.slug}`), (p) => (p.items ?? []).map((i: any) => i.title))] as [string, string[]]] : []),
  ];
  // The paper is a machine exit too: an entry the reader cannot read in Chinese must not be set in it.
  const latestDaily = await fetch(`${base}/api/v1/dailies/latest`, { signal: AbortSignal.timeout(30_000) });
  if (latestDaily.status === 200) {
    outlets.push(["日报版面", titlesOfJson(await latestDaily.text(), (p) => [
      ...((p.report?.sections ?? []) as any[]).flatMap((s: any) => (Array.isArray(s?.items) ? s.items : [])).map((i: any) => i?.title ?? ""),
      ...((p.report?.flashes ?? []) as any[]).map((f: any) => f?.title ?? ""),
    ])]);
  } else {
    console.log(`– reader copy  no daily paper yet (HTTP ${latestDaily.status})`);
  }

  let leaks = 0;
  for (const [name, titles] of outlets) {
    // 取不到数组说明这一出口的形状变了——那是一次失败，不是一行崩溃：整段检查被 throw 打断时，
    // 后面几个出口就再也没被看过，而输出看起来只像"最后一条报错了"。
    if (!Array.isArray(titles)) {
      console.log(`✗ reader copy  ${name}：取到的不是标题数组（这一出口的形状变了，检查没跑）`);
      failed += 1;
      continue;
    }
    const bad = titles.filter(englishCopy);
    leaks += bad.length;
    if (bad.length) {
      for (const t of bad.slice(0, 3)) console.log(`✗ reader copy  ${name}: ${t.slice(0, 80)}`);
      console.log(`✗ reader copy  ${name} 有 ${bad.length}/${titles.length} 条没有中文标题`);
    } else {
      console.log(`✓ reader copy  ${name}：${titles.length} 条都有中文标题`);
    }
  }
  failed += leaks;
} catch (error) {
  console.log(`✗ reader copy  ${String(error)}`);
  failed += 1;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
