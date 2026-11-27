// 运行看板口径：今天（北京时间零点起）/ 7 天 / 全部。
// 2026-11-27 站长把原来的 15 分钟…7 天五档换掉；这里钉住「今天」的边界与旧链接的归一化，
// 免得哪天回到「窗口从进程启动算起」或把 10080 分钟当成今天。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWindow, windowSpec } from "@aihot/backend/admin/ops-window";

test("normalizeWindow keeps the three keys and maps legacy minutes", () => {
  assert.equal(normalizeWindow("today"), "today");
  assert.equal(normalizeWindow("7d"), "7d");
  assert.equal(normalizeWindow("all"), "all");
  assert.equal(normalizeWindow(undefined), "today");
  assert.equal(normalizeWindow(null), "today");
  assert.equal(normalizeWindow(""), "today");
  assert.equal(normalizeWindow("nonsense"), "today");
  assert.equal(normalizeWindow(60), "today");
  assert.equal(normalizeWindow("1440"), "today");
  assert.equal(normalizeWindow(10080), "7d");
  assert.equal(normalizeWindow("4320"), "7d");
});

test("today starts at Beijing midnight, not at a rolling 24 hours", () => {
  const now = Date.parse("2026-11-27T13:30:00Z"); // 北京时间 21:30
  const spec = windowSpec("today", now);
  assert.equal(spec.since.toISOString(), "2026-11-26T16:00:00.000Z");
  assert.equal(spec.minutes, 21 * 60 + 30);
  assert.equal(spec.bucket, 60);
});

test("a few minutes after midnight still yields one hourly bar", () => {
  const now = Date.parse("2026-11-26T16:05:00Z"); // 北京时间 00:05
  const spec = windowSpec("today", now);
  assert.equal(spec.since.toISOString(), "2026-11-26T16:00:00.000Z");
  assert.equal(spec.minutes, 5);
  assert.equal(spec.bucket, 60);
});

test("7 days rolls and buckets every 6 hours", () => {
  const now = Date.parse("2026-11-27T13:30:00Z");
  const spec = windowSpec("7d", now);
  assert.equal(spec.minutes, 7 * 24 * 60);
  assert.equal(spec.bucket, 360);
  assert.equal(spec.since.toISOString(), new Date(now - 7 * 24 * 60 * 60_000).toISOString());
});

test("all has no lower bound in practice and buckets by day", () => {
  const spec = windowSpec("all");
  assert.equal(spec.minutes, 0);
  assert.equal(spec.bucket, 1440);
  assert.ok(spec.since.getUTCFullYear() === 2000);
});