// Reader-facing micro-cache for `/api/site/pool` (see lib/micro-cache.ts for the contract).
import assert from "node:assert/strict";
import test from "node:test";
import { MicroCache } from "../packages/backend/src/lib/micro-cache.ts";

test("inside freshMs the value is fresh; between freshMs and staleMs it is stale but served", () => {
  const cache = new MicroCache<{ n: number }>({ freshMs: 45_000, staleMs: 180_000 });
  cache.write("k", { n: 1 }, 1_000);

  const fresh = cache.read("k", 1_000 + 45_000);
  assert.deepEqual(fresh?.data, { n: 1 });
  assert.equal(fresh?.fresh, true);
  assert.equal(fresh?.stale, false);

  const stale = cache.read("k", 1_000 + 120_000);
  assert.deepEqual(stale?.data, { n: 1 });
  assert.equal(stale?.fresh, false);
  assert.equal(stale?.stale, true);

  // One millisecond past the window the entry is gone and the caller must read the database.
  assert.equal(cache.read("k", 1_000 + 180_001), null);
  assert.equal(cache.size, 0);
});

test("a missing key never returns a value", () => {
  const cache = new MicroCache<number>({ freshMs: 1, staleMs: 2 });
  assert.equal(cache.read("nope"), null);
});

test("writing again moves the key to the newest position, so eviction drops the oldest write", () => {
  const cache = new MicroCache<number>({ freshMs: 1_000, staleMs: 2_000, maxEntries: 3 });
  cache.write("a", 1, 0);
  cache.write("b", 2, 0);
  cache.write("c", 3, 0);
  cache.write("a", 4, 0); // touched again → now the newest
  cache.write("d", 5, 0); // over the cap → drops "b"
  assert.equal(cache.size, 3);
  assert.equal(cache.read("b", 0), null);
  assert.deepEqual(cache.read("a", 0)?.data, 4);
  assert.deepEqual(cache.read("d", 0)?.data, 5);
});

test("maxEntries is honoured through a long walk of distinct keys", () => {
  const cache = new MicroCache<string>({ freshMs: 1_000, staleMs: 2_000, maxEntries: 5 });
  for (let i = 0; i < 500; i += 1) cache.write(`page-${i}`, String(i), 0);
  assert.equal(cache.size, 5);
  assert.deepEqual(cache.read("page-499", 0)?.data, "499");
});

test("constructor rejects windows that would serve stale values forever", () => {
  assert.throws(() => new MicroCache<number>({ freshMs: 10, staleMs: 5 }), /staleMs must be >= freshMs/);
  assert.throws(() => new MicroCache<number>({ freshMs: Number.NaN, staleMs: 5 }), /freshMs/);
});

test("clear and delete drop entries immediately", () => {
  const cache = new MicroCache<number>({ freshMs: 1_000, staleMs: 2_000 });
  cache.write("a", 1, 0);
  cache.delete("a");
  assert.equal(cache.read("a", 0), null);
  cache.write("b", 2, 0);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.read("b", 0), null);
});

test("the pool route actually reads, writes and revalidates through the cache", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../apps/api/src/routes/site.ts", import.meta.url), "utf8");
  // Wiring, not prose: a route that forgot to write would still pass every other test here while
  // every reader paid for the query again.
  assert.match(source, /const poolCache = new MicroCache<\{ data: Awaited<ReturnType<typeof loadPool>> \}>\(\{/);
  assert.match(source, /freshMs: POOL_FRESH_MS/);
  assert.match(source, /if \(hit\?\.fresh\)/);
  assert.match(source, /poolCache\.write\(staleKey, \{ data \}\);/);
  // The stale branch must hand the reader a value *before* awaiting the refresh. 2026-11-14：刷新那段
  // 抽成了 `refreshPool`（落盘底稿也要用它），所以这里改盯「stale 分支只调用、不 await」+
  // 「refreshPool 自己在后台跑」两条，检查的东西和以前一样：读者不等刷新。
  const stale = source.slice(source.indexOf("if (hit?.stale)"), source.indexOf("// 内存里没有"));
  assert.match(stale, /refreshPool\(staleKey, args\);/);
  assert.ok(!/await refreshPool\(/.test(stale), "the stale branch must not make the reader wait for the refresh");
  assert.match(stale, /return sendJsonWithEtag\(req, reply, hit\.data\.data/);
  const refresh = source.slice(source.indexOf("function refreshPool"), source.indexOf("const TIMELINE_STALE_MS"));
  assert.match(refresh, /void loadPool\(/);
  assert.match(refresh, /writePoolSnapshot/);
});
