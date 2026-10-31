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
import { getBoss, stopBoss, QUEUES } from "@aihot/backend/jobs/queue";
import { ageStaleLiveJobs } from "@aihot/backend/jobs/content";

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
