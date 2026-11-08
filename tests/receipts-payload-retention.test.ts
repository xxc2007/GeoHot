// 回执里存的是每次付费调用的完整请求/响应 JSON：2026-11-08 在主库上是 44.9 万行 / 2.7 GB，
// 每一次状态更新都要在这张表上写一页堆和索引页，891 MB 的机器因此把磁盘 I/O 打满过。
// 记账只需要状态、模型、用量与费用，所以结清的回执过一天就丢掉正文；失败与未知留着给人看。
import assert from "node:assert/strict";
import test from "node:test";
import "./setup.ts";
import { pruneReceiptPayloads } from "@aihot/backend/operations/retention";
import { sql } from "@aihot/backend/db";

const KEY = "test:receipt-payload-retention";

async function seed(status: string, hoursAgo: number, key: string) {
  await sql`
    INSERT INTO receipts (logical_key, service, model, purpose, status, request, response, created_at)
    VALUES (${key}, 'llm', 'test-model', 'analyze', ${status},
            ${sql.json({ prompt: "x".repeat(200) })}, ${sql.json({ text: "y".repeat(200) })},
            now() - (${hoursAgo} * interval '1 hour'))
    ON CONFLICT (logical_key) DO NOTHING`;
}

test("结清的回执过一天丢掉正文，失败与未结清的留着", async () => {
  await sql`DELETE FROM receipts WHERE logical_key LIKE ${`${KEY}%`}`;
  await seed("completed", 72, `${KEY}:old-completed`);
  await seed("completed", 2, `${KEY}:fresh-completed`);
  await seed("failed", 72, `${KEY}:old-failed`);
  await seed("unknown", 72, `${KEY}:old-unknown`);

  const pruned = await pruneReceiptPayloads(new Date());
  assert.ok(pruned >= 1, "至少清掉一条结清回执的正文");

  const rows = await sql<{ logical_key: string; request: unknown; response: unknown; cost: string | null }[]>`
    SELECT logical_key, request, response, cost::text FROM receipts WHERE logical_key LIKE ${`${KEY}%`} ORDER BY logical_key`;
  const by = new Map(rows.map((r) => [r.logical_key, r]));
  assert.equal(by.get(`${KEY}:old-completed`)!.request, null, "旧结清回执的请求正文应被清掉");
  assert.equal(by.get(`${KEY}:old-completed`)!.response, null);
  assert.notEqual(by.get(`${KEY}:fresh-completed`)!.request, null, "一天内的回执照旧保留，便于核对");
  assert.notEqual(by.get(`${KEY}:old-failed`)!.request, null, "失败回执留着，运维要读");
  assert.notEqual(by.get(`${KEY}:old-unknown`)!.request, null, "未知回执留着，运维要读");

  await sql`DELETE FROM receipts WHERE logical_key LIKE ${`${KEY}%`}`;
});

test("保留策略挂在每日维护上，而不是靠人记着跑", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const source = readFileSync(path.resolve(import.meta.dirname, "../packages/backend/src/operations/retention.ts"), "utf8");
  assert.match(source, /const prunedReceiptPayloads = await pruneReceiptPayloads\(now\);/);
  assert.match(source, /return \{ deletedLeases: leases\.count, deletedJobRuns: runs\.count, prunedCache, prunedReceiptPayloads \};/);
});
