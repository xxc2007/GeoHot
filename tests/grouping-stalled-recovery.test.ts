import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { recoverBudgetBlockedGrouping, recoverStalledGrouping } from "@aihot/backend/operations/recover-grouping";

const source = `group-stall-${tag()}`;
const ids: string[] = [];
before(async () => {
  await ensureQueue(QUEUES.group);
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},${source},'rss')`;
});
after(async () => {
  await sql`DELETE FROM audit_log WHERE action IN ('grouping.stall-recovery','grouping.budget-recovery') AND subject=ANY(${ids.map(id=>`article:${id}`)})`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids})`;
  await sql`DELETE FROM receipts WHERE service=${source}`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss();
  await closeDb();
});
async function article() {
  const id = `gs-${tag()}`;
  ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${source},${id},${`https://example.com/${id}`},'Grouping stall recovery',now(),now())`;
  await sql`INSERT INTO regroup_pending(article_id) VALUES(${id})`;
  return id;
}
async function terminal(id: string, opts: { state?: string; error?: string; retry?: unknown; age?: number; signalOnly?: boolean } = {}) {
  const job = await enqueue(QUEUES.group, { articleId: id, ...(opts.signalOnly ? { signalOnly: true } : {}) }, { singletonKey: id });
  assert.ok(job);
  await sql`UPDATE pgboss.job SET state=${opts.state ?? "failed"}::pgboss.job_state,
    completed_on=now()-${opts.age ?? 7200} * interval '1 second',
    output=${sql.json({ name: opts.error ?? "BudgetExceededError", retryAfterSeconds: opts.retry === undefined ? 60 : opts.retry } as never)}
    WHERE id=${job}`;
  return job;
}
const live = (id: string) => sql`SELECT name,data,singleton_key FROM pgboss.job
  WHERE name=${QUEUES.group} AND data->>'articleId'=${id} AND state IN ('created','retry','active')`;
const clearLive = (id: string) => sql`DELETE FROM pgboss.job
  WHERE name=${QUEUES.group} AND data->>'articleId'=${id} AND state IN ('created','retry','active')`;

test("a non-budget failure regains one forced regroup on the original singleton, atomically and once", async () => {
  for (const error of ["ProviderRejectedError", "ModelOutputError", "ReceiptUnknownError"]) {
    const id = await article();
    await terminal(id, { error, age: 2 * 3600 });
    await Promise.all([recoverStalledGrouping(), recoverStalledGrouping()]);
    const jobs = await live(id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.singleton_key, id);
    assert.deepEqual(jobs[0]!.data, { articleId: id, force: true });
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='grouping.stall-recovery' AND subject=${`article:${id}`}`).length,1);
    // The consumer decides success; until then the pending row stays and the pass does not double-enqueue.
    await recoverStalledGrouping();
    assert.equal((await live(id)).length, 1);
    assert.equal((await sql`SELECT article_id FROM regroup_pending WHERE article_id=${id}`).length, 1);
    await clearLive(id);
  }
});

test("an unexpired or expired budget deferral belongs to the budget variant alone", async () => {
  // Unexpired: neither variant requeues it, and the two candidate sets stay a partition.
  const fresh = await article();
  await terminal(fresh, { error: "BudgetExceededError", retry: 60, age: 30 });
  const expired = await article();
  await terminal(expired, { error: "BudgetExceededError", retry: 60, age: 2 * 3600 });
  await recoverStalledGrouping();
  assert.equal((await live(fresh)).length, 0, "the stalled variant never grabs budget evidence");
  const stallResult = await recoverStalledGrouping();
  assert.equal(stallResult.requeued, 0);
  const budgetResult = await recoverBudgetBlockedGrouping();
  assert.equal(budgetResult.requeued, 1, "only the expired deferral, and only through the budget variant");
  const jobs = await live(expired);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.singleton_key, expired);
  await clearLive(expired);
  // Still untouched by the stalled variant afterwards: the latest evidence is a budget deferral.
  await recoverStalledGrouping();
  assert.equal((await live(expired)).length, 0);
});

test("a completed latest run whose pending row survived is recovered after a short cooldown", async () => {
  const id = await article();
  // pg-boss stamps `completed_on` when the job finishes, so "just completed" is age 0. Reusing the
  // two-hour-old stamp the failure fixtures want would backdate the completion and hand the row to the
  // ten-minute rule, which is the opposite of what this case is about.
  await terminal(id, { age: 0 });
  // The successful decision deletes the row; a delete that failed after success leaves this state.
  await sql`UPDATE pgboss.job SET state='completed'::pgboss.job_state, output='{}'::jsonb WHERE data->>'articleId'=${id} AND name=${QUEUES.group}`;
  await recoverStalledGrouping();
  assert.equal((await live(id)).length, 0, "the ten-minute cooldown keeps the pass off a just-deleted row");
  await sql`UPDATE pgboss.job SET completed_on=now()-interval '20 minutes' WHERE data->>'articleId'=${id} AND name=${QUEUES.group}`;
  await Promise.all([recoverStalledGrouping(), recoverStalledGrouping()]);
  assert.equal((await live(id)).length, 1);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='grouping.stall-recovery' AND subject=${`article:${id}`}`).length,1);
  await clearLive(id);
});

test("a fresh failure waits out the queue's own retries; an hour-old one does not", async () => {
  const fresh = await article();
  await terminal(fresh, { error: "ProviderRejectedError", age: 30 * 60 });
  const stale = await article();
  await terminal(stale, { error: "ProviderRejectedError", age: 3600 });
  await recoverStalledGrouping();
  assert.equal((await live(fresh)).length, 0);
  assert.equal((await live(stale)).length, 1);
  await clearLive(stale);
});

test("pending and unknown grouping receipts block stall recovery without changing any receipt or attempt", async () => {
  const blocked: string[] = [];
  for (const purpose of ["group_article", "group_review", "group_signal"]) for (const status of ["pending", "unknown"]) {
    const id = await article(); blocked.push(id);
    await terminal(id, { error: "ProviderRejectedError" });
    await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
      VALUES(${`${source}:${id}`},${source},${purpose},${`article:${id}${purpose === "group_review" ? ":fact:42" : ""}`},${status})`;
  }
  const before = await sql`SELECT * FROM receipts WHERE service=${source} ORDER BY id`;
  const attempts = await sql`SELECT * FROM receipt_attempts WHERE service=${source} ORDER BY id`;
  await recoverStalledGrouping();
  for (const id of blocked) assert.equal((await live(id)).length, 0);
  assert.deepEqual([...await sql`SELECT * FROM receipts WHERE service=${source} ORDER BY id`], [...before]);
  assert.deepEqual([...await sql`SELECT * FROM receipt_attempts WHERE service=${source} ORDER BY id`], [...attempts]);
});

test("live jobs with any singleton block stall recovery, and one pass recovers no more than ten", async () => {
  const occupied = await article();
  await terminal(occupied, { error: "ProviderRejectedError" });
  await enqueue(QUEUES.group, { articleId: occupied }, { singletonKey: `regroup:${occupied}` });
  const ready: string[] = [];
  for (let i = 0; i < 12; i++) { const id = await article(); ready.push(id); await terminal(id, { error: "ProviderRejectedError", age: 2 * 3600 }); }
  const result = await recoverStalledGrouping();
  assert.equal(result.requeued, 10);
  assert.equal((await live(occupied)).length, 1);
  let restored = 0;
  for (const id of ready) restored += (await live(id)).length;
  assert.equal(restored, 10);
});
