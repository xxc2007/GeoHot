import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 2026-11-14：手机首屏 3.5–7.7 秒，站长要求「AIHOT 一样的响应速度」。现场读数：
// `/api/site/timeline?limit=12` 冷 5.80 秒，之后 2.33 / 0.043 / 0.031 / 0.325 秒 —— 5 秒的
// 快照窗口刚过就重算，等于「一直在冷算」。这条测试钉住窗口是 30 秒，且仍然服从下一条精选
// 发布时刻（`refreshAt`），不能为了快而让读者错过新稿。
const source = readFileSync(new URL("../packages/backend/src/publication/timeline.ts", import.meta.url), "utf8");

test("时间线快照保鲜 30 秒", () => {
  assert.match(source, /const SNAPSHOT_TTL_MS = 30_000;/);
  assert.ok(!/readAt \+ 5000/.test(source), "旧的 5 秒窗口必须消失，否则手机首屏又回到每 5 秒冷算");
});

test("窗口仍以下一条精选发布为准", () => {
  assert.match(source, /until: waiting \? Math\.max\(readAt \+ 1000, Math\.min\(readAt \+ SNAPSHOT_TTL_MS, waiting\.getTime\(\)\)\) : readAt \+ SNAPSHOT_TTL_MS,/);
});

test("注释如实写着 30 秒", () => {
  assert.match(source, /kept for thirty\s*\n?\s*\*? ?seconds per filter scope/);
  assert.match(source, /the 30 s window or the next release/);
});
