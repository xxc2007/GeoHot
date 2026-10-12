// months-mode within-month pagination for the news backfill (scripts/backfill-news.ts). Pure
// dependency injection like scripts/backfill-news.test.ts: the fetch/store/queue/checkpoint
// dependencies are stubbed, so nothing here touches the network or a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type ArchiveRule, type Dependencies, type Options, type State } from "../scripts/backfill-news.ts";
import { FetchError, type Candidate, type SourceRow } from "../packages/backend/src/sources/types.ts";

const source: SourceRow = { id: "loc", name: "LOC Worlds Revealed", kind: "web_list", config: {}, tier: "T1", participation_mode: "editorial", first_party: true, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
const rule: ArchiveRule = { sourceId: "loc", mode: "months", urlTemplate: "https://example.com/maps/{month}/",
  monthPageUrlTemplate: "https://example.com/maps/{month}/page/{page}/", config: {} };
const o: Options = { from: "2026-01-01", to: "2026-02-28", sources: [], maxPages: 10, maxItems: 100, sleepMs: 0, apply: true, state: ".data/state.json" };
const jan1 = "https://example.com/maps/2026/01/", jan2 = "https://example.com/maps/2026/01/page/2/", jan3 = "https://example.com/maps/2026/01/page/3/";
const feb1 = "https://example.com/maps/2026/02/", feb2 = "https://example.com/maps/2026/02/page/2/";
const listing = (month: string, days: number[]): Candidate[] => days.map(d => ({
  url: `https://example.com/maps/${month.replace("-", "/")}/post-${d}`,
  title: `Post ${month}-${d}`,
  publishedAt: new Date(`${month}-${String(d).padStart(2, "0")}T12:00:00+08:00`),
}));

function harness(fetch: (url: string) => Promise<Candidate[]>) {
  const state: State = { version: 1, completed: [] };
  const requested: string[] = [];
  let checkpoints = 0;
  const deps: Dependencies = {
    fetch: async s => { const url = String(s.config.url); requested.push(url); return fetch(url); },
    store: async () => ({ articleId: "a", created: true, revised: false, backfill: true }),
    queue: async () => "job", checkpoint: async () => { checkpoints++; },
  };
  return { state, requested, checkpoints: () => checkpoints, deps };
}

test("full month pages continue within the month until a 404 ends it without an error", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2, jan3]);
  assert.equal(stats.pages, 2); // only really fetched continuation pages count
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 20); assert.equal(stats.limited, false);
  assert.deepEqual(stats.boundaries, []); assert.equal(h.state.boundaries, undefined);
  const prefix = `${o.from}:2026-01-31:loc:`;
  assert.deepEqual(h.state.completed, [`${prefix}${jan1}`, `${prefix}${jan2}`]);
  assert.equal(h.checkpoints(), 22); // 10 items + 1 page per read page; the 404 page stays pending
});

test("a half-full continuation page ends the month and the next month is still walked", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [11, 12, 13]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [1]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run(o, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2, feb1, feb2]); // jan3 never requested
  assert.equal(stats.errors, 0); assert.equal(stats.limited, false); assert.equal(stats.eligible, 14);
});

test("a fully older month page builds a boundary but only ends its own month", async () => {
  const mid = { ...o, from: "2026-01-15" };
  const fetch = (url: string): Promise<Candidate[]> => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [20]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [5]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [5]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  };
  const h = harness(fetch);
  const first = await run(mid, [rule], [source], h.deps, h.state);
  const prefix = `${mid.from}:${mid.to}:loc:`;
  assert.equal(first.errors, 0);
  assert.equal(first.boundaries.length, 1);
  assert.equal(h.state.boundaries![prefix]!.url, jan2);
  assert.ok(h.requested.includes(feb1)); // the boundary ends the month, not the whole months walk
  h.requested.length = 0;
  const second = await run(mid, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan2, feb2]); // completed months stay skipped; their next page is re-checked
  assert.deepEqual(second.boundaries, [{ source: "loc", url: jan2, reused: true }]);
  assert.equal(second.errors, 0);
});

test("a months rule without monthPageUrlTemplate keeps exactly one fetch per month", async () => {
  const plain: ArchiveRule = { sourceId: "loc", mode: "months", urlTemplate: "https://example.com/maps/{month}/", config: {} };
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [1]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run(o, [plain], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, feb1]); // no continuation attempt at all
  assert.equal(stats.errors, 0); assert.deepEqual(stats.boundaries, []);
});

test("an empty continuation page ends the month without an error or a completion", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3]));
    if (url === jan2) return Promise.resolve([]);
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2]);
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 3);
  assert.deepEqual(h.state.completed, [`${o.from}:2026-01-31:loc:${jan1}`]); // the empty page stays pending
});

test("an unparseable continuation page ends the month without an error", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3]));
    return Promise.reject(new FetchError("no items matched (html)"));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2]);
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 3);
  assert.deepEqual(h.state.completed, [`${o.from}:2026-01-31:loc:${jan1}`]);
});

test("monthPageUrlTemplate requires months mode and both placeholders, before any fetch", async () => {
  let fetches = 0;
  const deps: Dependencies = { fetch: async () => { fetches++; return []; } };
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, mode: "pages" }], [source], deps), /Month pagination/);
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, monthPageUrlTemplate: "https://example.com/{month}/" }], [source], deps), /Month pagination/);
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, monthPageUrlTemplate: "https://example.com/{page}/" }], [source], deps), /Month pagination/);
  assert.equal(fetches, 0);
});
