// 2026-11-15：下午的 io 雪崩查到根因是 autovacuum 在 `receipts`（2.8 GB，8 万死元组）上自己触发，
// 把 ~450 IOPS 的慢盘打到 98.6%，读者页从 40 ms 掉到 5 s。取消那次 autovacuum 后 io 立刻回到 2.76。
// 这里钉住「回收只放在凌晨窗口」这件事，免得以后有人把单元删了、又回到让 autovacuum 白天自己找时机。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("回收脚本只碰三张大表，并且不跟线上读写抢锁", () => {
  const script = read("deploy/geohot/bin/vacuum-maintenance.sh");
  assert.match(script, /TABLES=\(receipts receipt_attempts admin_model_attempt_metrics\)/);
  assert.match(script, /VACUUM \(ANALYZE, SKIP_LOCKED, VERBOSE\)/);
  assert.doesNotMatch(script, /VACUUM FULL/);
});

test("回收窗口在凌晨、按低 I/O 优先级跑", () => {
  const unit = read("deploy/geohot/systemd/geohot-vacuum-maintenance.service");
  assert.match(unit, /IOSchedulingClass=idle/);
  assert.match(unit, /Nice=19/);
  const timer = read("deploy/geohot/systemd/geohot-vacuum-maintenance.timer");
  assert.match(timer, /OnCalendar=\*-\*-\* 04:10:00 Asia\/Shanghai/);
});

test("install-units 认识这两个单元，漂移核对不会把它们当成机器孤本", () => {
  const installer = read("deploy/geohot/install-units.sh");
  assert.match(installer, /geohot-vacuum-maintenance\.service/);
  assert.match(installer, /geohot-vacuum-maintenance\.timer/);
});
