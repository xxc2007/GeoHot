import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel, readModelUsage } from "../packages/backend/src/admin/models.ts";
import { modelStatisticRead, statisticReader } from "../packages/backend/src/admin/model-statistics-read.ts";

after(closeDb);

test("model statistics coalesce concurrent refreshes, cache successes and cool down failures", async () => {
  let time = 0, calls = 0;
  let release!: (rows: number[]) => void;
  const reader = statisticReader(() => { calls++; return new Promise<number[]>(resolve => { release = resolve; }); }, () => [], () => time);
  const first = reader(), second = reader();
  await Promise.resolve();
  assert.equal(calls, 1);
  release([3]);
  assert.deepEqual(await first, await second);
  assert.deepEqual((await reader()).rows, [3]);
  assert.equal(calls, 1);
  time = 30_001;
  const fresh = reader();
  await Promise.resolve();
  assert.equal(calls, 2);
  release([4]);
  assert.deepEqual((await fresh).rows, [4]);

  let failures = 0;
  const failing = statisticReader(async () => { failures++; throw new Error("private SQL details"); }, () => [], () => time);
  const unavailable = await failing();
  assert.equal(unavailable.status.state, "unavailable");
  assert.equal(unavailable.status.asOf, null);
  assert.doesNotMatch(unavailable.status.message!, /private SQL/);
  await failing();
  assert.equal(failures, 1);
  time += 5_001;
  await failing();
  assert.equal(failures, 2);
});

test("database cancels statistics and transaction limits cannot leak into later writes", async () => {
  await assert.rejects(modelStatisticRead(async db => { await db`SELECT pg_sleep(2)`; }, 50), (e: unknown) => (e as { code: string }).code === "57014");
  const [settings] = await sql`SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS readonly`;
  assert.equal(settings!.timeout, "0");
  assert.equal(settings!.readonly, "off");
  const running = await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query='SELECT pg_sleep(2)'`;
  assert.equal(running.length, 0, "the timed out query really stopped in PostgreSQL");
  await assert.rejects(modelStatisticRead(async db => { await db`CREATE TABLE forbidden_model_stat_write(id int)`; }), (e: unknown) => (e as { code: string }).code === "25006");
});

test("receipt-label materialization preserves attempts, exact percentiles, versions, origins and billing", async () => {
  await sql.begin(async db => {
    await db`CREATE TEMP TABLE receipts(id int, purpose text, service text, request jsonb) ON COMMIT DROP`;
    await db`CREATE TEMP TABLE receipt_attempts(receipt_id int, model text, status text, latency_ms int, usage jsonb, cost numeric, cost_basis text, currency text, started_at timestamptz, origin text) ON COMMIT DROP`;
    await db`INSERT INTO receipts VALUES
      (1,'score_article','door-a',jsonb_build_object('promptVersion','v1','prompt',repeat(md5('large prompt'),2000))),
      (2,'score_article','door-a','{"promptVersion":"v2"}'),
      (3,'score_article','door-b','{}'),
      (4,'translate_body','door-b',NULL)`;
    await db`INSERT INTO receipt_attempts VALUES
      (1,'same','received',10,'{"prompt_tokens":100,"completion_tokens":20}',0.3,'actual','USD',now(),'live'),
      (1,'same','failed',100,'{"prompt_tokens":50}',0.4,'estimated','USD',now(),'live'),
      (1,'same','unknown',NULL,NULL,NULL,NULL,NULL,now(),'live'),
      (1,'same','pending',200,NULL,NULL,NULL,NULL,now(),'live'),
      (2,'same','received',300,'{"completion_tokens":8}',0.1,'actual','USD',now(),'live'),
      (3,'same','unknown',90,NULL,NULL,NULL,NULL,now(),'live'),
      (4,'other','received',20,NULL,2,'actual','CNY',now(),'live'),
      (1,'same','received',999,NULL,5,'actual','USD',now(),'replay'),
      (1,'same','received',999,NULL,5,'actual','USD',now()-interval '8 days','live'),
      (1,NULL,'received',999,NULL,5,'actual','USD',now(),'live')`;
    const since = new Date(Date.now() - 7 * 86400_000);
    const rewritten = await readModelUsage(db, since);
    const original = await db`
      SELECT r.purpose,r.service,a.model,r.request->>'promptVersion' AS prompt_version,count(*)::int AS calls,
        count(*) FILTER(WHERE a.status='received')::int AS ok,
        count(*) FILTER(WHERE a.status='failed')::int AS failed,
        count(*) FILTER(WHERE a.status='unknown')::int AS unknown,
        percentile_disc(0.5) WITHIN GROUP(ORDER BY a.latency_ms) AS p50,
        percentile_disc(0.95) WITHIN GROUP(ORDER BY a.latency_ms) AS p95,
        sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in,sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
        sum(a.cost) FILTER(WHERE a.cost_basis='actual') AS actual_cost,max(a.currency) AS currency
      FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
      WHERE a.started_at>=${since} AND a.origin='live' AND a.model IS NOT NULL
      GROUP BY 1,2,3,4 ORDER BY 1,5 DESC`;
    const sorted = (rows: readonly object[]) => [...rows].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(sorted(rewritten), sorted(original));
    const v1 = rewritten.find(row => row.prompt_version === 'v1')!;
    assert.equal(v1.calls, 4);
    assert.equal(v1.unknown, 1);
    assert.equal(v1.p50, 100);
    assert.equal(v1.p95, 200);
    assert.equal(Number(v1.tokens_in), 150);
    assert.equal(Number(v1.actual_cost), 0.3);
  });
});


test("cached measurements cannot hide a new model switch or its audit history", async () => {
  const saved = await sql`SELECT value, updated_by FROM settings WHERE key='models.score'`;
  const actor = "model-statistics-test-" + Date.now();
  try {
    await sql`DELETE FROM settings WHERE key='models.score'`;
    invalidateModelCache();
    const before = await modelsOverview();
    await switchModel("score", "default", "fresh switch test", actor);
    const after = await modelsOverview();
    assert.equal(after.capabilities.find(c => c.key === "score")!.current.source, "admin");
    assert.equal(after.capabilities.find(c => c.key === "score")!.current.model, "default");
    assert.equal(after.statistics.usage.asOf, before.statistics.usage.asOf, "measurements are reused independently of configuration");
    assert.ok(after.history.some(row => row.actor === actor), "audit history is read after the switch");
  } finally {
    await sql`DELETE FROM settings WHERE key='models.score'`;
    if (saved[0]) await sql`INSERT INTO settings(key,value,updated_by) VALUES('models.score',${sql.json(saved[0].value)},${saved[0].updated_by})`;
    await sql`DELETE FROM audit_log WHERE actor=${actor}`;
    invalidateModelCache();
  }
});
