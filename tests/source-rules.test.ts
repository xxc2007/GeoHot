// Every rule a source's config names is applied, and a name the collector does not implement fails the
// fetch. Configs that carried adapters and detail rules a collector does not implement used to fall
// back silently (junk titles, RSS entries outside the source's URL rules, dates from the wrong place).
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { extractArticleBody, readable } from "@aihot/backend/content/extract";
import { collectSource } from "@aihot/backend/sources/collect";
import { updateSource, previewSource } from "@aihot/backend/admin/sources";

const T = tag();
const LONG = `${"A card label that swallowed the summary of the article it links to, ".repeat(2)}${T}`;
let jinaDetailReads = 0;
let jinaListingReads = 0;
const pageReads = new Map<string, number>();
const ARTICLE_BODY = "A complete article with enough material to preserve the same extraction result without downloading it twice. ".repeat(6);
const html = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const pages: Record<string, (base: string) => string> = {
  "/feed.xml": () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` +
    ["news/a", "business/b"].map((p) => `<item><title>Entry ${p} ${T}</title><link>https://example.org/rules-${T}/${p}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join("") +
    `</channel></rss>`,
  "/list.html": () => html("", `<ul><li><a href="/p/a-${T}">Short clean title ${T}</a><time>2026-09-20</time></li><li><a href="/p/b-${T}">${LONG}</a></li></ul>`),
  [`/p/a-${T}`]: () =>
    html(`<meta name="description" content="Summary of A"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`, `<h1>Detail heading A</h1><p class="byline"><time datetime="2026-09-21T08:00:00Z">Sep 21</time></p>`),
  [`/p/b-${T}`]: () => html(`<meta name="description" content="Summary of B"><meta property="article:published_time" content="2026-01-01T00:00:00Z">`, `<article><h1>Detail heading B ${T}</h1><p>${ARTICLE_BODY}</p></article>`),
  [`/j/1-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T01:00:00Z">`, "<p>one</p>"),
  [`/j/2-${T}`]: () => html(`<meta property="article:published_time" content="2026-09-27T02:00:00Z">`, "<p>two</p>"),
};
// Jina Reader: GET /<target URL> answers the rendering, with its header lines.
const jina = (base: string, target: string) => {
  const md = target.endsWith(`/jlist-${T}`)
    ? `[Short Jina title ${T}](${base}/j/1-${T})\n\n[${LONG}](${base}/j/2-${T})`
    : `# Heading from Jina ${T}\n\nThe article.`;
  if (target.endsWith(`/jlist-${T}`)) jinaListingReads += 1;
  else jinaDetailReads += 1;
  return `Title: Page\nURL Source: ${target}\nPublished Time: 2026-09-27T00:00:00Z\nMarkdown Content:\n${md}`;
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  pageReads.set(path, (pageReads.get(path) ?? 0) + 1);
  const body = path.startsWith("/http") ? jina(base, path.slice(1)) : Object.hasOwn(pages, path) ? pages[path]!(base) : null;
  res.writeHead(body === null ? 404 : 200, { "content-type": path.endsWith(".xml") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = base;
process.env.JINA_API_KEY = "test-key";

const SOURCES = {
  unsupported: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, adapter: "feed_cards" } },
  denied: { kind: "rss", config: { feedUrl: `${base}/feed.xml`, denyUrlPrefixes: [`https://example.org/rules-${T}/business/`] } },
  detail: {
    kind: "web_list",
    config: {
      url: `${base}/list.html`, parseMode: "html", itemSelector: "li", linkSelector: "a", titleSelector: "a", publishedAtSelector: "time",
      detail: { maxFetches: 10, titleSelector: "h1", summarySelector: 'meta[name="description"]', publishedAtAuthoritative: true, publishedAtSelector: ".byline time" },
    },
  },
  jina: { kind: "web_list", config: { url: `https://r.jina.ai/${base}/jlist-${T}`, parseMode: "markdown", allowUrlPrefixes: [`${base}/j/`], detail: { maxFetches: 5, titleRegex: "^# (.+)$" } } },
};
const id = (name: keyof typeof SOURCES) => `test-rules-${name}-${T}`;
let savedJina: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  savedJina = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'jina'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'jina'`;
  const cursor = sql.json({ initializedAt: new Date().toISOString() });
  for (const [name, s] of Object.entries(SOURCES)) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
              VALUES (${id(name as keyof typeof SOURCES)}, ${name}, ${s.kind}, ${sql.json(s.config)}, 'T1', 'editorial', ${cursor}, '2100-01-01')`;
  }
});
after(async () => {
  for (const b of savedJina) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = 'jina'`;
  // A leftover article still in processing_state = 'new' is counted by tests/alerts.test.ts, which reads
  // the backlog table-wide, so it would fail in an unrelated file.
  await purgeTagged(T);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articles = (sourceId: string) =>
  sql<{ url: string; title: string; excerpt: string | null; published_at: Date | null; revision: number }[]>`
    SELECT url, title, excerpt, published_at, revision FROM articles WHERE source_id = ${sourceId} ORDER BY url`;

test("a config entry the collector does not implement fails the fetch instead of being ignored", async () => {
  const run = await collectSource(id("unsupported"), { force: true });
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /unsupported config: adapter/);
  assert.equal((await articles(id("unsupported"))).length, 0, "nothing collected by a fallback parse");
  const [row] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${id("denied")}`;
  await assert.rejects(
    updateSource(id("denied"), { patch: { config: { ...SOURCES.denied.config, detail: { titleFoo: "h1" } } }, version: row!.updated_at.toISOString() }, "test"),
    /不支持的配置项：detail\.titleFoo/,
    "the admin refuses it before it is saved",
  );
});

test("feed entries outside the source's URL rules are skipped", async () => {
  assert.equal((await collectSource(id("denied"), { force: true })).status, "ok");
  assert.deepEqual((await articles(id("denied"))).map((a) => a.url), [`https://example.org/rules-${T}/news/a`]);
});

test("「试抓一次」数的是本站规则留下的条数，与采集同一条流水线", async () => {
  // 站长是按这个数批准一条源的。预览以前直接数解析出来的候选，于是它比真采集留下的那一个大：
  // PNAS 目录里的 Correction / Retraction / In This Issue、IFRC 的 /node/ 网址都算进过预览，
  // 而采集那一轮一条都不入库（denyUrlPrefixes 与 ingestNoiseFilter 挡在外面）。
  // 说清楚这个数**不等於**"首轮会写进库几条"：真采集还要过首次导入上限（`_aihot.initialBackfillLimit`，
  // 缺省 30）、每轮 120 条的上限和按身份去重——预览一条都不过。所以卡片写的是"本站规则留下"，不是"会入库"。
  const preview = await previewSource({ id: id("denied"), kind: "rss", config: SOURCES.denied.config } as never);
  assert.equal(preview.offered, 2, "这条源的列表本来给两条");
  assert.equal(preview.count, (await articles(id("denied"))).length, "这条夹具没有上限与历史行，规则留下的就是真入库的那一条");
  assert.deepEqual(preview.items.map((i) => i.url), [`https://example.org/rules-${T}/news/a`], "预览列出来的也得是规则之后剩下的");
});

test("规则项写成字符串时后台拒收，而不是让采集抛 TypeError", async () => {
  // `allowed()` 对 allowUrlPrefixes / denyUrlPrefixes 直接 `.map`，`noiseFiltered` 对 dropMarkers 一类
  // 直接 `.some`：写成字符串就是 TypeError，api 回 500，站长在预览按钮上看到的是"未知错误"。
  // 现在 assertSupportedConfig 按形状先拒（create / edit / preview 三个入口共用它）。
  const [row] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${id("denied")}`;
  const bad = { ...SOURCES.denied.config, allowUrlPrefixes: `https://example.org/rules-${T}/` };
  await assert.rejects(
    updateSource(id("denied"), { patch: { config: bad }, version: row!.updated_at.toISOString() }, "test"),
    /allowUrlPrefixes（要字符串数组）/,
    "保存时按形状拒掉，别留到采集那一轮炸",
  );
  await assert.rejects(previewSource({ id: id("denied"), kind: "rss", config: bad } as never), /allowUrlPrefixes/);
  const badNoise = { ...SOURCES.denied.config, ingestNoiseFilter: { dropMarkers: "Retraction" } };
  await assert.rejects(previewSource({ id: id("denied"), kind: "rss", config: badNoise } as never), /ingestNoiseFilter\.dropMarkers（要字符串数组）/);
  // 数组的数组、以及 null / 缺省都不该被误伤（读它们的地方一律 `?? []`）。
  assert.equal((await previewSource({ id: id("denied"), kind: "rss", config: { ...SOURCES.denied.config, denyCategories: null } } as never)).count, 1);
});

test("detail rules fill what the listing lacks, and a detail title survives the next listing", async () => {
  for (let run = 0; run < 2; run++) assert.equal((await collectSource(id("detail"), { force: true })).status, "ok");
  const [a, b] = await articles(id("detail"));
  assert.deepEqual([a!.title, a!.excerpt, a!.published_at?.toISOString(), a!.revision], [`Short clean title ${T}`, "Summary of A", "2026-09-21T08:00:00.000Z", 1],
    "a clean listing title stays; the byline, not the listing date or page metadata, dates it");
  assert.deepEqual([b!.title, b!.excerpt, b!.published_at, b!.revision], [`Detail heading B ${T}`, "Summary of B", null, 1],
    "a label that swallowed its summary takes the page's heading; without a byline there is no date; the listing does not revise it back");
});

test("a Jina listing is read on every fetch, and buys a detail rendering only where a regex rule needs it", async () => {
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  const rows = await articles(id("jina"));
  assert.deepEqual(rows.map((r) => [r.title, r.published_at?.toISOString()]), [
    [`Short Jina title ${T}`, "2026-09-27T01:00:00.000Z"],
    [`Heading from Jina ${T}`, "2026-09-27T02:00:00.000Z"],
  ], "the title regex reads Jina's text; dates come from the pages' own HTML");
  assert.equal(jinaDetailReads, 1, "one paid detail rendering: only the long title needed one");
  assert.equal((await collectSource(id("jina"), { force: true })).status, "ok");
  assert.deepEqual([jinaListingReads, jinaDetailReads], [2, 1], "every fetch reads the listing afresh; known articles buy no detail");
});


test("detail HTML supplies the ordinary extracted body once, while short pages keep extraction pending", async () => {
  const rows = await sql<{ id: string; url: string; body_html: string | null; body_text: string | null; body_status: string }[]>`
    SELECT id, url, body_html, body_text, body_status FROM articles WHERE source_id = ${id("detail")} ORDER BY url`;
  const [short, full] = rows;
  assert.equal(short!.body_status, "pending", "an unconfirmed body retains the original extraction fallback");
  const expected = readable(pages[`/p/b-${T}`]!(base), `${base}/p/b-${T}`)!;
  assert.deepEqual([full!.body_html, full!.body_text, full!.body_status], [expected.html, expected.text, "ok"]);
  assert.equal(await extractArticleBody(full!.id, false), "skipped");
  assert.equal(pageReads.get(`/p/b-${T}`), 1, "known listings and extraction never download the same confirmed body again");
});
