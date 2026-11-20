// 2026-11-16 现场根因：非搜索的首屏 pool 取数跑在裸连接上（无事务、无 statement_timeout、无并发闸）。
// 路由层的 20 秒 Promise.race 只是不再 await，底层查询仍在 PG 后端上跑到结束，连接不归还——
// 主库一慢，10 个连接全被"已放弃"的查询占住，/api/health 与其它读全部排队等死。
// 这里钉住：非搜索 pool 与主题主页都收进 withPublicRead（服务端 statement_timeout 到点主动取消、
// 连接必归还），主题计数冷读失败时退回上一份而不是整页 503。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const pool = await readFile(new URL("../packages/backend/src/publication/pool.ts", import.meta.url), "utf8");
const topics = await readFile(new URL("../packages/backend/src/publication/topics.ts", import.meta.url), "utf8");
const readBudget = await readFile(new URL("../packages/backend/src/publication/read-budget.ts", import.meta.url), "utf8");

test("非搜索 pool 主查询走 withPublicRead，搜索路径保持 withSearchCapacity", () => {
  assert.match(pool, /await withPublicRead\(\(db\) => run\(db\),/, "非搜索首屏必须收进有界公共读事务");
  assert.match(pool, /withPublicRead\([^\n]*signal\)/, "非搜索路径把路由预算 signal 透传给公共读闸");
  assert.match(pool, /await withSearchCapacity\(run\)/, "搜索路径仍走自己的容量闸");
  assert.match(pool, /import \{ withPublicRead \} from "\.\/read-budget\.ts";/);
});

test("withPublicRead 仍钉住服务端 statement_timeout / lock_timeout / 不派并行", () => {
  assert.match(readBudget, /set_config\('statement_timeout'/);
  assert.match(readBudget, /set_config\('lock_timeout', '1500'/);
  assert.match(readBudget, /max_parallel_workers_per_gather', '0'/);
  // statement_timeout 到点（57014）与我们自己的 lock_timeout（55P03）都必须翻成 PublicReadBusyError，
  // 由路由交回底稿/陈旧值，而不是变成 500 或泄漏连接。
  assert.match(readBudget, /code === "57014"/);
  assert.match(readBudget, /code === "55P03"/);
});

test("主题主页查询走 withPublicRead，计数冷读失败退回上一份", () => {
  assert.match(topics, /await withPublicRead<ItemRow\[\]>\(\(db\) => db`/, "主题主页必须有界");
  assert.match(topics, /SET LOCAL statement_timeout = 15000/, "计数 CTE 有 15 秒上界");
  assert.match(topics, /if \(countsSnapshot\) return countsSnapshot/, "计数失败时用上一份，而不是整页 503");
});

test("主题计数 gate 查询与 CTE 在同一 15s 事务，不再裸 Promise.all 挂住回退", () => {
  // 2026-11-16 复审：原来 loadCounts 用 Promise.all 跑 CTE（有 15s 取消）和一条裸
  // sql`SELECT min(visible_after)...`（无 statement_timeout）。io.full=95% 时裸 gate 自己
  // 挂 178s，Promise.all 永不 resolve，countsHeld 的陈旧回退也接不上。
  assert.match(topics, /await sql\.begin\(async \(tx\) => \{[\s\S]*SET LOCAL statement_timeout = 15000[\s\S]*min\(p\.visible_after\)/,
    "gate(min visible_after) 必须与计数 CTE 在同一 15s 事务内");
  assert.doesNotMatch(topics, /Promise\.all\(\[[\s\S]*?sql`[\s\S]*?min\(p\.visible_after\)/,
    "不得再用 Promise.all 包裸 sql gate");
});
