import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-11-16 的黑框回归：补丁只 replace 了第一处（initdb），常驻的 postgres.exe 没打上，
// 于是 detached 起来的开发库又开出一个控制台窗口。这条测试钉住「必须全量替换」。
const script = readFileSync("scripts/patch-embedded-pg.mjs", "utf8");

test("补丁脚本对每一处 spawn 都要打 windowsHide", () => {
  assert.match(script, /split\(FROM\)\.join\(/);
  assert.doesNotMatch(script, /source\.replace\(FROM,/, "单次 replace 会让 postgres.exe 漏掉");
});

test("补丁脚本按「还剩几处没打」判断是否已打过", () => {
  assert.match(script, /const remaining = source\.split\(FROM_ALL\)\.length - 1;/);
  assert.match(script, /if \(remaining === 0\)/);
});

test("postinstall 仍然挂着这个补丁（重装依赖后自动重打）", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.postinstall, "node scripts/patch-embedded-pg.mjs");
});
