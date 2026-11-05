import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 2026-11-06 01:00 现场：夜间档刚切上去，第一次探测撞上 worker 重启后的冷页面（503 / 15s），
// 一次就把整个夜档退回白天。这条用例钉住：冷启动要热身、而且要**连续**两次不合格才退回。
const SCRIPT = new URL("../deploy/geohot/bin/worker-window.sh", import.meta.url);
const source = readFileSync(SCRIPT, "utf8");

test("the night guard warms up before its first probe", () => {
  assert.match(source, /guard_warmup=\$\{GEOHOT_WINDOW_GUARD_WARMUP:-15\}/);
  const guardBlock = source.slice(source.indexOf('if [[ "${GEOHOT_WINDOW_NO_GUARD:-0}" != "1" && "$mode" == "night" ]]'));
  assert.match(guardBlock, /sleep "\$guard_warmup"/, "warm-up runs before the deadline is computed");
  assert.ok(guardBlock.indexOf('sleep "$guard_warmup"') < guardBlock.indexOf("deadline="), "warm-up precedes the loop");
});

test("one unlucky probe no longer ends the night window", () => {
  assert.match(source, /guard_fails=\$\{GEOHOT_WINDOW_GUARD_FAILS:-2\}/);
  assert.match(source, /if \[\[ "\$bad" -ge "\$guard_fails" \]\]; then break; fi/, "the loop keeps probing after the first bad probe");
  assert.match(source, /else\n      bad=0\n    fi/, "a good probe resets the streak");
  assert.match(source, /if \[\[ "\$bad" -ge "\$guard_fails" \]\]; then\n    logger -t geohot-window/, "only a streak reverts to day");
});

test("the night unit gives the switch a wider page budget than the day guard", () => {
  // 2026-11-06 06:11 现场：即使热身 15 秒，切档后第一次探测仍可能撞上 4 秒以上的冷页面，
  // 夜间读者极少，把预算放宽到 8 秒，别让一次冷探测把整夜算力退回白天档。
  const unit = readFileSync(new URL("../deploy/geohot/systemd/geohot-worker-window-night.service", import.meta.url), "utf8");
  assert.match(unit, /Environment=GEOHOT_WINDOW_GUARD_MS=8000/);
  assert.match(unit, /Environment=GEOHOT_WINDOW_GUARD_WARMUP=30/);
});

test("the script still parses", () => {
  execFileSync("bash", ["-n", fileURLToPath(SCRIPT)], { stdio: "pipe" });
});