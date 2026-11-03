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
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker', 'alerts.workerBootSeen')`;
  await sql`DELETE FROM settings WHERE key IN ('heartbeat.worker', 'alerts.workerBootSeen')`;
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
  await sql`DELETE FROM settings WHERE key IN ('alerts.state', 'alerts.workerBootSeen')`;
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

test("崩溃循环不再静音内容告警：settled 之外看 startedAt 变化数", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  // 第一个测试把夹具推进到 analyzed 验证过恢复；这里把 10 篇放回排队、并压到安静线外，
  // 让 content.process 与 content.collect 的判据本身成立，只考察「静音与否」这一个变量。
  await sql`UPDATE articles SET processing_state = 'new', discovered_at = now() - interval '8 hours' WHERE id IN ${sql(ids)}`;
  const t0 = Date.now();
  const setHeartbeat = (startedAt: string) =>
    sql`INSERT INTO settings (key, value, updated_by) VALUES ('heartbeat.worker', ${sql.json({ startedAt } as never)}, 'test')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const setBootSeen = (value: unknown) =>
    sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.workerBootSeen', ${sql.json(value as never)}, 'test')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const stuckKeys = (keys: string[]) => keys.filter((k) => k === "content.collect" || k === "content.process");
  const bootKeys = async () => stuckKeys((await collectFindings(t0)).map((f) => f.key));

  // ① startedAt 只有 5 分钟（settled=false，现缺口），但窗口内已有 3 次重启：两条告警都要出声。
  // lastStartedAt 必须对齐当前的 startedAt：夹具里那 3 条才真的是"已经记下的 3 次"。若让它停在旧值，
  // 这一轮又观察到一个没见过的启动时刻，按判据就该记成第 4 次（采样是"变化即计 1 次"，不是"猜总数"）。
  const freshStartedAt = new Date(t0 - 5 * 60_000).toISOString();
  await setHeartbeat(freshStartedAt);
  await setBootSeen({ lastStartedAt: freshStartedAt, changes: [t0 - 50 * 60_000, t0 - 30 * 60_000, t0 - 10 * 60_000].map((t) => new Date(t).toISOString()) });
  const loop = await collectFindings(t0);
  assert.deepEqual(stuckKeys(loop.map((f) => f.key)), ["content.collect", "content.process"], "宽限窗内反复重启要照常报警");
  for (const key of stuckKeys(loop.map((f) => f.key))) {
    const f = loop.find((x) => x.key === key)!;
    assert.ok(f.detail?.includes("重启 3 次"), `impact 要说明疑似崩溃循环：${f.detail}`);
  }

  // ② 正常重启：同样新鲜的 startedAt，但窗口内只有 1 次变化——宽限生效，两条告警缺席。
  await setBootSeen({ lastStartedAt: "2026-01-01T00:00:00.000Z", changes: [new Date(t0 - 10 * 60_000).toISOString()] });
  assert.deepEqual(await bootKeys(), []);

  // ③ checkAlerts 一轮后 lastStartedAt 更新为当前 startedAt：下一轮不再重复计数。
  await setBootSeen({ lastStartedAt: "2026-01-01T00:00:00.000Z", changes: [new Date(t0 - 10 * 60_000).toISOString()] });
  await checkAlerts(t0);
  const [seen] = await sql<{ value: { lastStartedAt: string; changes: string[] } }[]>`SELECT value FROM settings WHERE key = 'alerts.workerBootSeen'`;
  assert.equal(seen!.value.lastStartedAt, freshStartedAt);
  // 采样已消费：这一轮把新鲜的 startedAt 记成 1 条新样本，旧的那 1 条还在窗内，落盘总数是 2。
  assert.equal(seen!.value.changes.length, 2, "本轮计的是 1 次新增，不是把旧样本抹掉");
  // 同输入再跑不涨：不会每 10 分钟白送一次计数。
  const again = await collectFindings(t0 + 60_000);
  assert.equal((again as unknown as { workerBootSeen: { changes: string[] } }).workerBootSeen.changes.length, seen!.value.changes.length);

  // ④ 无心跳行：settled=true 原语义不变，boot 采样也不把缺席当成重启。
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`DELETE FROM settings WHERE key = 'alerts.workerBootSeen'`;
  assert.deepEqual(stuckKeys((await collectFindings(t0)).map((f) => f.key)), ["content.collect", "content.process"]);
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  // 还原给下一个测试：额度告警的口径不依赖这批夹具，但保持整洁。
  await sql`UPDATE articles SET processing_state = 'analyzed', discovered_at = now() - interval '3 hours' WHERE id IN ${sql(ids)}`;
});

test("额度告警与后台的「已用」数的是真花了钱的尝试，与熔断器同一个口径", async () => {
  // 第三十四轮把熔断器改成只数真产生账单的尝试，这两处当时没跟着改：一次代理故障（几百次连不上的尝试）
  // 就能让告警报「24 小时额度用完」而 paidRequest 还在放行，运维照告警去充值，真相是那条链一条稿子没出。
  const billed = sql`billing_status <> 'unbilled'`; // 独立算式：不从被测 helper 生成期望值
  const spend = async () => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts
    WHERE service = 'agnes-cn' AND origin = 'live' AND started_at > now() - interval '1 day' AND ${billed}`)[0]!.n;
  const [saved] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'agnes-cn'`;
  const [seed] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, request, attempts)
    VALUES (${'alert-unbilled-' + T}, 'agnes-cn', 'invariant_test', 'failed', '{}'::jsonb, 1) RETURNING id`;
  try {
    const before = await spend();
    await sql`UPDATE budgets SET per_day = ${before + 1} WHERE service = 'agnes-cn'`;
    await sql`
      INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, billing_status, started_at, finished_at)
      SELECT ${seed!.id}, n, 'agnes-cn', 'live', 'failed', 'unbilled', now() - interval '2 hours', now() - interval '2 hours'
      FROM generate_series(1, 300) n`;
    const [total] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt_attempts
      WHERE service = 'agnes-cn' AND origin = 'live' AND started_at > now() - interval '1 day'`;
    assert.ok(total!.n >= before + 1, "夹具没有越过旧口径的上限，那这条断言就没在盯任何东西");

    const keys = (await collectFindings()).map((f) => f.key);
    assert.equal(keys.includes("budget.day.agnes-cn"), false, "连不上的尝试不产生账单，不该报额度用完");
    const row = (await listBudgets()).find((b) => b.service === "agnes-cn");
    assert.equal(row!.used_day, before, "后台的「已用」与告警数的是同一个数");

    // 同样这 300 行，换成「结果说不清」（可能已经计费）就必须立刻算数——两个方向都要红得起来。
    await sql`UPDATE receipt_attempts SET status = 'unknown', billing_status = 'unknown' WHERE receipt_id = ${seed!.id}`;
    const after = (await collectFindings()).map((f) => f.key);
    assert.equal(after.includes("budget.day.agnes-cn"), true, "可能已经计费的尝试要立刻占额度");
    assert.equal((await listBudgets()).find((b) => b.service === "agnes-cn")!.used_day, before + 300, "后台的「已用」跟着涨 300");
  } finally {
    await sql`UPDATE budgets SET per_day = ${saved!.per_day} WHERE service = 'agnes-cn'`;
    await sql`DELETE FROM receipt_attempts WHERE receipt_id = ${seed!.id}`;
    await sql`DELETE FROM receipts WHERE id = ${seed!.id}`;
  }
});
