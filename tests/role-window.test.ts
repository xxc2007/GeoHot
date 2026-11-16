// 执行器昼夜档：白天留一个分析槽，夜里开两个（2026-11-16 从「白天不开」改成「白天一个」）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/bin/role-window.sh", import.meta.url), "utf8");
const dayTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-day.timer", import.meta.url), "utf8");
const nightTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-night.timer", import.meta.url), "utf8");
const install = readFileSync(new URL("../deploy/geohot/install-units.sh", import.meta.url), "utf8");

test("白天留一个分析槽，采集与正文提取照跑", () => {
  // 2026-11-16：白天从 slots=0 改成 1。当天主库 io avg10 只有 5.9、load 0.9，
  // 而积压里躺着两千多条分析——把白天压成 0 是更早那套保守值。
  assert.match(script, /day\)\s*\n\s*role=all/);
  assert.match(script, /slots="\$\{GEOHOT_ROLE_DAY_SLOTS:-1\}"/);
  assert.match(script, /night\)\s+role=all; slots="\$\{GEOHOT_ROLE_NIGHT_SLOTS:-2\}"/);
  assert.match(script, /set_key WORKER_ROLE "\$role"/);
  // role=fetcher 会连正文提取一起关掉（worker-role.ts 的 extraction 判据），
  // 2026-11-15 白天三台全切 fetcher，6 小时堆了 420 条 body_status=pending。
  assert.doesNotMatch(script, /role=fetcher/);
  // ANALYZE_CONCURRENCY 写 0 会被 config 回落到 6/4，必须恒定 1，用 slots 拦分析。
  assert.match(script, /set_key ANALYZE_CONCURRENCY "1"/);
  assert.match(script, /set_key GEOHOT_INTAKE_ANALYSIS_SLOTS "\$slots"/);
});

test("白天可以让某几台只采集不开分析（四台一起写会把慢盘打死）", () => {
  // 2026-11-16 11:00 现场：四台各 1 槽同时分析，主库 io some avg10 99、load 40，
  // 后台登录 504、/api/health 464 秒。白天只留一台分析，其余三台 slots=0 ——
  // intake 按分析车道单独计数，写 0 不影响采集与正文提取。
  assert.match(script, /GEOHOT_ROLE_DAY_ACTIVE:-1/);
  assert.match(script, /if \[ "\$\{GEOHOT_ROLE_DAY_ACTIVE:-1\}" = "0" \]; then slots=0; else slots="\$\{GEOHOT_ROLE_DAY_SLOTS:-1\}"; fi/);
  // 夜里不看这个开关：到点全部回到 GEOHOT_ROLE_NIGHT_SLOTS。
  const night = script.slice(script.indexOf("night) role=all"));
  assert.doesNotMatch(night.slice(0, 120), /GEOHOT_ROLE_DAY_ACTIVE/);
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
