// 《地理研究》 publishes its own back-issue index, and that index — not Crossref — is the only door to the
// Chinese half of the archive (measured 2026-10-10: Crossref has 6 of the 8 ISSNs those journals print
// unregistered, so the 1,927-item archive this site built had zero Chinese titles).
//
// The pages below are trimmed from the live markup of 2026-10-10: an issue row is `<div class="gk_qi">` with
// one anchor and the 刊出日期 beside it, and an article row is `<div class="j-title-1">` whose anchor is the
// title — repeated later in the same block by a 摘要 link to the same URL. Five things are locked here, each
// one a way this route could quietly publish the wrong thing:
//
//   * the index's own origin is what the walk is allowed to read (the live `allowUrlPrefixes` names `/CN/10.`,
//     which would drop every issue URL, and a back-issue page links other hosts too);
//   * every article carries the issue's date, not the day the archive was walked;
//   * that date is the day's Beijing midnight, so a 1月10日 issue joins the 2026-01-10 paper instead of the
//     next morning's — a daily closes at Beijing 08:00, which is exactly where an ISO date read as UTC lands;
//   * an issue the index does not date comes back undated, so `scripts/backfill-archive.ts` has nothing to
//     file and the month stays open instead of filling with crawl-day news;
//   * one article appears once, under its title rather than under "摘要".
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { backIssues, issueArticles } from "@aihot/backend/sources/archive-site";
import type { SourceRow } from "@aihot/backend/sources/types";

const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;

let origin = "";
const pages = new Map<string, string>();
let server: http.Server | null = null;

/** The live rules of `web-dlyj-toc`, with the archive keys pointed at the local copy of its index. */
const source = (indexUrl: string): SourceRow => ({
  id: "web-dlyj-toc",
  name: "地理研究 当期目录",
  kind: "web_list",
  config: {
    url: `${origin}/CN/1000-0585/home.shtml`,
    parseMode: "html",
    itemSelector: "a[href*='/CN/10.']",
    allowUrlPrefixes: [`${origin}/CN/10.`],
    archiveIndexUrl: indexUrl,
    archiveIssueItemSelector: "div.gk_qi",
    archiveIssueDateRegex: String.raw`(\d{4}-\d{2}-\d{2})`,
  },
  tier: "T1_5",
  participation_mode: "editorial",
  first_party: true,
  interval_minutes: 240,
  enabled: true,
  cursor: null,
  fail_count: 0,
});

const issueRow = (href: string, label: string, date: string) => `<div class="gk_qi"><a href="${href}"><span>${label}</span></a> ${date}</a></div>`;

/** Paths the fake journal fails to serve this many times before answering — and how often each was asked. */
const flaky = new Map<string, number>();
const hits = new Map<string, number>();

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const failFor = flaky.get(path);
    if (failFor !== undefined && failFor > 0) {
      flaky.set(path, failFor - 1);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Magtech 500");
      return;
    }
    const body = pages.get(path);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("no such page");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  pages.set("/CN/archive_by_issues", `<!doctype html><html><body><div class="gk_nian">2026</div>
    ${issueRow(`${origin}/CN/Y2026/V45/I2`, "2026 Vol. 45 No. 2 pp. 283-560", "2026-02-10")}
    ${issueRow(`${origin}/CN/Y2026/V45/I1`, "2026 Vol. 45 No. 1 pp. 1-281", "2026-01-10")}
    ${issueRow(`${origin}/CN/Y2026/V45/I3`, "2026 Vol. 45 No. 3 pp. 561-854", "")}
    ${issueRow("https://elsewhere.example.org/CN/Y2026/V45/I9", "2026 Vol. 45 No. 9", "2026-09-10")}
    <a href="${origin}/CN/article/showTenYearVolumnDetail.do">近十年目录</a>
    </body></html>`);
  pages.set("/CN/redesigned.html", `<!doctype html><html><body><p>过刊浏览已改版，本页没有期次行</p></body></html>`);
  pages.set("/CN/Y2026/V45/I1", `<!doctype html><html><body>
    <div class="j-title-1"><a href="${origin}/CN/10.11821/dlyj020240809">再野化发展脉络、研究进展及未来展望</a></div>
    <div class="j-volumn-doi"><span class="j-volumn">2026, 45(1): 1-18.</span></div>
    <div class="j-btn"><a class="j-abs" href="${origin}/CN/10.11821/dlyj020240809">摘要</a></div>
    <div class="j-title-1"><a href="${origin}/CN/10.11821/dlyj020250141">古都更新背景下文化环境对地方依恋的影响研究——以开封市155个社区为例</a></div>
    <a href="${origin}/CN/Y2026/V45/I2">下一期</a>
    <span class="n-j-q">刊出日期：2026-01-10</span>
    </body></html>`);
});

after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("the back-issue index yields its issues, dated by the page that lists them", async () => {
  const issues = await backIssues(source(`${origin}/CN/archive_by_issues`));
  // In document order, undated kept as undated, and nothing from another host.
  assert.deepEqual(issues.map((i) => `${i.url.replace(origin, "")} ${i.at ? beijingDate(i.at) : "无日期"}`), [
    "/CN/Y2026/V45/I2 2026-02-10",
    "/CN/Y2026/V45/I1 2026-01-10",
    "/CN/Y2026/V45/I3 无日期",
  ]);
  // The instant is that day's Beijing midnight, not UTC's: an issue dated 2026-01-10 has to land in the
  // 2026-01-10 paper, and a daily closes at Beijing 08:00, so UTC midnight would file it one day late.
  assert.equal(issues[1]!.at?.toISOString(), "2026-01-09T16:00:00.000Z");
});

test("an issue page yields each article once, under the issue's own date", async () => {
  const issue = { url: `${origin}/CN/Y2026/V45/I1`, at: beijingMidnight("2026-01-10") };
  const items = await issueArticles(source(`${origin}/CN/archive_by_issues`), issue);
  assert.deepEqual(items.map((c) => c.url.replace(origin, "")), ["/CN/10.11821/dlyj020240809", "/CN/10.11821/dlyj020250141"]);
  assert.deepEqual(items.map((c) => c.title), ["再野化发展脉络、研究进展及未来展望", "古都更新背景下文化环境对地方依恋的影响研究——以开封市155个社区为例"]);
  // Both entries dated by the issue, so the whole 期 lands in the paper of its own day.
  for (const c of items) assert.equal(c.publishedAt?.toISOString(), issue.at.toISOString());
});

test("an index the journal no longer recognizes is a refusal, not an empty month", async () => {
  // A page with no issue rows: `fetchWebList` answers "no items matched", which the script keeps as a slice
  // that did not finish rather than one that came up empty.
  await assert.rejects(() => backIssues(source(`${origin}/CN/redesigned.html`)), /no items matched/);
  // And an archive rule the source never declared says which rule is missing instead of walking nothing.
  const undeclared = source("");
  await assert.rejects(() => backIssues(undeclared), /archiveIndexUrl/);
});

// 2026-10-10, from the collector box: 《地理学报》's index answered HTTP 500 inside the backfill and HTTP 200
// with the same 204 KB body minutes later over the same crawler UA; 《地理研究》 answered 500 for a bare
// `curl/8` UA and 200 for two others. The Magtech CMS fails on its own, so one 500 must not abandon a month.
test("一次 5xx 不算这一期跑完：过刊门补读一次，非 5xx 的不重跑", async () => {
  const index = pages.get("/CN/archive_by_issues")!;
  pages.set("/CN/flaky_index.html", index);
  pages.set("/CN/dead_index.html", index);
  flaky.set("/CN/flaky_index.html", 1);
  flaky.set("/CN/dead_index.html", 99);

  const issues = await backIssues(source(`${origin}/CN/flaky_index.html`));
  assert.equal(issues.length, 3, "补读这一次就把三期都读出来了");
  assert.equal(hits.get("/CN/flaky_index.html"), 2, "第一次 500、第二次成功");

  await assert.rejects(() => backIssues(source(`${origin}/CN/dead_index.html`)), /HTTP 500/);
  assert.equal(hits.get("/CN/dead_index.html"), 2, "只补一次——一直坏就照实说这一片没跑完");

  // A page the parser yields nothing from is an answer about the page, not the server's mood: retrying it
  // would double every request for a journal that redesigned its index and still return nothing.
  const asked = hits.get("/CN/redesigned.html") ?? 0;
  await assert.rejects(() => backIssues(source(`${origin}/CN/redesigned.html`)), /no items matched/);
  assert.equal((hits.get("/CN/redesigned.html") ?? 0) - asked, 1, "解析不出条目不重试");
});
