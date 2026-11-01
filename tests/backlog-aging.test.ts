// Aging lifts the starved tail of the created backlog back to the current priority water line:
// old live jobs compete again, a job not yet 2h stale keeps its own priority, and the -1/-2
// backfill yield (resource-budget.ts) stays untouched. The claim order after aging must read
// aged-old → fresh → backfill, which is what the pgboss fetch order asserts below. Background:
// the minute-based key (observation minute × 2) pins every older job permanently behind every
// newer one — on 2026-10-31 all 4305 created content.analyze jobs had started_on IS NULL with the
// oldest from 10-26 while concurrency was not saturated.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss, ensureQueue, QUEUES } from "@aihot/backend/jobs/queue";
import { ageStaleLiveJobs, agingBandPriority } from "@aihot/backend/jobs/content";
import { realTimePriority } from "@aihot/backend/operations/resource-budget";

const T = tag();
const JOB = QUEUES.analyze;

async function insertJob(priority: number, ageHours: number, label: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO pgboss.job (name, data, priority, created_on)
    VALUES (${JOB}, ${sql.json({ tag: T, label })}, ${priority}, now() - make_interval(mins => ${ageHours * 60}))
    RETURNING id`;
  return row.id;
}

after(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'tag' = ${T}`;
  // stopBoss 否则 pg-boss 的维护定时器会吊住事件循环，测试进程跑完也不退出。
  await stopBoss();
  await closeDb();
});

test("old live jobs lift to the water line; fresh keeps its own; backfill yields stay put", async () => {
  // 先取 boss：此刻仍是默认的非 balanced 档位，queue.ts 的 resource-intake 闸门不会安装——
  // 本机没有 /proc/pressure 时它会把每次 fetch 判成资源压力而拒绝认领（返回空批）。
  // 之后再临时打开 balanced，让 realTimePriority 启用分钟键水位（env 按调用时读取）。
  const boss = await getBoss();
  process.env.GEOHOT_RESOURCE_PROFILE = "balanced";
  try {
    // 单文件跑（不随全套 npm test 顺序经过会建队列行的其他测试）时 job_common 的 q_fkey 需要这一行存在。
    await ensureQueue(QUEUES.analyze);
    const oldA = await insertJob(40, 5, "old-a");
    const oldB = await insertJob(60, 3, "old-b");
    const fresh = await insertJob(2_000_000, 0.5, "fresh");
    const backfill1 = await insertJob(-1, 5, "backfill-archive");
    const backfill2 = await insertJob(-2, 5, "backfill-history");

    const { lifted } = await ageStaleLiveJobs();
    assert.ok(lifted >= 2, "at least the two stale live jobs are lifted");

    const rows = await sql<{ id: string; priority: number }[]>`
      SELECT id, priority FROM pgboss.job WHERE id IN (${oldA}, ${oldB}, ${fresh}, ${backfill1}, ${backfill2})`;
    const byId = new Map(rows.map((r) => [r.id, r.priority]));
    const water = byId.get(oldA)!;
    assert.ok(water > 1_000_000, "the water line is the current minute key, far above the stale priorities");
    assert.equal(byId.get(oldB), water, "both stale jobs lift to the same water line");
    assert.equal(byId.get(fresh), 2_000_000, "a job not yet 2h old keeps its own priority");
    assert.equal(byId.get(backfill1), -1, "archive backfill keeps its yield priority");
    assert.equal(byId.get(backfill2), -2, "history backfill keeps its yield priority");

    // Claim order after aging: aged-old → fresh → backfill. pg-boss serves higher priority first and
    // breaks ties by created_on. v12 的 fetch 是 UPDATE…RETURNING，RETURNING 的行序不保证，所以按
    // batchSize 1 逐次取头——每次单批取的正是当时队列的头（ORDER BY priority desc, created_on 的
    // LIMIT 1），五个单批的先后就是 claim 顺序。
    const labels: Array<string | undefined> = [];
    for (let i = 0; i < 5; i++) {
      const [job] = await boss.fetch<{ tag?: string; label?: string }>(JOB, { batchSize: 1 });
      labels.push(job?.data?.label);
    }
    assert.deepEqual(labels, ["old-a", "old-b", "fresh", "backfill-archive", "backfill-history"]);
  } finally {
    delete process.env.GEOHOT_RESOURCE_PROFILE;
  }
});

test("aging band sits under the live line: a fresh arrival always outranks the band", async () => {
  const boss = await getBoss();
  process.env.GEOHOT_RESOURCE_PROFILE = "balanced";
  try {
    // 2026-11-02 生产实测（两轮）：每 tick 把最老任务抬到"当前水位"——每个新 tick 的带都精确落在
    // 全部已入队任务（含新文章）之上，积压 5100 条按 created_on 过带，读者面滞后 ≈ 积压/速率 ≈ 40h。
    // 04:05 部署 lifted=25 后复测仍如此（26 个完成全是 older 组）。带必须落在 48h 活新闻线之下
    // （water − 2×2880 分钟），且只升不降（`priority < band` 才有资格）：新文章、刚入队的任务
    // （优先级=当时水位）永远在带上方，先于旧任务被服务。
    await ensureQueue(QUEUES.analyze);
    const water = realTimePriority({ historical: false, archive: false, signal: false, observedAt: Date.now() });
    const stale = [];
    for (let i = 0; i < 30; i++) stale.push(await insertJob(100 + i, 5, `stale-${i}`));
    const fresh = await insertJob(water, 0.5, "fresh");

    const { lifted } = await ageStaleLiveJobs();
    assert.equal(lifted, 25, "exactly one bounded band is lifted when the backlog exceeds it");

    const rows = await sql<{ id: string; priority: number }[]>`
      SELECT id, priority FROM pgboss.job WHERE id IN (${stale[0]}, ${stale[1]}, ${stale[2]}, ${stale[3]}, ${stale[4]}, ${fresh})`;
    const byId = new Map(rows.map((r) => [r.id, r.priority]));
    const band = agingBandPriority(water);
    assert.ok(band > 0 && band < water, "the band sits strictly under the live water line");
    assert.equal(byId.get(stale[0]), band, "stale jobs lift to the band, not the water line");
    assert.equal(byId.get(fresh), water, "fresh keeps its own (water-line) priority");

    // Claim order: fresh (water) → bounded band (oldest created first) → un-lifted stale tail.
    const labels: Array<string | undefined> = [];
    for (let i = 0; i < 27; i++) {
      const [job] = await boss.fetch<{ tag?: string; label?: string }>(JOB, { batchSize: 1 });
      labels.push(job?.data?.label);
    }
    assert.equal(labels[0], "fresh", "fresh outranks the band");
    assert.ok(labels.slice(1, 26).every((l) => l?.startsWith("stale-")), "then the bounded band");
  } finally {
    delete process.env.GEOHOT_RESOURCE_PROFILE;
  }
});
