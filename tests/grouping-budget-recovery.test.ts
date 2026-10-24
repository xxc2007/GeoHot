import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverBudgetBlockedGrouping } from "@aihot/backend/operations/recover-grouping";

const source = `group-budget-${tag()}`;
const ids: string[] = [];
before(async () => {
  await ensureQueue(QUEUES.group);
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},${source},'rss')`;
});
after(async () => {
  await sql`DELETE FROM audit_log WHERE action='grouping.budget-recovery' AND subject=ANY(${ids.map(id=>`article:${id}`)})`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids})`;
  await sql`DELETE FROM receipts WHERE service=${source}`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss();
  await closeDb();
});
async function article() {
  const id = `gb-${tag()}`;
  ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${source},${id},${`https://example.com/${id}`},'Grouping budget recovery',now(),now())`;
  await sql`INSERT INTO regroup_pending(article_id) VALUES(${id})`;
  return id;
}
async function terminal(id: string, opts: { state?: string; error?: string; retry?: unknown; age?: number; signalOnly?: boolean } = {}) {
  const job = await enqueue(QUEUES.group, { articleId: id, ...(opts.signalOnly ? { signalOnly: true } : {}) }, { singletonKey: id });
  assert.ok(job);
  await sql`UPDATE pgboss.job SET state=${opts.state ?? "failed"}::pgboss.job_state,
    completed_on=now()-${opts.age ?? 120} * interval '1 second',
    output=${sql.json({ name: opts.error ?? "BudgetExceededError", retryAfterSeconds: opts.retry === undefined ? 60 : opts.retry } as never)}
    WHERE id=${job}`;
  return job;
}
const live = (id: string) => sql`SELECT name,data,singleton_key FROM pgboss.job
  WHERE name=${QUEUES.group} AND data->>'articleId'=${id} AND state IN ('created','retry','active')`;
const clearLive = (id: string) => sql`DELETE FROM pgboss.job
  WHERE name=${QUEUES.group} AND data->>'articleId'=${id} AND state IN ('created','retry','active')`;

test("only an expired local budget failure is restored to the original singleton, atomically and once", async () => {
  const id = await article();
  await terminal(id, { signalOnly: true });
  await Promise.all([recoverBudgetBlockedGrouping(), recoverBudgetBlockedGrouping()]);
  const jobs = await live(id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.singleton_key, id);
  assert.deepEqual(jobs[0]!.data, { articleId: id, force: true, signalOnly: true });
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='grouping.budget-recovery' AND subject=${`article:${id}`}`).length,1);
  await recoverBudgetBlockedGrouping();
  assert.equal((await live(id)).length, 1);
  assert.equal((await sql`SELECT article_id FROM regroup_pending WHERE article_id=${id}`).length, 1);
  await clearLive(id);
  // A completed recovery must supersede the older budget evidence.
  await terminal(id, { state: "completed", age: 0 });
});

test("newer terminal success, cancellation or different failure defeats older budget evidence", async () => {
  for (const opts of [{ state: "completed" }, { state: "cancelled" }, { error: "ModelOutputError" }, { error: "ProviderRejectedError" }, { error: "ReceiptUnknownError" }]) {
    const id = await article();
    await terminal(id, { age: 300 });
    await terminal(id, { ...opts, age: 120 });
    await recoverBudgetBlockedGrouping();
    assert.equal((await live(id)).length, 0);
  }
});

test("future, invalid, absent or expired retained evidence is never guessed into recovery", async () => {
  const blocked: string[] = [];
  for (const retry of [null, "60", -1, 1.5, 86401, {}, []]) {
    const id = await article(); blocked.push(id);
    await terminal(id, { retry });
  }
  const future = await article(); blocked.push(future);
  await terminal(future, { retry: 86400, age: 120 });
  const old = await article(); blocked.push(old);
  await terminal(old, { age: 27 * 3600 });
  blocked.push(await article());
  const missing = await article(); blocked.push(missing);
  const missingJob = await terminal(missing);
  await sql`UPDATE pgboss.job SET output='{"name":"BudgetExceededError"}'::jsonb WHERE id=${missingJob}`;
  await recoverBudgetBlockedGrouping();
  for (const id of blocked) assert.equal((await live(id)).length, 0);
});

test("pending and unknown grouping receipts block recovery without changing any receipt or attempt", async () => {
  const blocked: string[] = [];
  for (const purpose of ["group_article", "group_review", "group_signal"]) for (const status of ["pending", "unknown"]) {
    const id = await article(); blocked.push(id);
    await terminal(id);
    await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
      VALUES(${`${source}:${id}`},${source},${purpose},${`article:${id}${purpose === "group_review" ? ":fact:42" : ""}`},${status})`;
  }
  const before = await sql`SELECT * FROM receipts WHERE service=${source} ORDER BY id`;
  const attempts = await sql`SELECT * FROM receipt_attempts WHERE service=${source} ORDER BY id`;
  await recoverBudgetBlockedGrouping();
  for (const id of blocked) assert.equal((await live(id)).length, 0);
  assert.deepEqual([...await sql`SELECT * FROM receipts WHERE service=${source} ORDER BY id`], [...before]);
  assert.deepEqual([...await sql`SELECT * FROM receipt_attempts WHERE service=${source} ORDER BY id`], [...attempts]);
});

test("live jobs with any singleton block recovery, and one pass recovers no more than ten", async () => {
  const occupied = await article();
  await terminal(occupied);
  await enqueue(QUEUES.group, { articleId: occupied }, { singletonKey: `regroup:${occupied}` });
  const ready: string[] = [];
  for (let i = 0; i < 12; i++) { const id = await article(); ready.push(id); await terminal(id, { retry: 0 }); }
  const result = await recoverBudgetBlockedGrouping();
  assert.equal(result.requeued, 10);
  assert.equal((await live(occupied)).length, 1);
  let restored = 0;
  for (const id of ready) restored += (await live(id)).length;
  assert.equal(restored, 10);
});
