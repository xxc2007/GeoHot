import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-11-16：`pgboss.job_common` 142,349 行却累积了 4.89 亿次 seq_tup_read，
 * 取作业每次全表扫。两处一起钉住：迁移（能建的地方）与 worker 启动时的补建（pgboss 刚建完 schema 的地方）。
 */
const MIGRATION = path.resolve("database/migrations/0120_pgboss_fetch_index.sql");
const MODULE = path.resolve("packages/backend/src/jobs/fetch-index.ts");

test("迁移是条件建，列顺序与 pgboss 的 fetch 一致", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /IF to_regclass\('pgboss\.job_common'\) IS NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS job_common_fetch_idx/);
  assert.match(sql, /ON pgboss\.job_common \(name, state, start_after, priority DESC, created_on\)/);
});

test("worker 启动时会补建，且先问 to_regclass", () => {
  const code = readFileSync(MODULE, "utf8");
  assert.match(code, /export async function ensureFetchIndex/);
  assert.match(code, /to_regclass\('pgboss\.job_common'\) IS NOT NULL AS has/);
  assert.match(code, /CREATE INDEX IF NOT EXISTS job_common_fetch_idx/);
});

test("注释里要留下为什么", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /seq_tup_read/);
  assert.match(sql, /SKIP LOCKED/);
});
