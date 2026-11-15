// 执行器昼夜档：白天只采集，夜里才开分析（2026-11-15 慢盘实测后定的规则）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/bin/role-window.sh", import.meta.url), "utf8");
const dayTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-day.timer", import.meta.url), "utf8");
const nightTimer = readFileSync(new URL("../deploy/geohot/systemd/geohot-role-night.timer", import.meta.url), "utf8");
const install = readFileSync(new URL("../deploy/geohot/install-units.sh", import.meta.url), "utf8");

test("白天只采集，夜里一个分析槽", () => {
  assert.match(script, /day\)\s+role=fetcher; slots=0/);
  assert.match(script, /night\)\s+role=all;\s+slots=1/);
  assert.match(script, /set_key WORKER_ROLE "\$role"/);
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
