import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = new URL("../deploy/geohot/bin/r115-reader-gate.sh", import.meta.url);

/**
 * 2026-11-06 02:1x 现场：fence 从 01:56 关到 02:26 才到期，期间 analyze 队列 7,463 条一条没动，
 * 而同一时刻首页 0.37s、恢复样本每分钟都在写健康的凭据。冷却期不该等于"关满十分钟"。
 */
test("the gate may release a fence early once the reader is provably healthy", () => {
  const text = readFileSync(SCRIPT, "utf8");

  // 早释放必须仍然要求「读者面连续健康」这一个凭据，而不是只看时间。
  assert.match(text, /R115_MIN_HOLD_SEC:-\d+/);
  assert.match(text, /MIN_HOLD=\$\{R115_MIN_HOLD_SEC:-180\}/);
  assert.match(text, /if \[ "\$MODE" = fence \] && \[ -e "\$FENCE" \]/);
  assert.match(text, /&& \/bin\/bash "\$BIN\/reader-recovery-ready\.sh"; then/);
  assert.match(text, /rm -f -- "\$FENCE" && \{/);
  assert.match(text, /RELEASED-EARLY/);

  // 早释放只能出现在冷却分支里、HELD 之前：不能抢在 TRIP 判定前面。
  const early = text.indexOf("RELEASED-EARLY");
  const held = text.lastIndexOf('echo "$(date -Is) HELD');
  assert.ok(early > 0 && held > early, "early release must be emitted before the HELD line");

  // dry-run 不许动生产。
  assert.match(text, /\[ "\$\{R115_DRY:-0\}" != 1 \]/);

  // 语法必须真的成立（bash -n），否则线上每分钟一轮会直接失败。
  execFileSync("bash", ["-n", fileURLToPath(SCRIPT)]);
});