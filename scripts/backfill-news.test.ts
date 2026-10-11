import { test } from "node:test";
import assert from "node:assert/strict";
import { material, options, pages, run, strictDay, type ArchiveRule, type Options, type State } from "./backfill-news.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";
const source: SourceRow = { id: "news", name: "News", kind: "web_list", config: {}, tier: "T1", participation_mode: "editorial", first_party: true, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
const rule: ArchiveRule = { sourceId: "news", mode: "pages", urlTemplate: "https://example.com/?page={page}", firstPage: 0, config: {} };
const config: Options = { from: "2026-01-01", to: "2026-02-28", sources: [], maxPages: 3, maxItems: 20, sleepMs: 0, apply: false, state: ".data/state.json" };
test("strict calendar dates and explicit apply database acknowledgement", () => {
  assert.throws(() => strictDay("2026-02-29"));
  assert.throws(() => strictDay("2026-1-01"));
  assert.throws(() => options(["--apply"]));
  assert.throws(() => options(["--max-items=-1"]));
  assert.equal(options(["--apply", "--database-url-env=DATABASE_URL"]).apply, true);
});
test("month URLs include both requested boundaries", () => {
  assert.deepEqual(pages({ ...rule, mode: "months", urlTemplate: "https://example.com/{month}/" }, config), ["https://example.com/2026/01/", "https://example.com/2026/02/"]);
});
test("materials keep publisher date and do not send body or excerpt", () => {
  const publishedAt = new Date("2026-01-04T00:00:00Z"), discoveredAt = new Date("2026-10-10T00:00:00Z");
  const m = material({ url: "https://example.com/story", title: "A story", publishedAt, bodyText: "Short teaser", excerpt: "Teaser" }, "news", discoveredAt)!;
  assert.equal(m.publishedAt, publishedAt); assert.equal(m.discoveredAt, discoveredAt);
  assert.equal(m.backfill, "archive"); assert.equal(m.via, "import"); assert.equal(m.bodyStatus, "pending");
  assert.equal(m.bodyText, undefined); assert.equal(m.excerpt, undefined);
  assert.equal(material({ url: "https://example.com/unknown", title: "Unknown" }, "news", discoveredAt), null);
});
test("dry-run skips missing dates and duplicates, never writes or queues", async () => {
  let writes = 0;
  const stats = await run(config, [rule], [source], { fetch: async () => [
    { url: "https://example.com/a", title: "A", publishedAt: new Date("2026-01-15") },
    { url: "https://example.com/b", title: "B" },
    { url: "https://example.com/c", title: "C", publishedAt: new Date("2025-12-01") },
  ], store: async () => { writes++; throw Error("must not write"); }, queue: async () => { writes++; }, checkpoint: async () => { writes++; } });
  assert.equal(writes, 0); assert.equal(stats.eligible, 1); assert.equal(stats.undated, 1);
  assert.equal(stats.pages, 2); // Second identical page stops the walk.
});
test("failed enqueue does not checkpoint; retry can repair an inserted duplicate", async () => {
  const state = { version: 1 as const, completed: [] as string[] };
  const o = { ...config, apply: true, maxPages: 1 };
  const fetch = async () => [{ url: "https://example.com/a", title: "A", publishedAt: new Date("2026-01-15") }];
  const store = async () => ({ articleId: "a", created: false, revised: false, backfill: true });
  let checkpoints = 0;
  const failed = await run(o, [rule], [source], { fetch, store, queue: async () => { throw Error("queue unavailable"); }, checkpoint: async () => { checkpoints++; } }, state);
  assert.equal(failed.errors, 1); assert.equal(checkpoints, 0); assert.equal(state.completed.length, 0);
  const fixed = await run(o, [rule], [source], { fetch, store, queue: async () => "job", checkpoint: async () => { checkpoints++; } }, state);
  assert.equal(fixed.queued, 1); assert.equal(checkpoints, 2); assert.equal(state.completed.length, 1);
});

test("a bounded partial page advances across runs using successful URL acknowledgements", async () => {
  const state = { version: 1 as const, completed: [] as string[], partial: {} as Record<string, string[]> };
  const stored: string[] = [], queued: string[] = [];
  const deps = {
    fetch: async () => ["a", "b"].map(id => ({ url: `https://example.com/${id}`, title: id, publishedAt: new Date("2026-01-15") })),
    store: async (m: { url: string }) => { stored.push(m.url); return { articleId: m.url, created: true, revised: false, backfill: true }; },
    queue: async (id: string) => { queued.push(id); return "job"; }, checkpoint: async () => {},
  };
  const o = { ...config, apply: true, maxPages: 1, maxItems: 1 };
  const first = await run(o, [rule], [source], deps, state);
  assert.equal(first.limited, true); assert.equal(state.completed.length, 0);
  const second = await run(o, [rule], [source], deps, state);
  assert.equal(second.eligible, 1); assert.equal(state.completed.length, 1);
  assert.deepEqual(stored, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(queued, stored); assert.deepEqual(state.partial, {});
});

test("queue failure never marks a URL successful; resumed page repairs it", async () => {
  const state = { version: 1 as const, completed: [] as string[], partial: {} as Record<string, string[]> };
  let fail = true;
  const queued: string[] = [];
  const deps = {
    fetch: async () => ["a", "b"].map(id => ({ url: `https://example.com/${id}`, title: id, publishedAt: new Date("2026-01-15") })),
    store: async (m: { url: string }) => ({ articleId: m.url, created: false, revised: false, backfill: true }),
    queue: async (id: string) => { if (id.endsWith("/b") && fail) throw Error("queue unavailable"); queued.push(id); return "job"; },
    checkpoint: async () => {},
  };
  const o = { ...config, apply: true, maxPages: 1 };
  assert.equal((await run(o, [rule], [source], deps, state)).errors, 1);
  assert.deepEqual(Object.values(state.partial), [["https://example.com/a"]]);
  fail = false;
  assert.equal((await run(o, [rule], [source], deps, state)).errors, 0);
  assert.deepEqual(queued, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(state.completed.length, 1);
});

test("disabled and non-editorial sources are refused before fetching", async () => {
  let fetches = 0;
  for (const disabled of [{ ...source, enabled: false }, { ...source, participation_mode: "isolated" as const }]) {
    await assert.rejects(run({ ...config, sources: [source.id] }, [rule], [disabled], { fetch: async () => { fetches++; return []; } }), /not enabled for editorial/);
    assert.equal((await run(config, [rule], [disabled], { fetch: async () => { fetches++; return []; } })).pages, 0);
  }
  assert.equal(fetches, 0);
});

test("an open monthly listing reopens legacy completed state and is observed again", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const monthly = { ...rule, mode: "months" as const, urlTemplate: "https://example.com/{month}/" };
  const o = { ...config, from: `${today.slice(0, 7)}-01`, to: today, apply: true, maxPages: 1 };
  const url = pages(monthly, o)[0]!;
  const key = `${o.from}:${o.to}:${source.id}:${url}`;
  const state = { version: 1 as const, completed: [key] };
  let fetches = 0;
  const deps = { fetch: async () => { fetches++; return [{ url: "https://example.com/today", title: "Today", publishedAt: new Date(`${today}T00:00:00+08:00`) }]; },
    store: async () => ({ articleId: "today", created: false, revised: false, backfill: true }), queue: async () => null, checkpoint: async () => {} };
  await run(o, [monthly], [source], deps, state);
  await run(o, [monthly], [source], deps, state);
  assert.equal(fetches, 2); assert.deepEqual(state.completed, []);
});

test("unknown publisher dates leave a page observable instead of completed forever", async () => {
  const state = { version: 1 as const, completed: [] as string[] };
  let fetches = 0;
  const deps = { fetch: async () => { fetches++; return [{ url: "https://example.com/unknown", title: "Unknown" }]; },
    store: async () => { throw Error("undated material cannot be stored"); }, queue: async () => null, checkpoint: async () => {} };
  const o = { ...config, apply: true, maxPages: 1 };
  await run(o, [rule], [source], deps, state);
  await run(o, [rule], [source], deps, state);
  assert.equal(fetches, 2); assert.deepEqual(state.completed, []);
});
test("item cap leaves a partial page uncheckpointed", async () => {
  const state = { version: 1 as const, completed: [] as string[] };
  const stats = await run({ ...config, apply: true, maxItems: 1 }, [rule], [source], {
    fetch: async () => ["a", "b"].map(id => ({ url: `https://example.com/${id}`, title: id, publishedAt: new Date("2026-01-15") })),
    store: async () => ({ articleId: "a", created: true, revised: false, backfill: true }), queue: async () => "job", checkpoint: async () => {},
  }, state);
  assert.equal(stats.limited, true); assert.equal(state.completed.length, 0);
});

test("a saved older boundary is reobserved on rerun instead of crawling older pages", async () => {
  const state: State = { version: 1, completed: [] };
  const requested: string[] = [];
  const deps = {
    fetch: async (s: SourceRow) => {
      const url = String(s.config.url); requested.push(url);
      const n = Number(new URL(url).searchParams.get("page"));
      return [{ url: `https://example.com/story-${n}`, title: "Story", publishedAt: new Date(n === 0 ? "2026-01-15" : "2025-12-30") }];
    },
    store: async () => ({ articleId: "a", created: false, revised: false, backfill: true }),
    queue: async () => null, checkpoint: async () => {},
  };
  const o = { ...config, apply: true };
  assert.equal((await run(o, [rule], [source], deps, state)).boundaries.length, 1);
  requested.length = 0;
  const next = await run(o, [rule], [source], deps, state);
  assert.deepEqual(requested, ["https://example.com/?page=1"]);
  assert.deepEqual(next.boundaries, [{ source: "news", url: "https://example.com/?page=1", reused: true }]);
});

test("legacy completed frontier is reobserved to recover its missing older-boundary evidence", async () => {
  const prefix = `${config.from}:${config.to}:news:`;
  const state: State = { version: 1, completed: [0, 1].map(n => `${prefix}https://example.com/?page=${n}`) };
  const requested: string[] = [];
  const result = await run({ ...config, apply: true }, [rule], [source], {
    fetch: async s => { requested.push(String(s.config.url)); return [{ url: "https://example.com/old", title: "Old", publishedAt: new Date("2025-12-15") }]; },
    store: async () => { throw Error("no eligible stories"); }, queue: async () => null, checkpoint: async () => {},
  }, state);
  assert.deepEqual(requested, ["https://example.com/?page=1"]);
  assert.equal(result.boundaries.length, 1);
  assert.equal(state.boundaries![prefix]!.url, "https://example.com/?page=1");
});

test("shifted boundary pages continue if new in-range records have displaced the older page", async () => {
  const prefix = `${config.from}:${config.to}:news:`;
  const state: State = { version: 1, completed: [`${prefix}https://example.com/?page=0`, `${prefix}https://example.com/?page=1`],
    boundaries: { [prefix]: { url: "https://example.com/?page=1", observedAt: "2026-10-10T00:00:00Z" } } };
  const requested: number[] = [];
  const result = await run({ ...config, apply: true }, [rule], [source], {
    fetch: async s => { const n = Number(new URL(String(s.config.url)).searchParams.get("page")); requested.push(n);
      return [{ url: `https://example.com/new-${n}`, title: "Story", publishedAt: new Date(n === 1 ? "2026-01-03" : "2025-12-01") }]; },
    store: async () => ({ articleId: "a", created: true, revised: false, backfill: true }), queue: async () => null, checkpoint: async () => {},
  }, state);
  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.eligible, 1);
  assert.equal(state.boundaries![prefix]!.url, "https://example.com/?page=2");
});

test("a changed date span does not reuse an older span's completed pages or boundary", async () => {
  const prefix = `${config.from}:${config.to}:news:`;
  const state: State = { version: 1, completed: [`${prefix}https://example.com/?page=0`],
    boundaries: { [prefix]: { url: "https://example.com/?page=0", observedAt: "2026-10-10T00:00:00Z" } } };
  const requested: number[] = [];
  await run({ ...config, from: "2025-12-01", apply: true, maxPages: 2 }, [rule], [source], {
    fetch: async s => { const n = Number(new URL(String(s.config.url)).searchParams.get("page")); requested.push(n);
      return [{ url: `https://example.com/old-${n}`, title: "Story", publishedAt: new Date(n === 0 ? "2025-12-15" : "2025-11-15") }]; },
    store: async () => ({ articleId: "a", created: false, revised: false, backfill: true }), queue: async () => null, checkpoint: async () => {},
  }, state);
  assert.deepEqual(requested, [0, 1]);
  assert.equal(Object.keys(state.boundaries!).length, 2);
});

test("empty listings and mixed unknown/older dates never establish a completion boundary", async () => {
  for (const items of [[], [{ url: "https://example.com/old", title: "Old", publishedAt: new Date("2025-12-01") },
    { url: "https://example.com/unknown", title: "Unknown" }]]) {
    const state: State = { version: 1, completed: [] };
    const result = await run({ ...config, apply: true, maxPages: 1 }, [rule], [source], {
      fetch: async () => items, store: async () => { throw Error("no eligible stories"); }, queue: async () => null, checkpoint: async () => {},
    }, state);
    assert.deepEqual(result.boundaries, []);
    assert.deepEqual(state.completed, []);
    assert.equal(state.boundaries, undefined);
    assert.equal(result.errors, items.length ? 0 : 1);
  }
});
