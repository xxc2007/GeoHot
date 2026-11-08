// 聚合查询的预算：`count(*) FROM publications … EXISTS (readiness)` 在主库磁盘打满时单次要 3–5 分钟，
// 而它只是屏上「今日 N 条」「共 N 条」这两句说明文字。
//
// 2026-11-09 03:00 的生产现场：30 秒缓存把它们每 30 秒又点一次，`pg_stat_activity` 里堆到 18 条 active、
// 最老的一条跑了 4 分 05 秒，`io some avg10` 连续四十分钟 98 以上，SSH 连 `ps` 都要等三分钟。
// 这个用例钉住三条：同时最多两条、每条 15 秒语句超时、超时/超预算时把上一次的数字再交一次。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../packages/backend/src/publication/pool.ts", import.meta.url), "utf8");

test("聚合查询限两条并发", () => {
  assert.match(source, /const AGGREGATE_CONCURRENCY = 2;/, "并发上限必须是 2");
  assert.match(source, /if \(aggregateActive >= AGGREGATE_CONCURRENCY\) throw new Error\("aggregate budget busy"\);/);
  assert.match(source, /finally \{\s*aggregateActive -= 1;\s*\}/, "计数必须在 finally 里减回去");
});

test("聚合查询带语句超时", () => {
  assert.match(source, /const AGGREGATE_TIMEOUT_MS = 15_000;/);
  assert.match(source, /await tx`SET LOCAL statement_timeout = \$\{AGGREGATE_TIMEOUT_MS\}`/);
});

test("超时或超预算时退回上一次的数字", () => {
  assert.match(source, /const STALE_FALLBACK_MS = 24 \* 3600_000;/);
  const metaStale = source.slice(source.indexOf("async function cachedMeta"), source.indexOf("const countCache"));
  assert.match(metaStale, /catch \(error\) \{/);
  assert.match(metaStale, /if \(hit && Date.now\(\) - hit\.at < STALE_FALLBACK_MS\) return hit\.value as T\[\];/);
  const countStale = source.slice(source.indexOf("async function poolCount"), source.indexOf("export interface PoolQuery"));
  assert.match(countStale, /if \(hit && Date.now\(\) - hit\.at < STALE_FALLBACK_MS\) return hit\.n;/);
});

test("缓存有效期是十分钟，不再是三十秒", () => {
  assert.match(source, /const META_TTL_MS = 10 \* 60_000;/);
  assert.match(source, /const COUNT_TTL_MS = 10 \* 60_000;/);
  assert.doesNotMatch(source, /< 30_000/, "旧的三十秒判据不能留");
});
