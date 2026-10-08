// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";
import { listBudgets } from "@aihot/backend/admin/settings";

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  // 状态机说"报过了"，还得说清有没有真的离开这台机器：这里没有会话 id，一条也没发出去。
  assert.deepEqual(stuck(r.notDelivered), ["content.process:disabled"], "没发出去的那条要单列出来，不能只留一个 sent 清单");
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});

test("额度告警与后台的「已用」数的是真花了钱的尝试，与熔断器同一个口径", async () => {
  // 第三十四轮把熔断器改成只数真产生账单的尝试，这两处当时没跟着改：一次代理故障（几百次连不上的尝试）
  // 就能让告警报「24 小时额度用完」而 paidRequest 还在放行，运维照告警去充值，真相是那条链一条稿子没出。
  const billed = sql`NOT (status = 'failed' AND usage IS NULL)`; // 独立算式：不从被测代码里抄，抄了就测不出漂移
  const spend = async () => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts
    WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day' AND ${billed}`)[0]!.n;
  const [saved] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'deepseek'`;
  const [seed] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, request, attempts)
    VALUES (${'alert-unbilled-' + T}, 'deepseek', 'invariant_test', 'failed', '{}'::jsonb, 1) RETURNING id`;
  try {
    const before = await spend();
    await sql`UPDATE budgets SET per_day = ${before + 1} WHERE service = 'deepseek'`;
    await sql`
      INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, started_at, finished_at)
      SELECT ${seed!.id}, n, 'deepseek', 'live', 'failed', now() - interval '2 hours', now() - interval '2 hours'
      FROM generate_series(1, 300) n`;
    const [total] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt_attempts
      WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
    assert.ok(total!.n >= before + 1, "夹具没有越过旧口径的上限，那这条断言就没在盯任何东西");

    const keys = (await collectFindings()).map((f) => f.key);
    assert.equal(keys.includes("budget.day.deepseek"), false, "连不上的尝试不产生账单，不该报额度用完");
    const row = (await listBudgets()).find((b) => b.service === "deepseek");
    assert.equal(row!.used_day, before, "后台的「已用」与告警数的是同一个数");

    // 同样这 300 行，换成「结果说不清」（可能已经计费）就必须立刻算数——两个方向都要红得起来。
    await sql`UPDATE receipt_attempts SET status = 'unknown' WHERE receipt_id = ${seed!.id}`;
    const after = (await collectFindings()).map((f) => f.key);
    assert.equal(after.includes("budget.day.deepseek"), true, "可能已经计费的尝试要立刻占额度");
    assert.equal((await listBudgets()).find((b) => b.service === "deepseek")!.used_day, before + 300, "后台的「已用」跟着涨 300");
  } finally {
    await sql`UPDATE budgets SET per_day = ${saved!.per_day} WHERE service = 'deepseek'`;
    await sql`DELETE FROM receipt_attempts WHERE receipt_id = ${seed!.id}`;
    await sql`DELETE FROM receipts WHERE id = ${seed!.id}`;
  }
});
