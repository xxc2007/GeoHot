// 时间线的落盘底稿：读者面首屏不能因为「进程刚起来 + 主库正被流水线打满」而干等十几秒。
//
// 2026-11-14 现场：冷 `/api/site/timeline?limit=12` 13.9 秒，最坏一次 120 秒超时；
// 收录池靠落盘底稿已经能在重启后 30 毫秒出屏，时间线是最后一处只走内存的地方。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = () => readFile(new URL("../apps/api/src/routes/site.ts", import.meta.url), "utf8");

test("时间线在内存为空时先读落盘底稿，再考虑现算", async () => {
  const text = await source();
  const cold = text.slice(text.indexOf("app.get(\"/api/site/timeline\""), text.indexOf("app.get(\"/api/site/pool\""));
  const snapshotAt = cold.indexOf("readPoolSnapshot<Awaited<ReturnType<typeof loadTimeline>>>(`tl:${staleKey}`)");
  const computeAt = cold.indexOf("loadTimeline({ ...filters, cursor: q.cursor || null, limit })");
  assert.ok(snapshotAt > 0, "冷启动分支必须读 `tl:` 前缀的落盘底稿");
  assert.ok(computeAt > snapshotAt, "底稿分支要排在现算之前，否则读者还是要等数据库");
  assert.match(cold, /reply\.header\("x-aihot-cache", "snapshot"\)/);
});

test("时间线算成功后写落盘底稿，且只存内容不存热度条", async () => {
  const text = await source();
  assert.match(text, /void writePoolSnapshot\(`tl:\$\{staleKey\}`, data\);/);
  // 热度条读的是另一张表，隔几分钟就不准；底稿里不带它，读回来时补 null。
  assert.match(text, /const body = \{ \.\.\.snapshot\.body, hot: null, hotAsOf: null, generatedAt: new Date\(snapshot\.at\)\.toISOString\(\) \};/);
});

test("现算失败时先回落内存，再回落底稿", async () => {
  const text = await source();
  const failure = text.slice(text.indexOf("} catch (error) {\n      const hit = timelineStale.get(staleKey);"));
  const memoryAt = failure.indexOf("timelineStale.get(staleKey)");
  const diskAt = failure.indexOf("readPoolSnapshot<Awaited<ReturnType<typeof loadTimeline>>>(`tl:${staleKey}`)");
  assert.ok(memoryAt >= 0 && diskAt > memoryAt, "内存比落盘新，先试内存");
  assert.match(failure, /reply\.header\("x-aihot-stale", "snapshot"\)/);
});

test("后台换新有时间线自己的去重集合，不会同一条并发刷两次", async () => {
  const text = await source();
  assert.match(text, /const timelineRefreshing = new Set<string>\(\);/);
  const fn = text.slice(text.indexOf("function refreshTimeline"), text.indexOf("export function siteHandler"));
  assert.match(fn, /if \(timelineRefreshing\.has\(key\)\) return;/);
  assert.match(fn, /\.finally\(\(\) => timelineRefreshing\.delete\(key\)\);/);
  // 后台刷新出错不许冒泡成读者可见的错误。
  assert.match(fn, /\.catch\(\(\) => \{\}\)/);
});
