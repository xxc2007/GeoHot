import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 2026-11-04：一次部署重启让 nginx 在换血的两分钟里回了 12 条 5xx，闸门据此把 worker 停了 30 分钟。
 * 那不是读者受害，是我们自己在重启。判据因此支持 R114_E5_EXCLUDE_FROM/TO 把重启那段排除。
 * 这个测试用合成日志把"宽限内不计、宽限外照计"钉死；判据本体与生产跑的是同一份 shell。
 */
const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

function hasBash(): boolean {
  try {
    execFileSync(BASH, ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("reader-gate 5xx 计数可以排除单元重启的宽限窗口", {
  skip: hasBash() ? false : "no usable bash here",
}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gate-"));
  try {
    const now = Math.floor(Date.now() / 1000);
    const stamp = (epoch: number) => {
      const d = new Date(epoch * 1000);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getDate())}/${months[d.getMonth()]}/${d.getFullYear()}:${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} +0800`;
    };
    const line = (epoch: number, status: number) =>
      `1.2.3.4 - - [${stamp(epoch)}] "GET /geohot/ HTTP/1.1" ${status} 1 "-" "ua"\n`;
    // 三条落在"重启宽限"里，两条在窗外；两种状态码都要被认成 5xx。
    const inside = now - 60;
    const outside = now - 300;
    const log = [line(inside, 503), line(inside + 1, 503), line(inside + 2, 502), line(outside, 502), line(outside + 1, 503)].join("");
    const logPath = path.join(dir, "access.log");
    writeFileSync(logPath, log);

    const decide = "deploy/geohot/bin/r114-drain-decide.sh";
    const t0 = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
    const date = execFileSync(BASH, ["-c", "LC_ALL=C date +%d/%b/%Y"], { encoding: "utf8" }).trim();
    const yesterday = execFileSync(BASH, ["-c", "LC_ALL=C date -d yesterday +%d/%b/%Y"], { encoding: "utf8" }).trim();
    const run = (excludeFrom?: number, excludeTo?: number) => {
      const env = excludeFrom === undefined ? {} : { R114_E5_EXCLUDE_FROM: String(excludeFrom), R114_E5_EXCLUDE_TO: String(excludeTo) };
      const script = `. ${decide}\ne5_count "${logPath}" 20000 700 "${date}" "${t0}" "${now}" "${yesterday}" "${t0 - 86400}"\n`;
      return execFileSync(BASH, ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } }).trim().split(" ");
    };

    const plain = run();
    assert.equal(plain[0], "5", `without a grace window all five count: ${plain.join(" ")}`);
    const graced = run(inside - 5, inside + 10);
    assert.equal(graced[0], "2", `the three inside the restart window must not count: ${graced.join(" ")}`);
    assert.equal(graced[3], "3", `and they are reported as excluded: ${graced.join(" ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
/**
 * 2026-11-05：闸门把 `systemctl is-active` 读不准（unknown/空）当成"操作者已停机"跳过。
 * 那意味着 5xx 早已超预算，闸门却一直 SKIP，读者在挨打而没人动手。判据现在只认明确的
 * inactive/failed 为"别人停的"，读不准就按 TRIP 处理（日志里 worker=unknown 可见）。
 */
test("reader-gate 读不准 worker 状态时不把责任推给操作者", {
  skip: hasBash() ? false : "no usable bash here",
}, () => {
  const decide = path.resolve("deploy/geohot/bin/r114-drain-decide.sh");
  const call = (active: string, we = "0") =>
    execFileSync(BASH, ["-c", '. "$1"; gate_action 7 1700000000 0 "$2" "$3" 0 0', "gate", decide, we, active],
      { encoding: "utf8" }).trim();
  assert.equal(call("unknown"), "TRIP");
  assert.equal(call(""), "TRIP");
  assert.equal(call("active"), "TRIP");
  assert.equal(call("inactive"), "SKIP_OPERATOR_STOPPED");
  assert.equal(call("failed"), "SKIP_OPERATOR_STOPPED");
  // 本闸门自己停的，无论读成什么都要 TRIP（恢复责任是它的）。
  assert.equal(call("unknown", "1"), "TRIP");
});
