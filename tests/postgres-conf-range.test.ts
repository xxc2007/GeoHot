import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-11-16 事故：主库 /etc/postgresql/17/main/conf.d/zz-geohot-vacuum.conf 里被写成
// autovacuum_vacuum_cost_delay = 200，而 PostgreSQL 17 的合法上限是 100ms。平时不重启看不出，
// 真重启时 postgres 直接 FATAL: configuration file contains errors / pg_ctl: could not start server。
// 这段配置现在进仓库，这条测试守住取值范围。
const conf = readFileSync("deploy/geohot/postgres/zz-geohot-vacuum.conf", "utf8");
const deploy = readFileSync("deploy/geohot/deploy.sh", "utf8");

function value(name: string): number | null {
  const m = conf.match(new RegExp(`^\\s*${name}\\s*=\\s*(-?\\d+)`, "m"));
  return m ? Number(m[1]) : null;
}

test("autovacuum_vacuum_cost_delay 必须在 PostgreSQL 允许的 -1..100 毫秒内", () => {
  const v = value("autovacuum_vacuum_cost_delay");
  assert.notEqual(v, null, "配置里必须写明 autovacuum_vacuum_cost_delay");
  assert.ok(v! >= -1 && v! <= 100, `cost_delay=${v} 超出 -1..100，重启数据库会起不来`);
  assert.ok(v! >= 10, `cost_delay=${v} 太小，慢盘上回收又会把读者面压住`);
});

test("autovacuum_vacuum_cost_limit 必须在 1..10000 内", () => {
  const v = value("autovacuum_vacuum_cost_limit");
  assert.notEqual(v, null);
  assert.ok(v! >= 1 && v! <= 10_000, `cost_limit=${v} 超出 1..10000`);
});

test("部署会把这段配置同步到机器上（不再只活在机器态里）", () => {
  assert.match(deploy, /zz-geohot-vacuum\.conf/);
  assert.match(deploy, /conf\.d\/zz-geohot-vacuum\.conf/);
});

test("注释里留着这次事故，别让下一个人再踩", () => {
  assert.match(conf, /200/);
  assert.match(conf, /起不来|could not start server/);
});
