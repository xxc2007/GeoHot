// Listing parsers on the page shapes Jina returns for real sites: card links that wrap
// an image, a title attribute, http links under https prefixes, and navigation that is no post. Also
// what made articles flip between versions: in-page anchors of an HTML listing and
// promotions a feed rotates inside its posts. And the Xiaomi MiMo homepage, whose posts have no links in
// its HTML: read without its adapter, it gave the menu (MiMo Desktop, 简体中文) as articles.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sanitizeBody, trimTrailingChrome } from "@aihot/backend/content/sanitize";
import { fetchDetail, fetchWebList, fromHtml, fromMarkdown } from "@aihot/backend/sources/web-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import { pageFetchable } from "@aihot/backend/content/extract";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { noiseFiltered } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

const source = (config: Record<string, unknown>) => ({ id: "test-list", config }) as never;

// mimo.xiaomi.com as served on 2026-09-28, cut down: rows that navigate by script, the runtime's chunk
// map, the route table naming the homepage's chunks, and the chunk with the Blog list among the menu,
// the model cards, the other sections and a Paper list built at run time.
const pages: Record<string, (cdn: string) => string> = {
  "/": (cdn) =>
    `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script><script defer src="${cdn}static/js/4752.2908c99e.js"></script>` +
    `<script defer src="${cdn}static/js/index.c5195ace.js"></script></head><body><a href="/zh/index">简体中文</a><a href="/mimocode">MiMo Code</a>` +
    `<a href="/go/desktop">MiMo Desktop</a><a href="/#paper">Paper</a><a href="/#blog">Blog</a><a href="/#joinUs">Join Us</a><div id="blog-list">` +
    `<div class="blogRow-kPt4Cj" data-font-interactive="true"><h3 data-font-text="true">Diagnosing and Mitigating Tool-Call Repetition in MiMo-V2.6</h3></div></div></body></html>`,
  // A redesign that moved the list elsewhere.
  "/redesigned/": (cdn) => `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script></head><body><a href="/go/desktop">MiMo Desktop</a></body></html>`,
  // The Verge's feed: a teaser that ends in "Read the full story", next to a post whose feed carries it whole.
  "/verge.xml": () =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<entry><title>AMD is acquiring World Labs</title><link rel="alternate" href="https://example.org/amd-world-labs"/><published>2026-09-28T17:31:35-04:00</published>` +
    `<summary type="html">AMD announced today that it's acquiring World Labs.</summary>` +
    `<content type="html"><![CDATA[<p>${"AMD announced today that it is acquiring World Labs in an all-stock deal. ".repeat(8)}</p><p>Read the full story at The Verge.</p>]]></content></entry>` +
    `<entry><title>A whole post</title><link rel="alternate" href="https://example.org/whole"/><published>2026-09-28T10:00:00Z</published>` +
    `<content type="html"><![CDATA[<p>${"The feed carries this post whole, paragraph after paragraph. ".repeat(30)}</p>]]></content></entry></feed>`,
  // A video channel's Atom feed (the shape YouTube serves for `?channel_id=`): no `<content>`, no
  // `<summary>` — the description and the still live in the media namespace.
  // worldpoliticsreview.com answered the site's own crawler UA with 403 and a reader-like UA with the
  // feed (measured 2026-10-06), so an rss source's `config.headers` has to reach the request itself.
  // The handler serves this path only while that header is on the wire.
  "/reader.xml": () =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Readers only</title>` +
    `<item><title>Only readers see this</title><link>https://example.org/reader-1</link>` +
    `<description>One item, behind a client check.</description><pubDate>Sun, 05 Oct 2026 09:00:00 GMT</pubDate></item>` +
    `</channel></rss>`,
  "/video.xml": () =>
    `<?xml version="1.0"?><feed xmlns:media="http://search.yahoo.com/mrss/" xmlns:yt="http://www.youtube.com/xml/schemas/2015">` +
    `<entry><id>yt:video:pKJDW8oOXuU</id><yt:videoId>pKJDW8oOXuU</yt:videoId><title>What stinks in Yellowstone?</title>` +
    `<link rel="alternate" href="https://www.youtube.com/watch?v=pKJDW8oOXuU"/><published>2026-10-01T21:17:46+00:00</published>` +
    `<updated>2026-10-02T00:52:22+00:00</updated><author><name>USGS</name></author>` +
    `<media:group><media:title>What stinks in Yellowstone?</media:title>` +
    `<media:thumbnail url="https://i1.ytimg.com/vi/pKJDW8oOXuU/default.jpg" width="120" height="90"/>` +
    `<media:thumbnail url="https://i1.ytimg.com/vi/pKJDW8oOXuU/hqdefault.jpg" width="480" height="360"/>` +
    `<media:description>Yellowstone literally stinks! But from a volcanologist's point of view, that's a good thing.</media:description>` +
    `<media:community><media:statistics views="12345"/></media:community></media:group>` +
    `<yt:videoId>pKJDW8oOXuU</yt:videoId></entry>` +
    // 一条既有 `<summary>` 又有 `media:description` 的：feed 自己写的那句赢（这是唯一会改动既有源摘要的一行）。
    `<entry><title>With a summary too</title><link rel="alternate" href="https://example.org/v2"/><published>2026-10-02T10:00:00Z</published>` +
    `<summary>The feed's own line.</summary><media:group><media:description>The long video description.</media:description>` +
    `<media:thumbnail url="https://example.org/v2.jpg" width="320" height="180"/></media:group><yt:videoId>v2</yt:videoId></entry>` +
    // 命名空间前缀换了名字也要读得到；这一条没有 videoId，所以是一张普通配图而不是视频块。
    `<entry><title>Aliased namespace</title><link rel="alternate" href="https://example.org/v3"/><published>2026-10-03T10:00:00Z</published>` +
    `<m:group><m:description>Bound to another prefix.</m:description><m:thumbnail url="https://example.org/v3.jpg" width="640" height="360"/></m:group></entry>` +
    // 有 videoId 却没有封面：什么都不给，不给一张坏图。
    `<entry><title>No still at all</title><link rel="alternate" href="https://example.org/v4"/><published>2026-10-04T10:00:00Z</published>` +
    `<media:group><media:description>Nothing to show.</media:description></media:group><yt:videoId>v4</yt:videoId></entry></feed>`,
  // 同一段 MRSS 出现在 RSS 2.0 的 `<item>` 里（无 enclosure、无 content）：两种方言必须同一种意思，
  // 否则"视频源"只是被序列化格式碰巧支持。
  "/video-rss2.xml": () =>
    `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel><title>Channel</title>` +
    `<item><title>An item with only media parts</title><link>https://example.org/rss2-video</link>` +
    `<pubDate>Thu, 01 Oct 2026 21:17:46 +0000</pubDate>` +
    `<media:group><media:description>Described by the media namespace only.</media:description>` +
    `<media:thumbnail url="https://example.org/rss2.jpg" width="480" height="360"/></media:group>` +
    `<guid isPermaLink="false">rss2-video</guid></item></channel></rss>`,
  // A list API that gives calendar days as yyyymmdd.
  "/days.json": () => JSON.stringify({ data: { list: [{ seq: 695, ttl: "MCFlow", day: "20260922" }, { seq: 1, ttl: "Bad day", day: "20260230" }] } }),
  // Google Developers Blog: no date in the feed or in meta tags, only in JSON-LD.
  "/ld-post": () =>
    `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Blog"},` +
    `{"@type":"BlogPosting","headline":"Turn REST APIs into MCP tools","datePublished":"2026-09-24"}]}</script></head><body><p>Post</p></body></html>`,
  "/cdn/static/js/lib-react.a6be410a.js": () => '"use strict";(self.webpackChunk=self.webpackChunk||[]).push([["lib-react"],{}]);',
  "/cdn/static/js/index.c5195ace.js": (cdn) =>
    '(()=>{var e={},a={};function t(d){return a[d]}t.u=e=>"static/js/async/"+e+"."+({6159:"4efb0769",7298:"a1b2c3d4",8557:"2d420be2"})[e]+".js",' +
    `t.miniCssF=e=>""+e+".css",t.p="${cdn}",t.rv=()=>"1.3.12"})();`,
  "/cdn/static/js/4752.2908c99e.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["4752"],{1:function(e,a,t){let r=[{path:"/",element:o.createElement(S),filePath:"en/index.mdx",' +
    'preload:async()=>(await S.preload(),Promise.all([t.e("7298"),t.e("6159"),t.e("8557")]).then(t.bind(t,57573))),lang:"en",version:""},' +
    '{path:"/blog/mimo-v2-6-tool-call-repetition",element:o.createElement(k),filePath:"en/blog/mimo-v2-6-tool-call-repetition.mdx",' +
    'preload:async()=>(await k.preload(),Promise.all([t.e("7298"),t.e("3583"),t.e("8421")]).then(t.bind(t,1105))),lang:"en",version:""}]}}]);',
  "/cdn/static/js/async/7298.a1b2c3d4.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["7298"],{2:function(){}}]);',
  "/cdn/static/js/async/6159.4efb0769.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["6159"],{3:function(e,i,t){t.d(i,{H:()=>n})}}]);',
  "/cdn/static/js/async/8557.2d420be2.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["8557"],{57573:function(e,i,t){function h(e){return(0,n.jsxs)(a.Me,{children:[' +
    '(0,n.jsx)(m.H,{models:[{name:"Xiaomi MiMo-V2.6-Series",desc:"Frontier intelligence, all the modalities, built in public.",imageKey:"mimo-v2-5-pro",link:"/mimo-v2-6"}]}),' +
    '(0,n.jsx)(d.z,{sectionTitle:"Build with MiMo",experiences:[{title:"MiMo Gallery",link:"/mimo-gallery/",desc:"Step into the world created by MiMo-V2.6"}]}),' +
    '(0,n.jsx)(r.K,{sectionId:"paper",sectionTitle:"Paper",blogs:l.G.slice().reverse().map(e=>({title:e.title,link:`/paper/${e.slug}`,desc:(0,l.V)(e.date,!1)}))}),' +
    '(0,n.jsx)(r.K,{sectionTitle:"Blog",initialVisibleCount:8,blogs:[' +
    '{title:"Diagnosing and Mitigating Tool-Call Repetition in MiMo-V2.6",link:"/blog/mimo-v2-6-tool-call-repetition",desc:"A lesson from scaling RL: the reward blind spot in optimizing for correctness."},' +
    '{title:"Introducing MiMo-V2.6 series",link:"/mimo-v2-6",desc:"Frontier intelligence, all the modalities, built in public."},' +
    '{title:"How Xiaomi MiMo-V2.6-Pro Boosts Productivity in New Materials R\\u0026D",link:"/blog/mimo-v2-6-material-research",desc:"From literature review to \\"dry-lab\\" experiments."},' +
    '{title:"Xiaomi MiMo-V2.5-Pro",link:"/mimo-v2-5-pro/index.html",desc:"A leap in agentic and long horizon coherence."},' +
    '{title:"MiMo Humanities and Social Sciences Capability Assessment",link:"/blog/mimo-v2-flash-hss",desc:"MiMo Humanities and Social Sciences Capability Assessment"}]}),' +
    '(0,n.jsx)(c.Q,{sectionTitle:"Join Us",positions:[{title:"Research Scientist - Pre-training",link:"joinUs/pre-training"}],contactEmail:"mimo@xiaomi.com"})]})}}}]);',
};
const READER_UA = "GeoHotTestReader/1.0";
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  // The gated feed stands in for a publisher that checks the client: 403 for anyone else.
  if (path === "/reader.xml") {
    const allowed = req.headers["user-agent"] === READER_UA;
    res.writeHead(allowed ? 200 : 403, { "content-type": "application/rss+xml; charset=utf-8" });
    res.end(allowed ? pages[path]!("") : "");
    return;
  }
  const found = Object.hasOwn(pages, path);
  res.writeHead(found ? 200 : 404, { "content-type": path.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8" });
  res.end(found ? pages[path]!(`${site}/cdn/`) : "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("Jina card links become posts with their own titles", () => {
  const md = [
    "[Skip to main content](http://example.org/blog/#main)",
    "[![Image 1: hero](https://cdn.example.org/a.jpg) ##### 智元发布GE-Act 2.0 新闻资讯 | 2026-09-20](https://example.org/blog/220.html \"智元发布GE-Act 2.0\")",
    "[![Image 2](https://cdn.example.org/b.png) ##### 小米18 Pro Max 测评 尾巴视频](http://example.org/blog/784.html)",
    "[![Image 3](https://cdn.example.org/c.png)](https://example.org/blog/carousel.html)",
    "# [Introducing v6](http://example.org/blog/introducing-v6)",
    "[2026](http://example.org/blog/2026) [Algorithms & Theory](http://example.org/blog/label/algorithms) [Next page](http://example.org/blog/page/2)",
  ].join("\n\n");
  const out = fromMarkdown(md, "https://example.org", source({ url: "https://r.jina.ai/http://example.org/blog/", allowUrlPrefixes: ["https://example.org/blog/"] }));
  assert.deepEqual(out, [
    { url: "https://example.org/blog/220.html", title: "智元发布GE-Act 2.0" },
    { url: "https://example.org/blog/784.html", title: "小米18 Pro Max 测评 尾巴视频" },
    { url: "https://example.org/blog/introducing-v6", title: "Introducing v6" },
  ]);
});

test("anchors into the listing page itself are navigation, not posts", () => {
  // mimo.xiaomi.com links its own sections (#paper, #blog, #join): all one address once the fragment goes.
  const html = [
    '<a href="/#paper">Paper</a>', '<a href="/#blog">Blog</a>', '<a href="https://example.org/#join">Join Us</a>',
    '<a href="/">Home</a>', '<a href="/blog/mimo-v2-6-tool-call">Diagnosing Tool-Call Repetition</a>',
  ].join("");
  const out = fromHtml(html, "https://example.org/", source({ url: "https://example.org/" }));
  assert.deepEqual(out.map((c) => c.url), ["https://example.org/blog/mimo-v2-6-tool-call"]);
});

test("promotions a feed rotates inside its posts are left out of the body", () => {
  // Microsoft Research's feed puts a different podcast or product promotion into each post on every load.
  const promo = (label: string, name: string) =>
    `<div class="border-bottom border-top mt-5 mb-5 msr-promo text-center alignwide" data-bi-aN="promo">` +
    `<p class="msr-promo__label text-uppercase"><span>${label}</span></p><div class="row"><div class="msr-promo__content">` +
    `<h2 class="h4">${name}</h2><p>Join Microsoft researchers.</p><a href="https://example.org/podcast">Listen now</a></div></div></div>`;
  const post = (p: string) => `<p>Skala is now available in the tools scientists use.</p>${p}<p>From community release to native integration.</p>`;
  const a = sanitizeBody(post(promo("PODCAST SERIES", "Ideas")), "https://example.org/post");
  const b = sanitizeBody(post(promo("", "Foundry Labs")), "https://example.org/post");
  assert.equal(a, b, "the same post whichever promotion it carried");
  assert.ok(!/PODCAST SERIES|Ideas|Foundry Labs|Listen now/.test(a));
  assert.ok(a.includes("native integration"), "the post's own text stays");
});

test("the MiMo homepage lists its posts and model pages, not its menu", async () => {
  const out = await fetchWebList(source({ url: `${site}/`, adapter: "mimo_home" }));
  assert.deepEqual(out, [
    { url: `${site}/blog/mimo-v2-6-tool-call-repetition`, title: "Diagnosing and Mitigating Tool-Call Repetition in MiMo-V2.6", excerpt: "A lesson from scaling RL: the reward blind spot in optimizing for correctness." },
    { url: `${site}/mimo-v2-6`, title: "Introducing MiMo-V2.6 series", excerpt: "Frontier intelligence, all the modalities, built in public." },
    { url: `${site}/blog/mimo-v2-6-material-research`, title: "How Xiaomi MiMo-V2.6-Pro Boosts Productivity in New Materials R&D", excerpt: 'From literature review to "dry-lab" experiments.' },
    { url: `${site}/mimo-v2-5-pro/index.html`, title: "Xiaomi MiMo-V2.5-Pro", excerpt: "A leap in agentic and long horizon coherence." },
    { url: `${site}/blog/mimo-v2-flash-hss`, title: "MiMo Humanities and Social Sciences Capability Assessment", excerpt: null },
  ]);
});

test("a MiMo homepage without the list fails the fetch instead of listing its menu", async () => {
  await assert.rejects(fetchWebList(source({ url: `${site}/redesigned/`, adapter: "mimo_home" })), /mimo_home/);
});

test("config entries a source kind does not implement are named, not ignored", () => {
  // Configs naming adapters or rules a collector does not implement used to fall back to the generic parse.
  assert.deepEqual(
    unsupportedConfig("web_list", { url: "https://example.org/", adapter: "site_cards", detail: { maxFetches: 5, titleFoo: "h1" }, contentPublic: false }),
    ["adapter=site_cards", "detail.titleFoo", "contentPublic"],
  );
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.org/feed", denyUrlPrefixes: ["https://example.org/business/"] }), []);
  assert.deepEqual(unsupportedConfig("x_search", { query: "from:a", allowUrlPrefixes: ["https://example.org/"] }), ["allowUrlPrefixes"], "X shards apply no URL rules");
});

test("a listing that links other articles in its teasers takes only the links that begin a line", () => {
  // A news brief through Jina: each headline stands on its own line; its teaser links older stories inline.
  const md = [
    "### [Critics challenge the new flood map before the parliamentary hearing](https://example.org/2026-09-27/floodmap)",
    "[![Image 3: Scoop](https://example.org/a.jpg)](https://example.org/2026-09-27/gauges)",
    "[Scoop: the river gauges the agency called rebuilt are still offline](https://example.org/2026-09-27/gauges)",
    "[How the coastal survey went off the rails in 3 weeks](https://example.org/2026-09-25/survey)[![Image 12: Field team](https://example.org/b.jpg)](https://example.org/2026-09-25/survey)",
    "The survey's two tide-gauge stops were canceled Friday, capping a [chaotic three weeks](https://example.org/2026-09-15/survey-loop).",
    "**Why it matters:** sea-level data is under-funded. [Political divides](https://example.org/2026-09-24/climate-politics) can slow progress.",
    "[Go deeper (3 min. read)](https://example.org/2026-09-25/survey)",
  ].join("\n\n");
  const config = { url: "https://r.jina.ai/https://example.org/technology", allowUrlPrefixes: ["https://example.org/2"], linksStartLine: true };
  assert.deepEqual(fromMarkdown(md, "https://example.org", source(config)).map((c) => c.title), [
    "Critics challenge the new flood map before the parliamentary hearing",
    "Scoop: the river gauges the agency called rebuilt are still offline",
    "How the coastal survey went off the rails in 3 weeks",
  ]);
  assert.equal(fromMarkdown(md, "https://example.org", source({ ...config, linksStartLine: undefined })).length, 5, "without the option prose links count");
});

test("feed text that only teases the article is a summary: the page is fetched before judging", async () => {
  const read = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/verge.xml` }, participation_mode: "editorial", cursor: null } as never, { force: true });
  const [teaser, whole] = read.candidates;
  assert.equal(teaser!.bodyStatus, "pending");
  assert.equal(teaser!.bodyText, null);
  assert.equal(teaser!.excerpt, "AMD announced today that it's acquiring World Labs.");
  assert.equal(whole!.bodyStatus, "ok");
  assert.ok(whole!.bodyText!.length > 1200);
  // Discussion sources only need what the feed says.
  const signal = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/verge.xml` }, participation_mode: "hot_signal", cursor: null } as never, { force: true });
  assert.equal(signal.candidates[0]!.bodyStatus, "ok");
});

test("a video channel's feed gives a still and its description, and no page is chased for it", async () => {
  const read = await fetchRss({ id: "test-video", config: { feedUrl: `${site}/video.xml` }, participation_mode: "editorial", cursor: null } as never, { force: true });
  const c = read.candidates[0]!;
  assert.equal(c.title, "What stinks in Yellowstone?");
  assert.equal(c.url, "https://www.youtube.com/watch?v=pKJDW8oOXuU");
  assert.equal(c.excerpt, "Yellowstone literally stinks! But from a volcanologist's point of view, that's a good thing.");
  assert.deepEqual(c.media, [{ kind: "video", url: "https://www.youtube.com/watch?v=pKJDW8oOXuU", poster: "https://i1.ytimg.com/vi/pKJDW8oOXuU/hqdefault.jpg", width: 480, height: 360 }]);
  // The watch page has no article body to extract: chasing it (or paying a renderer for it) would add
  // nothing, so the item is judged on what the feed gave. `pending` + not fetchable is that state.
  assert.equal(c.bodyStatus, "pending");
  assert.equal(pageFetchable(c.url, "rss"), false);
  assert.equal(pageFetchable("https://www.cenc.ac.cn/cenc/2026-10/05/article_1.html", "rss"), true);
  // 上面那条断言用的是两张缩略图里较宽的那张（120 在前、480 在后）。其余三条各钉一条规则：
  const [, withSummary, aliased, noStill] = read.candidates;
  assert.equal(withSummary!.excerpt, "The feed's own line.", "media:description 不盖过 feed 自己写的 summary");
  assert.equal(withSummary!.media![0]!.kind, "video");
  assert.equal(withSummary!.url, "https://example.org/v2", "视频块指向条目自己的地址");
  assert.equal(aliased!.excerpt, "Bound to another prefix.", "换前缀的命名空间也要读得到");
  assert.equal(aliased!.media![0]!.kind, "image", "没有 videoId 就不是视频块");
  assert.deepEqual(noStill!.media, [], "有 videoId 但没封面时什么都不给，不给一张坏图");
  assert.equal(noStill!.excerpt, "Nothing to show.");
  const rss2 = await fetchRss({ id: "test-video-2", config: { feedUrl: `${site}/video-rss2.xml` }, participation_mode: "editorial", cursor: null } as never, { force: true });
  assert.equal(rss2.candidates[0]!.excerpt, "Described by the media namespace only.", "RSS 2.0 也读 media:description");
  assert.deepEqual(rss2.candidates[0]!.media, [{ kind: "image", url: "https://example.org/rss2.jpg", poster: null, width: 480, height: 360 }], "两种方言同一语义");
});

test("a feed that only answers a reader-like client is fetched with that source's own headers", async () => {
  const gated = { id: "test-gated", config: { feedUrl: `${site}/reader.xml` }, participation_mode: "editorial", cursor: null } as never;
  await assert.rejects(() => fetchRss(gated, { force: true }), /HTTP 403/);
  const read = await fetchRss({
    id: "test-gated", participation_mode: "editorial", cursor: null,
    config: { feedUrl: `${site}/reader.xml`, headers: { "user-agent": READER_UA } },
  } as never, { force: true });
  assert.equal(read.candidates[0]!.title, "Only readers see this");
  // Whitelisting is half the fix: seed and the admin both refuse a config key they do not know.
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.org/feed", headers: { "user-agent": "x" } }), []);
});

test("hidden page parts are dropped whole, and a news page's closing blocks are trimmed", () => {
  // microsoft.ai posts carry <template> blocks of base64 that became 330,000 characters of "body".
  const html = sanitizeBody(
    `<p>MAI-Transcribe-2 is our most capable transcription model.</p><template><div><p>${"QUFB".repeat(500)}</p></div></template>` +
      `<svg><text>chart label</text></svg><p>Energy <math><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></math> matters.</p>`,
    "https://example.org/post",
  );
  assert.ok(!/QUFB|chart label|mc\^2/.test(html), html);
  assert.ok(html.includes("most capable transcription model") && html.includes("Energy E matters"));
  // A linked chart in a paragraph of its own survives, also when a translation is cleaned again.
  const chart = '<p><a href="https://example.org/chart.png"><img src="https://example.org/chart.png" alt="B200 prices"></a></p>';
  assert.ok(sanitizeBody(sanitizeBody(`<p>Prices doubled.</p>${chart}<p> </p>`)).includes('alt="B200 prices"'));
  assert.equal(sanitizeBody("<p>Text.</p><p> <br></p><p><a href=\"https://example.org/\"></a></p>"), "<p>Text.</p>");
  // TechCrunch ends every article the same way.
  const article = "<p>MongoDB’s shares dropped by more than 17%.</p><h2>Topics</h2><p>More on the deal.</p><p>Subscribe to our plan to get the API.</p>";
  assert.equal(trimTrailingChrome(`${article}<p>Topics</p><p>Subscribe for the industry’s biggest tech news</p><h2>Latest in AI</h2>`), article);
  assert.equal(trimTrailingChrome(article), article);
});

test("noise words match whatever their case", () => {
  // 笔记本 is noise, but the lower-case exemption agent keeps a post about an Agent product.
  const source = { config: { ingestNoiseFilter: { dropMarkers: ["笔记本", "iphone"], keepIfMatches: ["agent"] } } } as never;
  const c = (title: string, excerpt: string) => ({ url: "https://example.org/a", title, excerpt }) as never;
  assert.equal(noiseFiltered(c("Manus：正组建团队开发面向国内市场的产品", "与笔记本厂商合作的 Agent 产品"), source), false);
  assert.equal(noiseFiltered(c("新款笔记本开售", "首发价 4999 元"), source), true);
  assert.equal(noiseFiltered(c("iPhone 18 开售", ""), source), true);
});

test("空白标记不等于匹配一切", () => {
  // `markerPattern("")` 走纯子串那一支，得到 `new RegExp("")`——对任何文本都是 true。于是 dropMarkers 里
  // 一个空串会丢掉整条 feed，requireTitleMarkers 里一个空串会全放行。`config-keys.ts` 只校验这四个数组的
  // 键名、不校验元素，所以这道判断必须落在 hasMarker 里（2026-10-05 补）。
  const c = (title: string) => ({ url: "https://example.org/a", title, excerpt: "" }) as never;
  const drop = { config: { ingestNoiseFilter: { dropMarkers: ["", "笔记本"] } } } as never;
  assert.equal(noiseFiltered(c("哥白尼：2026 年 8 月为有记录以来最热月份"), drop), false, "空串不得把非噪声的条目一起丢掉");
  assert.equal(noiseFiltered(c("新款笔记本开售"), drop), true, "同一条列表里的真噪声词照旧生效");
  const whitelist = { config: { ingestNoiseFilter: { requireTitleMarkers: [""] } } } as never;
  assert.equal(noiseFiltered(c("高校人事任免通知"), whitelist), true, "白名单里只有一个空串＝没有白名单，不能变成全放行");
});

test("a title whitelist keeps only what it names, and beats a drop marker", () => {
  // 标题白名单机制的样本（2026-10-03 为研招网政策栏目定的口径；那个板块 2026-10-09 已删，机制与这条样本留着）。
  const source = {
    config: {
      ingestNoiseFilter: {
        requireTitleMarkers: ["专业目录", "分数线", "管理规定"],
        dropMarkersTitleOnly: ["MBA", "MPA"],
      },
    },
  } as never;
  const c = (title: string) => ({ url: "https://example.org/a", title, excerpt: "" }) as never;
  assert.equal(noiseFiltered(c("教育部关于印发《2027年全国硕士研究生招生工作管理规定》的通知"), source), false);
  assert.equal(noiseFiltered(c("某高校新增博士点：地理学一级学科专业目录调整"), source), false);
  assert.equal(noiseFiltered(c("高校人事任免通知"), source), true, "白名单没命中就是噪声");
  // 白名单是前置条件，不是豁免：命中白名单但命中丢弃表的（例如借「专业目录」讲 MBA 招生）照旧丢弃。
  assert.equal(noiseFiltered(c("MBA 专业目录与分数线说明会"), source), true);
});

test("without a whitelist the old behaviour is unchanged", () => {
  const source = { config: { ingestNoiseFilter: { dropMarkersTitleOnly: ["招生"] } } } as never;
  const c = (title: string) => ({ url: "https://example.org/a", title, excerpt: "" }) as never;
  assert.equal(noiseFiltered(c("某校招生公告"), source), true);
  assert.equal(noiseFiltered(c("某地暴雨预警"), source), false);
});

test("dates in yyyymmdd and in JSON-LD are read", async () => {
  const days = await fetchJsonList({ id: "test-json", config: { url: `${site}/days.json`, itemsPath: "data.list", titlePaths: ["ttl"], urlTemplate: "https://example.org/blog/view?seq={seq}", publishedAtPath: "day", publishedAtUnit: "yyyymmdd" } } as never);
  assert.deepEqual(days.map((c) => c.publishedAt?.toISOString() ?? null), ["2026-09-22T00:00:00.000Z", null], "February 30 is no date");
  const got = await fetchDetail(`${site}/ld-post`, { id: "test-feed", config: { detail: { maxFetches: 20 } } } as never, { date: true, title: false, summary: false, body: false });
  assert.equal(got.publishedAt?.toISOString(), "2026-09-24T00:00:00.000Z");
});
