import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(new URL("../deploy/geohot/snapshot-code.sh", import.meta.url), "utf8");

test("部署快照会自己清理旧包，否则一天几十次部署就能吃满磁盘", () => {
  // 2026-11-16：主库 /opt/geohot/backups 里 317 个 187 MB 的包，占了 24 GB
  assert.match(script, /GEOHOT_BACKUP_KEEP/);
  assert.match(script, /ls -1t "\$OUT_DIR"\/app-\*\.tar\.gz/);
  assert.match(script, /tail -n \+/);
  assert.match(script, /rm -f -- "\$\{OLD\[@\]\}"/);
});

test("保留数非法时退回 3，且至少留 1 个（刚打出来的包不能被删）", () => {
  assert.match(script, /KEEP="\$\{GEOHOT_BACKUP_KEEP:-3\}"/);
  assert.match(script, /''\|\*\[!0-9\]\*\) KEEP=3/);
  assert.match(script, /if \(\( KEEP >= 1 \)\); then/);
});
