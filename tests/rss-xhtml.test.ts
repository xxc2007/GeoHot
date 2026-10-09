// Atom XHTML constructs must keep their mixed text/element order before the usual HTML cleaning.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";
import { escapeXml } from "@aihot/backend/lib/text";

const body = `<p>Before <strong>bold</strong>, between <em>italic</em>, after.</p><p>${"A complete research article with enough text for the feed body. ".repeat(8)}</p>`;
const xhtml = (html: string) => `<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`;
const pages: Record<string, string> = {
  "/title": `<title type="xhtml">${xhtml("New <em>research</em> result")}</title><summary type="xhtml">${xhtml("First <b>important</b> result, then another.")}</summary>`,
  "/body": `<title>New result</title><content type="xhtml">${xhtml(body)}</content>`,
  "/html": `<title>New result</title><content type="html">${escapeXml(body)}</content>`,
  "/cdata": `<title>New result</title><content type="html"><![CDATA[${body}]]></content>`,
  "/unsafe": `<title>New result</title><content type="xhtml">${xhtml(`${body}<script>alert(1)</script><p><a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a> &lt;img src=x onerror=alert(1)&gt;</p>`)}</content>`,
};
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/atom+xml");
  res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:test:feed</id><title>Test</title><updated>2026-09-29T00:00:00Z</updated><author><name>Test</name></author><entry><id>urn:test:entry</id><updated>2026-09-29T00:00:00Z</updated><link href="https://example.org/article"/>${pages[req.url!]}</entry></feed>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(path: string) {
  const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
  return (await fetchRss({ config: { feedUrl }, participation_mode: "editorial" } as never)).candidates;
}

test("Atom XHTML titles and summaries keep the article and its text in order", async () => {
  const items = await read("/title");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "New research result");
  assert.equal(items[0]!.excerpt, "First important result, then another.");
});

test("Atom XHTML bodies match escaped HTML and CDATA without losing mixed-content order", async () => {
  const [item] = await read("/body");
  assert.equal(item!.bodyStatus, "ok");
  assert.match(item!.bodyHtml!, /Before <strong>bold<\/strong>, between <em>italic<\/em>, after\./);
  for (const path of ["/html", "/cdata"]) {
    const [control] = await read(path);
    assert.equal(item!.bodyHtml, control!.bodyHtml);
    assert.equal(item!.bodyText, control!.bodyText);
  }
});

test("Atom XHTML still passes through HTML sanitization without decoding escaped markup twice", async () => {
  const [item] = await read("/unsafe");
  assert.equal(item!.bodyStatus, "ok");
  assert.doesNotMatch(item!.bodyHtml!, /<script|<img|javascript:|onclick=/);
  assert.ok(item!.bodyHtml!.includes("&lt;img"), "escaped markup remains text");
});

// ---------------------------------------------------------------------------
// RSS 2.0 whose <title> holds literal markup — the shape two round-56 academic feeds turned in.
// byrd.osu.edu/rss.xml and ecmwf.int/rss.xml (both Drupal) publish `<title><a href="…">Words</a></title>`
// unescaped. That is legal XML, so the parser hands back *structure* where the reader expects a string,
// `text()` has no `#text` to return, the title comes out empty, and `collect.ts` drops the item with
// `if (!link || !title) continue`. The round then wrote health `ok` with `found: 0`: two sources that
// carried ten fresh items each looked, in the admin and in every metric, exactly like an idle feed.
// Fixture bytes are the real ones, taken from the collector on 2026-10-09.
// ---------------------------------------------------------------------------
const itemWithAnchor = (href: string, words: string, url: string, date: string) =>
  `<item>\n  <title><a href="${href}" title="${words}">${words}</a>\n</title>\n  <link>${url}</link>\n  <description>&lt;p&gt;A research summary long enough to be a body. ${words}&lt;/p&gt;</description>\n  <pubDate>${date}</pubDate>\n</item>`;
const rssPages: Record<string, string> = {
  "/anchor-title": `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0" xml:base="https://byrd.osu.edu/"><channel><title>News</title><link>https://byrd.osu.edu/</link><description/><language>en</language>`
    + itemWithAnchor("/news/remembering-peter-barrett", "Remembering Peter Barrett, Antarctic Scientist", "https://byrd.osu.edu/news/remembering-peter-barrett", "October 5, 2026")
    + itemWithAnchor("/news/ancient-ice", "Lonnie Thompson and Colleagues Confirm Ancient Ice Preserved", "https://byrd.osu.edu/news/ancient-ice", "October 1, 2026")
    + `</channel></rss>`,
  // Every item of this feed is unreadable for a reason of its own (no title at all): not one candidate
  // can come out of it, which is the moment the round must say so rather than report a healthy zero.
  "/no-titles": `<rss version="2.0"><channel><title>Headless</title><link>https://example.org/</link><item><link>https://example.org/a</link><description>only a description</description></item><item><link>https://example.org/b</link></item></channel></rss>`,
  // Wiley's table-of-contents shape: `<description>` is a volume line and the abstract sits in
  // `<dc:description>`. Reading only the first gave every Wiley source a stub the model cannot summarise.
  "/wiley-toc": `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>Antipode: Table of Contents</title><link>https://onlinelibrary.wiley.com/journal/14678330</link><item><title>Scalar Aesthetics and the Public Politics of Home</title><link>https://onlinelibrary.wiley.com/doi/10.1111/geoj.70130</link><description>Antipode, Volume 58, Issue 6, November 2026.</description><dc:description>Abs${"trac ".repeat(60)}</dc:description><pubDate>Wed, 07 Oct 2026 21:28:49 -0700</pubDate></item></channel></rss>`,
  // Unescaped markup *inside* content:encoded must not be flattened into a body that only carries the
  // first element: feedText treats a non-empty body as confirmed, which would skip the extraction fetch
  // that gets the real text. The title above still has to survive, so the two cases are the same fixture.
  "/markup-body": `<rss version="2.0"><channel><title>Mixed</title><link>https://example.org/</link><item><title>Remembering a Colleague</title><link>https://example.org/news/one</link><content:encoded><p>${"A first paragraph long enough to look like a body. ".repeat(6)}</p><p>SECOND PARAGRAPH THAT MUST NOT BE SILENTLY DROPPED</p></content:encoded><pubDate>Tue, 06 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>`,
};
const rssServer = http.createServer((req, res) => {
  res.setHeader("content-type", "application/rss+xml; charset=utf-8");
  res.end(`<?xml version="1.0" encoding="utf-8"?>${rssPages[req.url!]}`);
});
await new Promise<void>((resolve) => rssServer.listen(0, "127.0.0.1", resolve));
after(async () => {
  await new Promise<void>((resolve) => rssServer.close(() => resolve()));
});

async function readRss(path: string) {
  const feedUrl = `http://127.0.0.1:${(rssServer.address() as { port: number }).port}${path}`;
  return fetchRss({ config: { feedUrl }, participation_mode: "editorial" } as never);
}

test("an RSS 2.0 title that is literal markup yields the words, not an empty title", async () => {
  const { candidates } = await readRss("/anchor-title");
  assert.equal(candidates.length, 2, "a title the parser turned back into structure must not cost the item");
  assert.equal(candidates[0]!.title, "Remembering Peter Barrett, Antarctic Scientist");
  assert.equal(candidates[0]!.url, "https://byrd.osu.edu/news/remembering-peter-barrett");
  assert.equal(candidates[1]!.title, "Lonnie Thompson and Colleagues Confirm Ancient Ice Preserved");
  assert.doesNotMatch(candidates[0]!.title, /<|a href/, "the anchor is a rendering, not part of the headline");
});

test("a feed full of items the reader cannot use fails visibly instead of a healthy zero", async () => {
  await assert.rejects(() => readRss("/no-titles"), /2 item/, "found>0 and stored 0 has to be said out loud");
});

test("a table-of-contents feed that hides its abstract in dc:description still hands the model the abstract", async () => {
  const { candidates } = await readRss("/wiley-toc");
  const [item] = candidates;
  assert.equal(item!.url, "https://onlinelibrary.wiley.com/doi/10.1111/geoj.70130");
  assert.ok(item!.excerpt!.startsWith("Abs"), "the excerpt is the abstract, not the volume line");
  assert.ok(item!.excerpt!.length > 200, `the abstract reaches the model (${item!.excerpt!.length} chars)`);
  assert.ok(!/Volume 58, Issue 6/.test(item!.excerpt!), "the 44-character volume line is not what the model gets to work with");
});

test("markup inside content:encoded does not become a body that pretends to be complete", async () => {
  const { candidates } = await readRss("/markup-body");
  const [item] = candidates;
  assert.ok(item!.title.includes("Remembering a Colleague"), "the title still reads through the markup");
  // Flattening the element children into one string would keep the first <p>, drop the second, and mark the
  // body confirmed — so the extraction fetch that gets the real text never happens. An empty body is the
  // honest answer: it stays `pending` and the article page is read instead.
  assert.notEqual(item!.bodyStatus, "ok", "a flattened stub must not be reported as a confirmed body");
  assert.equal(item!.bodyText, null);
});
