// 执行器的昼夜档脚本：白天必须有分析槽，且两套旧机制不能再出现。
//
// 背景（2026-11-16 现场）：杭州、武汉两台上同时装着三套昼夜机制，其中
// `geohot-bg-day.timer` 会在 07:00 把 worker 整个停掉；而新的
// `geohot-role-day.service` 指向的 `/opt/geohot/bin/role-window.sh` 又不存在
// （status=203/EXEC）。结果白天没有任何分析在跑，积压堆到 2,163 条。
// 这个用例钉住三件事：白天槽位不为 0、槽位可调、收敛脚本会关掉旧机制。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../deploy/geohot/bin/role-window.sh", import.meta.url), "utf8");
const setup = await readFile(new URL("../deploy/geohot/setup-executor-window.sh", import.meta.url), "utf8");

test("白天给一个分析槽，夜里给两个，都可用环境变量覆盖", () => {
  assert.match(script, /day\)\s+role=all; slots="\$\{GEOHOT_ROLE_DAY_SLOTS:-1\}"/);
  assert.match(script, /night\)\s+role=all; slots="\$\{GEOHOT_ROLE_NIGHT_SLOTS:-2\}"/);
  assert.doesNotMatch(script, /day\)\s+role=all; slots=0/, "白天槽位不能回到 0");
});

test("ANALYZE_CONCURRENCY 恒为 1：写 0 会被 config 当非法值回落到 6", () => {
  assert.match(script, /set_key ANALYZE_CONCURRENCY "1"/);
});

test("收敛脚本装好新脚本、关掉整天停 worker 的旧机制", () => {
  assert.match(setup, /install -m 755 "\$here\/bin\/role-window\.sh" "\$target"/);
  assert.match(setup, /geohot-bg-day\.timer/);
  assert.match(setup, /geohot-exec-window-day\.timer/);
  assert.match(setup, /geohot-role-day\.timer/);
});
