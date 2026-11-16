import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-11-16：`pgboss.job_common` 142,349 行却累积了 4.89 亿次 seq_tup_read，
 * 取作业每次全表扫。这条用例钉住两件事：迁移在仓库里、列顺序与 pgboss 的 fetch 一致。
 */
const SQL = path.resolve("database/migrations/0120_pgboss_fetch_index.sql");

test("取作业的索引必须留在仓库里", () => {
  const sql = readFileSync(SQL, "utf8");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS job_common_fetch_idx/);
  assert.match(sql, /ON pgboss\.job_common \(name, state, start_after, priority DESC, created_on\)/);
});

test("注释里要留下为什么", () => {
  const sql = readFileSync(SQL, "utf8");
  assert.match(sql, /seq_tup_read/);
  assert.match(sql, /SKIP LOCKED/);
});
