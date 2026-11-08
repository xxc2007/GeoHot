import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 严格模式（站长 2026-11-08）：「取不到的图就摘掉再发布」这条兜底默认必须是关着的。
const source = readFileSync(new URL("../packages/backend/src/media/prepare.ts", import.meta.url), "utf8");

test("摘图兜底默认关闭，只有显式开关才生效", () => {
  assert.match(source, /process.env.GEOHOT_MEDIA_STRIP_DEAD === "1"/);
  assert.match(source, /const stripAll = process.env.GEOHOT_MEDIA_STRIP_DEAD === "1" && failed > 0/);
});

test("严格模式下重试仍然存在：一次失败不等于整篇作废", () => {
  assert.match(source, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
});
