import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = new URL("../deploy/geohot/bin/r114-drain-decide.sh", import.meta.url);

/**
 * 2026-11-16 事故：worker inactive 时 R115 对读者 5xx 返回 SKIP_OPERATOR_STOPPED，
 * 闸门静默跳过、不写栅栏，读者面持续 5xx 无人感知。修复后：5xx 超预算时无论 worker
 * 是 active/inactive/failed/unknown 都必须 TRIP（fence 模式只写栅栏文件、不重启进程）。
 */
function gate(e5: number, now: number, until: number, weStopped: number, active: string, budget = 0, disarmed = 0): string {
  const source = readFileSync(fileURLToPath(SCRIPT), "utf8");
  const out = execFileSync("bash", ["-c", `source <(cat); gate_action "${e5}" "${now}" "${until}" "${weStopped}" "${active}" "${budget}" "${disarmed}"`], {
    input: source, encoding: "utf8",
  });
  return out.trim();
}

test("worker inactive with reader 5xx must TRIP, not silently skip", () => {
  // 5xx=10 > budget=0, worker=inactive, we_stopped=0
  // 旧代码返回 SKIP_OPERATOR_STOPPED；修复后必须返回 TRIP
  const result = gate(10, 1000, 0, 0, "inactive");
  assert.equal(result, "TRIP", `inactive worker with 5xx=10 must TRIP, got ${result}`);
});

test("worker failed with reader 5xx must TRIP, not silently skip", () => {
  const result = gate(5, 1000, 0, 0, "failed");
  assert.equal(result, "TRIP", `failed worker with 5xx=5 must TRIP, got ${result}`);
});

test("worker active with reader 5xx still TRIPs", () => {
  const result = gate(3, 1000, 0, 0, "active");
  assert.equal(result, "TRIP");
});

test("we_stopped=1 with 5xx still TRIPs", () => {
  const result = gate(2, 1000, 0, 1, "inactive");
  assert.equal(result, "TRIP");
});

test("no 5xx with we_stopped=1 and inactive releases", () => {
  // e5=0 <= budget=0, we_stopped=1, active=inactive → RELEASE
  const result = gate(0, 1000, 0, 1, "inactive");
  assert.equal(result, "RELEASE");
});

test("no 5xx with we_stopped=0 idles", () => {
  const result = gate(0, 1000, 0, 0, "active");
  assert.equal(result, "IDLE");
});

test("cooling period holds regardless of worker state", () => {
  // until=2000, now=1000 → HELD
  const result = gate(5, 1000, 2000, 0, "inactive");
  assert.equal(result, "HELD");
});

test("disarmed with we_stopped=1 releases", () => {
  const result = gate(5, 1000, 0, 1, "inactive", 0, 1);
  assert.equal(result, "RELEASE");
});

test("disarmed without our stop skips", () => {
  const result = gate(5, 1000, 0, 0, "active", 0, 1);
  assert.equal(result, "SKIP_DISARMED");
});

test("script passes bash syntax check", () => {
  execFileSync("bash", ["-n", fileURLToPath(SCRIPT)]);
});

test("SKIP_OPERATOR_STOPPED branch is removed from gate_action", () => {
  const text = readFileSync(fileURLToPath(SCRIPT), "utf8");
  // The old line `elif [ "$active" = inactive ] ... SKIP_OPERATOR_STOPPED` must be gone.
  assert.ok(!/SKIP_OPERATOR_STOPPED/.test(text), "SKIP_OPERATOR_STOPPED must not appear in gate_action anymore");
});
