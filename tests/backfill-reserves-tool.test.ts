// 「备用」这栏读的是 source_reserves，不是 sources.enabled=false 的条数。站长 2026-11-15 把总目标
// 调到 2000/1000 之后，页面仍显示 330 —— 因为 1,064 条停用信源从没进过 reserve 表。这个测试盯住
// 补齐工具的三个关键点：只登记没登记过的、失败也要留下证据、退役的信源不许再进来。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const tool = readFileSync(path.join(ROOT, "tooling/backfill-reserves.ts"), "utf8");

test("备用池补齐工具只挑没登记过的停用信源", () => {
  assert.match(tool, /NOT s\.enabled/);
  assert.match(tool, /LEFT JOIN source_reserves r ON r\.source_id = s\.id/);
  assert.match(tool, /r\.source_id IS NULL/);
  assert.match(tool, /source_retirements/);
  assert.match(tool, /kind IN \('rss', 'json_list'\)/);
});

test("探测失败也登记，但标成不可用并写明原因", () => {
  assert.match(tool, /validateReserve\(source\)/);
  assert.match(tool, /INSERT INTO source_reserves \(source_id, validated_at, validation, eligible, next_check_at\)/);
  assert.match(tool, /ON CONFLICT \(source_id\) DO NOTHING/);
  assert.match(tool, /eligible.*true.*now\(\) \+ interval '3 days'/s);
  assert.match(tool, /eligible.*false.*now\(\) \+ interval '1 day'/s);
});

test("慢盘上连不上库要自己重试，而不是一崩了之", () => {
  assert.match(tool, /async function withRetry<T>/);
  assert.match(tool, /await withRetry\(\(\) => sql<Row\[\]>/);
});

test("开发库不再占着桌面：隐藏 postgres 控制台窗口的补丁只认自己的 bundle", () => {
  const devDb = readFileSync(path.join(ROOT, "scripts/dev-db.ts"), "utf8");
  assert.match(devDb, /function hideServerConsole\(\): void/);
  assert.match(devDb, /if \(process\.platform !== "win32"\) return;/);
  assert.match(devDb, /const bundle = BUNDLE_DIR;/);
  assert.match(devDb, /AttachConsole/);
  assert.match(devDb, /await cluster\.start\(\);\s*\n\s*hideServerConsole\(\);/);
});
