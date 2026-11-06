import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 2026-11-06 现场：一条 `while :; do …; sleep 10; done` 从被关掉的 ssh 会话里漂出来，
// 跑了 2 天 10 小时、写掉 66 GB 日志，把 891 MB 的机器反复打进 I/O 饥饿，读者面 503/000。
// 这个用例钉住「循环自带寿命上限」，防止哪天又被改回没有尽头的 while。
const SOURCE = readFileSync(new URL("../deploy/geohot/bin/probe-watch.sh", import.meta.url), "utf8");

test("probe-watch 的循环有时间上限，到点自己退出", () => {
  assert.match(SOURCE, /MAX_SECONDS="\$\{GEOHOT_PROBE_MAX_SECONDS:-14400\}"/);
  assert.match(SOURCE, /STARTED_AT="\$\(date \+%s\)"/);
  assert.match(SOURCE, /if \[ "\$\(\( \$\(date \+%s\) - STARTED_AT \)\)" -ge "\$\{MAX_SECONDS\}" \]; then/);
  assert.match(SOURCE, /"expired":true/);
  assert.match(SOURCE, /exit 0/, "到点必须以 0 退出，让 supervisor 读成正常结束");
});

test("寿命检查在每次采样之前，不能在 sleep 之后才判", () => {
  // 注意：文件头的注释里也出现过 `while :; do …` 这串字，所以循环本体要从最后一个 while 算起。
  const start = SOURCE.lastIndexOf("while :; do");
  const loop = SOURCE.slice(start, SOURCE.indexOf("\ndone", start));
  const guard = loop.indexOf("MAX_SECONDS");
  const probe = loop.indexOf("probe_json");
  const sleep = loop.indexOf('sleep "${MODE}"');
  assert.ok(start > -1 && guard > -1 && probe > guard && sleep > probe, "顺序必须是 判寿命 → 采样 → 睡");
});

test("once 模式不受寿命影响（它本来就只跑一轮）", () => {
  const once = SOURCE.slice(SOURCE.indexOf('if [ "${MODE}" = "once" ]'), SOURCE.indexOf("while :; do"));
  assert.ok(!once.includes("MAX_SECONDS"), "once 分支不该读寿命变量");
});
