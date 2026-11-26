// 后台模型面板：冷却状态展示的 UI 映射与页面结构测试（源码级断言，与现有 web 测试同风格）。
// 2026-11-26：模型页并入运行看板（features/admin/panels/models.tsx），断言跟着文件走。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/features/admin/panels/models.tsx", import.meta.url), "utf8");
const statusMod = readFileSync(new URL("../app/features/admin/cooldown-status.ts", import.meta.url), "utf8");

test("页面包含冷却中的模型区块", () => {
  assert.match(page, /冷却中的模型/);
  assert.match(page, /cooldowns/);
  assert.match(page, /displayCooldown/);
  assert.match(page, /证据时间/);
  assert.match(page, /恢复条件/);
});

test("页面不回显上游错误原文", () => {
  assert.doesNotMatch(page, /\{c\.error/);
  assert.doesNotMatch(page, /\{c\.message/);
  assert.doesNotMatch(page, /\{c\.body/);
  assert.doesNotMatch(page, /\{c\.raw/);
});

test("状态映射模块覆盖四个分类", () => {
  assert.match(statusMod, /case "quota_day"/);
  assert.match(statusMod, /case "rate_minute"/);
  assert.match(statusMod, /case "auth"/);
  assert.match(statusMod, /case "config"/);
});

test("pending_reset 与 quota_day 区分（有无 resetAt）", () => {
  assert.match(statusMod, /pending_reset/);
  assert.match(statusMod, /未拿到上游 reset/);
});

test("恢复条件文案存在且不含原始 body 字段", () => {
  assert.match(statusMod, /recovery:/);
  // 不出现 body: string 这样的原始字段定义
  assert.doesNotMatch(statusMod, /body:\s*string/);
});

test("CooldownEntry 类型不含 raw/error/message 字段", () => {
  // 接口只暴露脱敏字段
  assert.match(statusMod, /service: string/);
  assert.match(statusMod, /model: string/);
  assert.match(statusMod, /category: CooldownCategory/);
  assert.match(statusMod, /evidenceAt: number/);
  assert.match(statusMod, /resetAt: number \| null/);
  assert.match(statusMod, /resetAssumed: boolean/);
  assert.doesNotMatch(statusMod, /error: string/);
  assert.doesNotMatch(statusMod, /message: string/);
});
