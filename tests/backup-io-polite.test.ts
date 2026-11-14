// 2026-11-15 02:0x–03:4x：主库 io some avg10 连续 99、首页 3.5 秒甚至 503，停掉所有 worker 也没好转。
// 真凶是武汉的夜间备份：`pg_dump -Fc` 把 6.8 GB 的库整个读一遍，而 receipts + receipt_attempts
// 两张日志表就占了一半体积。备份是「可以慢、但不能抢读者」的活，于是钉三条：
//   ① 导出走 ionice idle + nice 19；② 两张日志表只导结构不导数据；③ 单元本身也是 idle 类。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

const bootstrap = readFileSync(
  path.join(REPO_ROOT, "deploy/geohot/second-node/bootstrap3-ops.sh"),
  "utf8",
);

test("备份导出排在读者后面：ionice idle + nice 19", () => {
  assert.match(bootstrap, /ionice -c 3 nice -n 19 pg_dump -Fc -d geohot/);
});

test("日志表只导结构，不导数据", () => {
  assert.match(bootstrap, /--exclude-table-data=public\.receipts/);
  assert.match(bootstrap, /--exclude-table-data=public\.receipt_attempts/);
});

test("备份单元本身是 idle I/O 类，nice 19", () => {
  const unit = bootstrap.slice(bootstrap.indexOf("geohot-backup.service <<'UNIT'"));
  assert.match(unit, /IOSchedulingClass=idle/);
  assert.match(unit, /Nice=19/);
});
