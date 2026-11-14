import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 2026-11-08：首页时间线在收据锁排队时会读到 2 秒以上、严重时 503。读者不该等后台干活，
// 所以 api 侧留了十分钟的上一次成功响应。这条测试钉住三件事：窗口存在、命中时打标记、
// 没有命中时必须原样把错误抛出去（不能把 503 说成 200 却没有内容）。
const source = readFileSync(new URL("../apps/api/src/routes/site.ts", import.meta.url), "utf8");

test("时间线留了十分钟的上一次成功响应", () => {
  assert.match(source, /const TIMELINE_STALE_MS = 10 \* 60_000;/);
  assert.match(source, /const timelineStale = new Map<string, \{ body: unknown; at: number \}>\(\);/);
});

test("读不出来时给上一次的那份，并标记 x-aihot-stale", () => {
  // 2026-11-14：时间线在现算前多了一支「先读落盘底稿」，`timelineStale.set` 因此出现了两次。
  // 这里改成从 catch 里切片，盯的仍然是同一件事：算失败时把内存里那份交出去并打标记。
  const at = source.indexOf("} catch (error) {\n      const hit = timelineStale.get(staleKey);");
  assert.ok(at > 0, "时间线的现算失败分支要留着内存回落");
  const branch = source.slice(at, source.indexOf("const body = { ...data", at));
  assert.match(branch, /if \(hit && Date\.now\(\) - hit\.at <= TIMELINE_STALE_MS\)/);
  assert.match(branch, /reply\.header\("x-aihot-stale", "1"\)/);
  assert.match(branch, /etagPrefix: "tl-stale"/);
});

test("没有可用的上一次响应时，原错误照旧抛给上层", () => {
  const at = source.indexOf("const staleKey = JSON.stringify(");
  const branch = source.slice(at, source.indexOf("const body = { ...data", at));
  assert.match(branch, /\n      throw error;\n/, "兜底不能把失败吞掉");
  const throwAt = branch.indexOf("throw error;");
  const catchAt = branch.indexOf("} catch (error) {");
  assert.ok(catchAt >= 0 && throwAt > catchAt, "throw 必须在 catch 里");
});

test("列表页（pool）也有同样的上一次兜底", () => {
  // 2026-11-15：陈旧窗口从 10 分钟放到 30 分钟（主库只有 ~250 IOPS，重算太贵）。
  assert.ok(source.includes("const POOL_STALE_MS = 30 * 60_000;"));
  assert.match(source, /etagPrefix: "pool-stale"/);
  const at = source.indexOf("const staleKey = JSON.stringify({ ...filters, q: search");
  assert.ok(at > 0, "pool 处理器要在取数前算好 key");
  // 2026-11-08：池子先走 45 秒的新鲜缓存，读库失败时仍要给「上一次的那份」。
  // 判据跟着代码形状走：catch 里看 `previous`，没有旧值就把原错误抛出去。
  const catchAt = source.indexOf("} catch (error) {", at);
  assert.ok(catchAt > at, "取数失败要有 catch");
  const branch = source.slice(catchAt, source.indexOf("poolCache.write(staleKey", catchAt));
  assert.ok(branch.includes("const previous = poolStale.get(staleKey);"));
  assert.ok(branch.includes("Date.now() - previous.at <= POOL_STALE_MS"));
  assert.ok(branch.includes('reply.header("x-aihot-stale", "1")'), "兜底要告诉调用方这份是旧的");
  assert.ok(branch.includes("throw error;"), "没有旧值时照旧报错");
});
