import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../apps/api/src/routes/admin.ts", import.meta.url), "utf8");

test("/api/admin/usage 走进程内缓存，命中就不再打数据库", () => {
  // 2026-11-16 现场：用量总览是几条按天/按小时的聚合，慢盘上单次几十秒，页面每 30 秒自动刷新，
  // 结果就是「后台连接暂时不可用，正在自动重试」一直转。
  assert.match(source, /const usageCache = new MicroCache</);
  assert.match(source, /freshMs: 60_000/);
  assert.match(source, /staleMs: 30 \* 60_000/);
  assert.match(source, /usageCache\.read\(key\)/);
  assert.match(source, /usageCache\.write\(key, data\)/);
});

test("过期值先给读者式的前端，重算在后台跑；重算失败仍给旧值", () => {
  assert.match(source, /x-admin-cache", "fresh"/);
  assert.match(source, /x-admin-cache", "stale"/);
  assert.match(source, /x-admin-cache", "stale-error"/);
  assert.match(source, /void refreshUsage\(key, args\)\.catch\(\(\) => \{\}\)/);
});

test("同一个 key 的并发请求只算一次", () => {
  assert.match(source, /const usagePending = new Map/);
  assert.match(source, /if \(usagePending\.has\(key\)\) return usagePending\.get\(key\)!/);
});
