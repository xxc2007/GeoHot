// 执行器昼夜档：白天只采集，夜里才开分析（2026-11-15 慢盘实测后定的规则）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/bin/role-window.sh", import.meta.url), "utf8");
const dayTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-day.timer", import.meta.url), "utf8");
const nightTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-night.timer", import.meta.url), "utf8");
const install = readFileSync(new URL("../deploy/geohot/install-units.sh", import.meta.url), "utf8");

test("白天不开分析，但采集与正文提取照跑", () => {
  assert.match(script, /day\)\s+role=all; slots=0/);
  assert.match(script, /night\)\s+role=all;\s+slots=1/);
  assert.match(script, /set_key WORKER_ROLE "\$role"/);
  // role=fetcher 会连正文提取一起关掉（worker-role.ts 的 extraction 判据），
  // 2026-11-15 白天三台全切 fetcher，6 小时堆了 420 条 body_status=pending。
  assert.doesNotMatch(script, /role=fetcher/);
  // ANALYZE_CONCURRENCY 写 0 会被 config 回落到 6/4，必须恒定 1，用 slots 拦分析。
  assert.match(script, /set_key ANALYZE_CONCURRENCY "1"/);
  assert.match(script, /set_key GEOHOT_INTAKE_ANALYSIS_SLOTS "\$slots"/);
});

test("改 env 前先备份，改完重启 worker", () => {
  assert.match(script, /cp -p "\$env_file" "\$env_file\.bak-role-/);
  assert.match(script, /systemctl restart --no-block geohot-exec-worker/);
});

test("两个定时器按北京时间，且带 Persistent", () => {
  assert.match(dayTimer, /OnCalendar=\*-\*-\* 07:00:00 Asia\/Shanghai/);
  assert.match(nightTimer, /OnCalendar=\*-\*-\* 23:00:00 Asia\/Shanghai/);
  for (const unit of [dayTimer, nightTimer]) assert.match(unit, /Persistent=true/);
});

test("单元登记进安装清单，新机器照仓库就能装上", () => {
  assert.match(install, /geohot-role-day\.service geohot-role-day\.timer/);
  assert.match(install, /geohot-role-night\.service geohot-role-night\.timer/);
});
