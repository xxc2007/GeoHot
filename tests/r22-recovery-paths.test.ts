// Round 22 复核（audit/recovery-paths）：恢复链路上四处「本该还人、却把人留在原地」的洞。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const hasBash = () => {
  try {
    execFileSync(BASH, ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const read = (file: string) => readFileSync(path.resolve(file), "utf8");

test("闸门被 disarm 或读不到样本时，仍要把自己停掉的 worker 还回去", {
  skip: hasBash() ? false : "no usable bash here",
}, () => {
  const decide = path.resolve("deploy/geohot/bin/r114-drain-decide.sh");
  // gate_action 5xx now until we_stopped active budget disarmed
  const call = (e5: string, we: string, disarmed: string) =>
    execFileSync(BASH, ["-c", '. "$1"; gate_action "$2" 1700000000 0 "$3" inactive 0 "$4"', "gate", decide, e5, we, disarmed],
      { encoding: "utf8" }).trim();
  assert.equal(call("-1", "1", "1"), "RELEASE", "disarmed 也要还人");
  assert.equal(call("-1", "0", "1"), "SKIP_DISARMED");
  assert.equal(call("-1", "1", "0"), "RELEASE", "读不到样本也要还人");
  assert.equal(call("-1", "0", "0"), "SKIP_BLIND");
});

test("健康样本只要求「比上一次新」，不再用 40 秒下界卡掉同一时刻的两次采样", () => {
  const source = read("deploy/geohot/bin/reader-recovery-ready.sh");
  assert.match(source, /now-prior >= 5 && now-prior <= 660/);
  assert.doesNotMatch(source, /now-prior >= 40/);
});

test("闸门单元自己有启动超时，不被 systemd 的 90 秒默认值中途杀掉", () => {
  const source = read("deploy/geohot/systemd/geohot-r115-reader-gate.service");
  assert.match(source, /TimeoutStartSec=330/);
});

test("例行切档不替读者面松刹车：fence 在位时不重启 worker", () => {
  const source = read("deploy/geohot/bin/worker-window.sh");
  const fence = source.indexOf("/run/geohot-r115-fence");
  const restart = source.indexOf("systemctl restart geohot-worker");
  assert.ok(fence > 0 && restart > fence, "fence 判定必须在重启之前");
  assert.match(source, /else\s*\n\s*systemctl restart geohot-worker/, "重启必须落在 else 分支里");
});