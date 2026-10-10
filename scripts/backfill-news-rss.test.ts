import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { config as runtime } from "../packages/backend/src/config.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";
import { fetchArchiveSource, run, options, pages, type ArchiveRule, type Options, type State } from "./backfill-news.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";

const source: SourceRow = { id: "rss-test", name: "RSS", kind: "rss", config: {}, tier: "T2", first_party: true,
  participation_mode: "editorial", interval_minutes: 240, enabled: true, cursor: null, fail_count: 0 };
const o: Options = { from: "2026-01-01", to: "2026-02-28", sources: [], maxPages: 4, maxItems: 20, sleepMs: 0, apply: true, state: ".data/rss-test.json" };
const item = (url: string, date?: string) => `<item><title>Mapping update</title><link>${url.replaceAll("&", "&amp;")}</link>${date ? `<pubDate>${date}</pubDate>` : ""}<description>Feed teaser only</description></item>`;
const xml = (...items: string[]) => `<rss version="2.0"><channel><title>Archive</title>${items.join("")}</channel></rss>`;
const jan = "Fri, 02 Jan 2026 23:00:00 -0800";
const old = "Mon, 01 Dec 2025 12:00:00 +0000";

async function withFeed(replies: Array<string | number>, check: (rule: ArchiveRule, requests: string[]) => Promise<void>) {
  const requests: string[] = [];
  const savedPrivate = runtime.allowPrivateNetworkFetch, savedProxy = runtime.egressProxyUrl;
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    assert.equal(req.headers["if-none-match"], undefined, "archive reads must not reuse live-feed validators");
    assert.equal(req.headers["if-modified-since"], undefined);
    const page = Number(new URL(req.url!, "http://localhost").searchParams.get("paged"));
    const reply = replies[page - 1] ?? 503;
    res.writeHead(typeof reply === "number" ? reply : 200, { "content-type": "application/rss+xml" });
    res.end(typeof reply === "number" ? "Archive unavailable" : reply);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  runtime.allowPrivateNetworkFetch = true; runtime.egressProxyUrl = null;
  try {
    const address = server.address() as { port: number };
    await check({ sourceId: source.id, format: "rss", mode: "pages", firstPage: 1,
      urlTemplate: `http://127.0.0.1:${address.port}/feed/?paged={page}`, config: {} }, requests);
  } finally {
    runtime.allowPrivateNetworkFetch = savedPrivate; runtime.egressProxyUrl = savedProxy;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
function memory(state: State = { version: 1, completed: [] }) {
  const stored: Array<{ url: string; publishedAt?: Date | null; bodyText?: string | null; excerpt?: string | null }> = [];
  const queued: string[] = [];
  return { state, stored, queued, deps: { fetch: fetchArchiveSource,
    store: async (m: (typeof stored)[number]) => { stored.push(m); return { articleId: m.url, created: true, revised: false, backfill: true }; },
    queue: async (id: string) => { queued.push(id); return "job"; }, checkpoint: async () => {} } };
}

test("only verified ITDP RSS archive is added and HTML keeps its default dispatch", async () => {
  const rules: ArchiveRule[] = JSON.parse(await readFile(new URL("../industry/news-archives.json", import.meta.url), "utf8")).archives;
  assert.deepEqual(rules.filter(r => r.format === "rss").map(r => r.sourceId), ["rss-itdp-news"]);
  const itdp = rules.find(r => r.sourceId === "rss-itdp-news")!;
  assert.deepEqual(pages(itdp, { ...o, maxPages: 2 }), ["https://www.itdp.org/feed/?paged=1", "https://www.itdp.org/feed/?paged=2"]);
  const html = rules.find(r => r.sourceId === "web-wmo-news")!;
  let received: SourceRow | undefined;
  await run({ ...o, apply: false, maxPages: 1 }, [html], [{ ...source, id: html.sourceId, kind: "web_list" }], {
    fetch: async s => { received = s; return [{ url: "https://example.org/old", title: "Old", publishedAt: new Date("2025-12-01") }]; },
  });
  assert.equal(received!.kind, "web_list"); assert.equal(received!.config.url, "https://wmo.int/news?page=0");
});

test("RSS dates retain timezone, canonical duplicates do not spend item cap, fully old nonempty page establishes boundary", async () => {
  await withFeed([xml(item("https://www.example.org/story/?utm_source=rss", jan), item("https://example.org/story", jan)),
    xml(item("https://example.org/old", old))], async (rule, requests) => {
    const feedUrl = rule.urlTemplate.replace("{page}", "1");
    const cachedSource = { ...source, cursor: { rss: { configHash: sha256(stableJson({ feedUrl })),
      responseUrl: feedUrl, etag: '"old-live-etag"', lastModified: "Fri, 02 Jan 2026 00:00:00 GMT" } } };
    const m = memory(); const result = await run(o, [rule], [cachedSource], m.deps, m.state);
    assert.equal(result.errors, 0); assert.equal(result.pages, 2); assert.equal(result.eligible, 1);
    assert.equal(result.limited, false); assert.equal(result.boundaries.length, 1);
    assert.deepEqual(requests, ["/feed/?paged=1", "/feed/?paged=2"]);
    assert.equal(m.stored[0]!.publishedAt!.toISOString(), "2026-01-03T07:00:00.000Z");
    assert.equal(m.stored[0]!.bodyText, undefined); assert.equal(m.stored[0]!.excerpt, undefined);
    assert.equal(m.queued.length, 1);
  });
});

test("HTTP failure and empty RSS never complete a page or establish older coverage", async () => {
  for (const response of [503, xml()]) await withFeed([response], async (rule) => {
    const m = memory(); const result = await run(o, [rule], [source], m.deps, m.state);
    assert.equal(result.errors, 1); assert.deepEqual(result.boundaries, []); assert.deepEqual(m.state.completed, []);
    assert.equal(m.stored.length, 0); assert.equal(m.state.boundaries, undefined);
  });
});

test("RSS archives retain registered allow and deny filters before canonical storage or queueing", async () => {
  await withFeed([xml(item("https://itdp.org/story", jan), item("https://www.itdp.org/denied/story", jan),
    item("https://outside.example.org/story", jan), item("https://itdp.org.evil.invalid/story", jan)),
    xml(item("https://itdp.org/old", old))], async rule => {
    const registered = { ...source, config: { allowUrlPrefixes: ["https://itdp.org/", "https://www.itdp.org/"],
      denyUrlPrefixes: ["https://www.itdp.org/denied/"] } };
    const m = memory(); const result = await run(o, [rule], [registered], m.deps, m.state);
    assert.equal(result.errors, 0); assert.equal(result.eligible, 1);
    assert.deepEqual(m.stored.map(v => v.url), ["https://itdp.org/story"]);
    assert.deepEqual(m.queued, ["https://itdp.org/story"]);
    assert.equal(result.boundaries.length, 1);
  });
});

test("an undated RSS record stays unknown and cannot turn a mixed older page into a boundary", async () => {
  await withFeed([xml(item("https://example.org/unknown"), item("https://example.org/old", old))], async rule => {
    const m = memory(); const result = await run({ ...o, maxPages: 1 }, [rule], [source], m.deps, m.state);
    assert.equal(result.undated, 1); assert.equal(result.limited, true); assert.equal(result.errors, 0);
    assert.deepEqual(m.state.completed, []); assert.deepEqual(result.boundaries, []); assert.equal(m.stored.length, 0);
  });
});

test("canonical repeated RSS pages stop as coverage unknown rather than success", async () => {
  await withFeed([xml(item("https://www.example.org/story/?utm_source=first", jan)), xml(item("https://example.org/story", jan))], async rule => {
    const m = memory(); const result = await run(o, [rule], [source], m.deps, m.state);
    assert.equal(result.pages, 2); assert.equal(result.limited, true); assert.equal(result.eligible, 1);
    assert.equal(m.state.completed.length, 1); assert.deepEqual(result.boundaries, []);
  });
});

test("RSS page and item caps remain bounded; partial canonical acknowledgements resume without repeated writes", async () => {
  await withFeed([xml(item("https://www.example.org/a/?utm_source=one", jan), item("https://example.org/b", jan))], async (rule, requests) => {
    const m = memory(); const capped = { ...o, maxPages: 1, maxItems: 1 };
    const first = await run(capped, [rule], [source], m.deps, m.state);
    assert.equal(first.limited, true); assert.equal(m.state.completed.length, 0);
    const second = await run(capped, [rule], [source], m.deps, m.state);
    assert.equal(second.eligible, 1); assert.equal(m.stored.length, 2); assert.equal(m.queued.length, 2);
    assert.equal(requests.length, 2); assert.deepEqual(m.state.partial, {});
  });
});

test("RSS range follows publisher instant in Beijing days and rejects invalid range or wrong source kind", async () => {
  assert.throws(() => options(["--from=2026-02-01", "--to=2026-01-01"]));
  await withFeed([xml(item("https://example.org/jan3", jan))], async rule => {
    const m = memory(); const result = await run({ ...o, to: "2026-01-02", maxPages: 1 }, [rule], [source], m.deps, m.state);
    assert.equal(result.eligible, 0); assert.equal(m.stored.length, 0);
    await assert.rejects(() => run(o, [rule], [{ ...source, kind: "web_list" }], m.deps), /registered RSS source/);
  });
});

test("RSS saved older boundary is reread and a wider date range cannot reuse that stopping point", async () => {
  await withFeed([xml(item("https://example.org/new", jan)), xml(item("https://example.org/old", old)),
    xml(item("https://example.org/older", "Sat, 01 Nov 2025 12:00:00 +0000"))], async (rule, requests) => {
    const m = memory(); await run(o, [rule], [source], m.deps, m.state);
    const again = await run(o, [rule], [source], m.deps, m.state);
    assert.equal(again.boundaries[0]!.reused, true);
    assert.deepEqual(requests, ["/feed/?paged=1", "/feed/?paged=2", "/feed/?paged=2"]);
    const wider = await run({ ...o, from: "2025-12-01" }, [rule], [source], m.deps, m.state);
    assert.equal(wider.eligible, 2); assert.match(wider.boundaries[0]!.url, /paged=3$/);
    assert.equal(Object.keys(m.state.boundaries!).length, 2);
  });
});
