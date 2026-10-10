import { stub, Reply, gate, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError, completeReceipt } from "@aihot/backend/providers/receipts";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";

const fixtureTag = `pool-recovery-${tag()}`;
const unique = () => `${fixtureTag}-${tag()}`;
const envNames = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_JSON_MODE", "LLM_VISION", "AGNES_CN_BASE_URL", "AGNES_CN_API_KEY", "AGNES_CN_MODEL", "AGNES_CN_JSON_MODE", "AGNES_CN_VISION", "PREFILTER_MODEL", "SCORE_MODEL", "LLM_EXTRA_JSON", "AGNES_CN_EXTRA_JSON"];
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let savedBudgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
let savedSettings: Array<{ key: string; value: unknown }> = [];
let failA = false;
let holdA: { promise: Promise<void>; open: (value: void) => void } | null = null;
let enteredA: { promise: Promise<void>; open: (value: void) => void } | null = null;
let holdB: { promise: Promise<void>; open: (value: void) => void } | null = null;
let enteredB: { promise: Promise<void>; open: (value: void) => void } | null = null;
let analysisAnswers = false;
let refuseScoreAt = 0;
let scoreCalls = 0;
const contentFor = (body: string) => {
  if (!analysisAnswers) return '{"ok":true}';
  const request = JSON.parse(body) as { messages: Array<{ content: string }> };
  if (request.messages[0]!.content.includes("宽召回")) return '{"label":"PASS","reason":"local test"}';
  scoreCalls += 1;
  if (scoreCalls === refuseScoreAt) return new Reply(400, { error: { code: "1301", message: "local contentFilter" } });
  return '{"attentionScore":80}';
};
const a = await stub(async (_hit, req) => {
  enteredA?.open();
  if (holdA) await holdA.promise;
  if (failA) return new Reply(503, { error: "local rejection" });
  const content = contentFor(req.body);
  return content instanceof Reply ? content : { choices: [{ message: { content } }] };
});
const b = await stub(async (_hit, req) => {
  enteredB?.open();
  if (holdB) await holdB.promise;
  const content = contentFor(req.body);
  return content instanceof Reply ? content : { choices: [{ message: { content } }] };
});
process.env.LLM_BASE_URL = `${a.url}/v1`;
process.env.LLM_API_KEY = "stub-only";
process.env.LLM_MODEL = "stub-a";
process.env.LLM_JSON_MODE = "true";
process.env.AGNES_CN_BASE_URL = `${b.url}/v1`;
process.env.AGNES_CN_API_KEY = "stub-only";
process.env.AGNES_CN_MODEL = "stub-b";
process.env.AGNES_CN_JSON_MODE = "true";
process.env.PREFILTER_MODEL = "default,agnes-3.0-flash-cn";
process.env.SCORE_MODEL = "default,agnes-3.0-flash-cn";
delete process.env.LLM_EXTRA_JSON;
delete process.env.AGNES_CN_EXTRA_JSON;
invalidateModelCache();

before(async () => {
  savedSettings = await sql<typeof savedSettings>`SELECT key, value FROM settings WHERE key IN ('models.prefilter', 'models.score')`;
  await sql`DELETE FROM settings WHERE key IN ('models.prefilter', 'models.score')`;
  invalidateModelCache();
  savedBudgets = await sql<typeof savedBudgets>`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('llm', 'agnes-cn')`;
  // Fixture capacity only: the production budgets are neither imported nor changed by this test.
  await sql`UPDATE budgets SET per_minute = 100000, per_hour = 100000, per_day = 100000 WHERE service IN ('llm', 'agnes-cn')`;
});

const ask = (model: string, subject: string, purpose = "prefilter_article", attemptTag?: string, maxTokens?: number) =>
  chatJson({ model, purpose, subject, promptVersion: "recovery-v1", system: "pool recovery", user: subject,
    schema: z.object({ ok: z.boolean() }), attemptTag, maxTokens });

after(async () => {
  holdA?.open();
  holdB?.open();
  await Promise.all([a.close(), b.close()]);
  await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`%${fixtureTag}%`})`;
  await sql`DELETE FROM receipts WHERE subject LIKE ${`%${fixtureTag}%`}`;
  for (const budget of savedBudgets) {
    await sql`UPDATE budgets SET per_minute = ${budget.per_minute}, per_hour = ${budget.per_hour}, per_day = ${budget.per_day} WHERE service = ${budget.service}`;
  }
  for (const setting of savedSettings) {
    await sql`INSERT INTO settings (key, value) VALUES (${setting.key}, ${sql.json(setting.value as never)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  }
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  invalidateModelCache();
  await closeDb();
});

test("answered prefilter survives a later failed score and health remapping, then recovery", async () => {
  let subject = "";
  for (let i = 0; i < 100; i++) {
    const id = `chain-${unique()}-${i}`;
    if (await modelFor("prefilter", id) === "default") { subject = id; break; }
  }
  assert.ok(subject);
  const initial = await ask(await modelFor("prefilter", subject), subject);
  failA = true;
  await assert.rejects(ask("default", subject, "score_article", "score-1"));
  failA = false;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, finished_at)
    SELECT ${initial.receiptId}, n + 100, 'llm', 'failed', now()
      FROM generate_series(1, (SELECT count(*)::int + 6 FROM receipt_attempts
        WHERE service = 'llm' AND origin = 'live' AND started_at > now() - interval '10 minutes')) n`;
  invalidateModelCache();
  const switched = await modelFor("prefilter", subject);
  assert.equal(switched, "agnes-3.0-flash-cn");
  const beforeA = a.hits(), beforeB = b.hits();
  const replay = await ask(switched, subject);
  assert.equal(replay.receiptId, initial.receiptId);
  assert.equal(replay.model, "default");
  assert.equal(replay.reused, true);
  assert.equal(a.hits(), beforeA);
  assert.equal(b.hits(), beforeB);
  const score = await ask(switched, subject, "score_article", "score-1");
  assert.equal(score.reused, false, "clearly rejected unfinished step can change service");
  await completeReceipt(sql, initial.receiptId);
  await sql`DELETE FROM receipt_attempts WHERE receipt_id = ${initial.receiptId} AND attempt > 100`;
  invalidateModelCache();
  const recovered = await ask(await modelFor("prefilter", subject), subject);
  assert.equal(recovered.receiptId, initial.receiptId);
  assert.equal(recovered.reused, true);
});

test("unknown candidate blocks another pool service", async () => {
  const subject = `unknown-${unique()}`;
  const first = await ask("default", subject);
  await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${first.receiptId}`;
  const hits = b.hits();
  await assert.rejects(ask("agnes-3.0-flash-cn", subject), ReceiptUnknownError);
  assert.equal(b.hits(), hits);
});

test("stale pending candidate becomes unknown instead of crossing services", async () => {
  const subject = `stale-${unique()}`;
  const first = await ask("default", subject);
  await sql`UPDATE receipts SET status = 'pending', updated_at = now() - interval '15 minutes' WHERE id = ${first.receiptId}`;
  await sql`UPDATE receipt_attempts SET status = 'pending', finished_at = NULL WHERE receipt_id = ${first.receiptId}`;
  const hits = b.hits();
  await assert.rejects(ask("agnes-3.0-flash-cn", subject), ReceiptUnknownError);
  assert.equal(b.hits(), hits);
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${first.receiptId}`;
  assert.equal(row!.status, "unknown");
});

test("received answer is safe to reuse when another candidate is unknown or lacks credentials", async () => {
  const subject = `prefer-answer-${unique()}`;
  process.env.PREFILTER_MODEL = "default";
  const first = await ask("default", subject);
  process.env.PREFILTER_MODEL = "agnes-3.0-flash-cn";
  const alternate = await ask("agnes-3.0-flash-cn", subject);
  process.env.PREFILTER_MODEL = "default,agnes-3.0-flash-cn";
  await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${alternate.receiptId}`;
  const hits = b.hits();
  delete process.env.LLM_API_KEY;
  try {
    const recovered = await ask("agnes-3.0-flash-cn", subject);
    assert.equal(recovered.receiptId, first.receiptId);
    assert.equal(recovered.model, "default");
    assert.equal(b.hits(), hits, "reusing existing answer creates no new attempt");
  } finally {
    process.env.LLM_API_KEY = "stub-only";
  }
});

test("concurrent requests on different pool members share the in-flight guard", async () => {
  const subject = `pending-${unique()}`;
  holdA = gate(); enteredA = gate();
  const first = ask("default", subject);
  try {
    await within(enteredA.promise);
    const hits = b.hits();
    await assert.rejects(ask("agnes-3.0-flash-cn", subject), ReceiptBusyError);
    assert.equal(b.hits(), hits);
  } finally {
    holdA.open(); holdA = null; enteredA = null;
  }
  const result = await first;
  assert.equal((await ask("agnes-3.0-flash-cn", subject)).receiptId, result.receiptId);
});

test("two independent scores remain two purchases with their separate attempt tags", async () => {
  const subject = `scores-${unique()}`;
  const first = await ask("default", subject, "score_article", "score-1");
  const second = await ask("agnes-3.0-flash-cn", subject, "score_article", "score-2");
  assert.notEqual(first.receiptId, second.receiptId);
  assert.equal((await ask("agnes-3.0-flash-cn", subject, "score_article", "score-1")).receiptId, first.receiptId);
  assert.equal((await ask("default", subject, "score_article", "score-2")).receiptId, second.receiptId);
});

test("candidate-specific reasoning and token parameters are reconstructed exactly", async () => {
  const subject = `params-${unique()}`;
  process.env.LLM_EXTRA_JSON = '{"reasoning_effort":"high"}';
  process.env.AGNES_CN_EXTRA_JSON = '{}';
  try {
    const first = await ask("default", subject, "prefilter_article", undefined, 512);
    const replay = await ask("agnes-3.0-flash-cn", subject, "prefilter_article", undefined, 512);
    assert.equal(replay.receiptId, first.receiptId, "old candidate keeps its own 6512-token identity");
    const changed = await ask("agnes-3.0-flash-cn", subject, "prefilter_article", undefined, 1024);
    assert.notEqual(changed.receiptId, first.receiptId, "token change is a new request");
    process.env.LLM_EXTRA_JSON = '{"reasoning_effort":"low"}';
    const newConfig = await ask("default", subject, "prefilter_article", undefined, 512);
    assert.notEqual(newConfig.receiptId, first.receiptId, "old high-effort receipt cannot satisfy low-effort candidate");
  } finally {
    delete process.env.LLM_EXTRA_JSON;
    delete process.env.AGNES_CN_EXTRA_JSON;
  }
});

test("single model switch does not silently recover a model outside its current configuration", async () => {
  const subject = `switch-${unique()}`;
  const first = await ask("default", subject);
  process.env.PREFILTER_MODEL = "agnes-3.0-flash-cn";
  try {
    const switched = await ask("agnes-3.0-flash-cn", subject);
    assert.notEqual(switched.receiptId, first.receiptId);
  } finally {
    process.env.PREFILTER_MODEL = "default,agnes-3.0-flash-cn";
  }
});

test("exact input, prompt, JSON mode and explicit rerun identity prevent false reuse", async () => {
  const subject = `identity-${unique()}`;
  const first = await ask("default", subject);
  const base = { model: "agnes-3.0-flash-cn", purpose: "prefilter_article", subject,
    promptVersion: "recovery-v1", system: "pool recovery", user: subject, schema: z.object({ ok: z.boolean() }) };
  for (const change of [{ user: `${subject} changed` }, { promptVersion: "recovery-v2" }, { json: false }, { attemptTag: "rerun" }]) {
    const result = await chatJson({ ...base, ...change });
    assert.notEqual(result.receiptId, first.receiptId);
    assert.equal(result.reused, false);
  }
});

const blockMinute = async (service: string) => {
  const [row] = await sql<{ used: number }[]>`SELECT count(*)::int AS used FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 minute'`;
  assert.ok(row!.used > 0, "previous localhost calls filled the test's observed minute window");
  await sql`UPDATE budgets SET per_minute = ${row!.used} WHERE service = ${service}`;
};
const resetMinutes = async () => sql`UPDATE budgets SET per_minute = 100000 WHERE service IN ('llm','agnes-cn')`;

test("local full minute window dispatches an unsent step to an available same-pool service", async () => {
  await blockMinute("llm");
  const subject = `budget-route-${unique()}`;
  const beforeA = a.hits(), beforeB = b.hits();
  try {
    const result = await ask("default", subject);
    assert.equal(result.model, "agnes-3.0-flash-cn");
    assert.equal(result.reused, false);
    assert.equal(a.hits(), beforeA);
    assert.equal(b.hits(), beforeB + 1);
    const [attempt] = await sql<{ service: string; model: string }[]>`SELECT service, model FROM receipt_attempts WHERE receipt_id = ${result.receiptId}`;
    assert.equal(attempt!.service, "agnes-cn");
    assert.equal(attempt!.model, "stub-b");
  } finally { await resetMinutes(); }
});

test("paid prefilter and first score replay with full budgets; only the missing second score dispatches", async () => {
  const subject = `partial-${unique()}`;
  const prefilter = await ask("default", subject);
  const firstScore = await ask("default", subject, "score_article", "score-1");
  await blockMinute("llm"); await blockMinute("agnes-cn");
  const beforeA = a.hits(), beforeB = b.hits();
  try {
    assert.equal((await ask("agnes-3.0-flash-cn", subject)).receiptId, prefilter.receiptId);
    assert.equal((await ask("agnes-3.0-flash-cn", subject, "score_article", "score-1")).receiptId, firstScore.receiptId);
    await sql`UPDATE budgets SET per_minute = 100000 WHERE service = 'agnes-cn'`;
    const secondScore = await ask("default", subject, "score_article", "score-2");
    assert.equal(secondScore.model, "agnes-3.0-flash-cn");
    assert.notEqual(secondScore.receiptId, firstScore.receiptId);
    assert.equal(a.hits(), beforeA);
    assert.equal(b.hits(), beforeB + 1);
  } finally { await resetMinutes(); }
});

test("all local budgets full creates no placeholder or paid attempt", async () => {
  await blockMinute("llm"); await blockMinute("agnes-cn");
  const subject = `all-blocked-${unique()}`;
  const beforeA = a.hits(), beforeB = b.hits();
  try {
    await assert.rejects(ask("default", subject), BudgetExceededError);
    assert.equal(a.hits(), beforeA); assert.equal(b.hits(), beforeB);
    const rows = await sql`SELECT id FROM receipts WHERE subject = ${subject}`;
    assert.equal(rows.length, 0);
  } finally { await resetMinutes(); }
});

test("an unknown candidate wins over local budget fallback and cannot be sent to a spare provider", async () => {
  const subject = `unknown-budget-${unique()}`;
  const first = await ask("default", subject);
  await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${first.receiptId}`;
  await blockMinute("llm");
  const beforeB = b.hits();
  try {
    await assert.rejects(ask("default", subject), ReceiptUnknownError);
    assert.equal(b.hits(), beforeB);
  } finally { await resetMinutes(); }
});

test("an external rejection never triggers immediate budget fallback", async () => {
  const subject = `http-failure-${unique()}`;
  const beforeA = a.hits(), beforeB = b.hits();
  failA = true;
  try {
    await assert.rejects(ask("default", subject), ProviderRejectedError);
    assert.equal(a.hits(), beforeA + 1); assert.equal(b.hits(), beforeB);
  } finally { failA = false; }
});

test("concurrent fallback claims one remaining service slot without overshooting its budget", async () => {
  await blockMinute("llm");
  const [row] = await sql<{ used: number }[]>`SELECT count(*)::int AS used FROM receipt_attempts
    WHERE service = 'agnes-cn' AND origin = 'live' AND started_at > now() - interval '1 minute'`;
  await sql`UPDATE budgets SET per_minute = ${row!.used + 1} WHERE service = 'agnes-cn'`;
  const beforeA = a.hits(), beforeB = b.hits();
  try {
    const results = await Promise.allSettled([ask("default", `race-a-${unique()}`), ask("default", `race-b-${unique()}`)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof BudgetExceededError);
    assert.equal(a.hits(), beforeA); assert.equal(b.hits(), beforeB + 1);
  } finally { await resetMinutes(); }
});

test("same logical step concurrently falling back creates exactly one paid attempt", async () => {
  await blockMinute("llm");
  const subject = `same-fallback-${unique()}`;
  const beforeB = b.hits();
  holdB = gate(); enteredB = gate();
  const first = ask("default", subject);
  try {
    await within(enteredB.promise);
    await assert.rejects(ask("default", subject), ReceiptBusyError);
    assert.equal(b.hits(), beforeB + 1);
  } finally {
    holdB.open(); holdB = null; enteredB = null;
    await resetMinutes();
  }
  const result = await first;
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${result.receiptId}`;
  assert.equal(count!.n, 1);
});

test("healthy text-only candidate cannot receive a multimodal budget fallback", async () => {
  await blockMinute("llm");
  process.env.LLM_VISION = "true";
  process.env.AGNES_CN_VISION = "false";
  const subject = `vision-${unique()}`;
  const opts = { model: "default", purpose: "prefilter_article", subject, promptVersion: "vision-v1", system: "vision",
    user: [{ type: "text" as const, text: subject }, { type: "image_url" as const, image_url: { url: "https://example.com/test.png" } }],
    schema: z.object({ ok: z.boolean() }) };
  const beforeB = b.hits();
  try {
    await assert.rejects(chatJson(opts), BudgetExceededError);
    assert.equal(b.hits(), beforeB);
    process.env.AGNES_CN_VISION = "true";
    assert.equal((await chatJson(opts)).model, "agnes-3.0-flash-cn");
    assert.equal(b.hits(), beforeB + 1);
  } finally {
    delete process.env.LLM_VISION; delete process.env.AGNES_CN_VISION;
    await resetMinutes();
  }
});

test("hour and day local budget windows use the same protected fallback", async () => {
  const [counts] = await sql<{ hour: number; day: number }[]>`SELECT
    count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
    count(*)::int AS day FROM receipt_attempts WHERE service='llm' AND origin='live'
      AND started_at > now()-interval '1 day' AND NOT (status='failed' AND usage IS NULL)`;
  assert.ok(counts!.hour > 0 && counts!.day > 0);
  try {
    await sql`UPDATE budgets SET per_hour = ${counts!.hour} WHERE service='llm'`;
    assert.equal((await ask("default", `hour-${unique()}`)).model, "agnes-3.0-flash-cn");
    await sql`UPDATE budgets SET per_hour = 100000, per_day = ${counts!.day} WHERE service='llm'`;
    assert.equal((await ask("default", `day-${unique()}`)).model, "agnes-3.0-flash-cn");
  } finally { await sql`UPDATE budgets SET per_hour=100000, per_day=100000 WHERE service='llm'`; }
});

test("all locally blocked candidates wait for the earliest real budget window", async () => {
  const [counts] = await sql<{ day: number }[]>`SELECT count(*)::int AS day FROM receipt_attempts
    WHERE service='llm' AND origin='live' AND started_at > now()-interval '1 day'
      AND NOT (status='failed' AND usage IS NULL)`;
  assert.ok(counts!.day > 0);
  const subject = `earliest-budget-${unique()}`;
  const beforeA = a.hits(), beforeB = b.hits();
  try {
    await sql`UPDATE budgets SET per_day=${counts!.day} WHERE service='llm'`;
    await blockMinute("agnes-cn");
    await assert.rejects(ask("default", subject), (error: unknown) => {
      assert.ok(error instanceof BudgetExceededError);
      assert.equal(error.service, "agnes-cn");
      assert.equal(error.retryAfterSeconds, 60);
      return true;
    });
    assert.equal(a.hits(), beforeA); assert.equal(b.hits(), beforeB);
    const [rows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE subject=${subject}`;
    assert.equal(rows!.n, 0, "local budget refusals create no attempt or receipt");
    await resetMinutes();
    assert.equal((await ask("default", subject)).model, "agnes-3.0-flash-cn");
    assert.equal(a.hits(), beforeA); assert.equal(b.hits(), beforeB + 1);
  } finally {
    await resetMinutes();
    await sql`UPDATE budgets SET per_day=100000 WHERE service='llm'`;
  }
});

test("real selection run reports actual score providers across partial-chain budget fallback", async () => {
  let id = "";
  for (let i = 0; i < 100; i++) {
    const candidate = `score-meta-${unique()}-${i}`;
    if (await modelFor("prefilter", candidate) === "default") { id = candidate; break; }
  }
  assert.ok(id);
  const input: AnalyzeInputArticle = { id, revision: 1, title: "A geographic dataset release", url: "https://example.com/meta",
    author: null, publishedAt: new Date("2026-02-01T00:00:00Z"), bodyText: "A geographic dataset release. ".repeat(30),
    bodyStatus: "ok", excerpt: null, xPost: null, media: [], source: { name: "local fixture", kind: "rss", tier: "T1", firstParty: true } };
  const [row] = await sql<{ used: number }[]>`SELECT count(*)::int AS used FROM receipt_attempts
    WHERE service='llm' AND origin='live' AND started_at > now()-interval '1 minute'`;
  await sql`UPDATE budgets SET per_minute=${row!.used + 2} WHERE service='llm'`;
  analysisAnswers = true;
  try {
    const result = await runAnalysis(input, { stages: "selection" });
    assert.deepEqual(result.scores!.values, [80,80]);
    assert.equal(result.scores!.model, "default,agnes-3.0-flash-cn");
    const scoreRows = await sql<{ service: string; logical_key: string }[]>`SELECT service, logical_key FROM receipts
      WHERE id=ANY(${result.scores!.receiptIds}::bigint[]) ORDER BY id`;
    assert.equal(scoreRows[0]!.service, "llm"); assert.ok(scoreRows[0]!.logical_key.endsWith(":score-1"));
    assert.equal(scoreRows[1]!.service, "agnes-cn"); assert.ok(scoreRows[1]!.logical_key.endsWith(":score-2"));
    const beforeA = a.hits(), beforeB = b.hits();
    const replay = await runAnalysis(input, { stages: "selection" });
    assert.deepEqual(replay.scores!.receiptIds, result.scores!.receiptIds);
    assert.equal(replay.scores!.model, result.scores!.model);
    assert.equal(a.hits(), beforeA); assert.equal(b.hits(), beforeB);
  } finally { analysisAnswers=false; await resetMinutes(); }
});

test("an unhealthy pool member is not used merely because its local budget has room", async () => {
  const seed = await ask("default", `sick-fallback-${unique()}`);
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, finished_at)
    SELECT ${seed.receiptId}, n+500, 'agnes-cn', 'failed', now()
      FROM generate_series(1, (SELECT count(*)::int+6 FROM receipt_attempts
        WHERE service='agnes-cn' AND origin='live' AND started_at>now()-interval '10 minutes')) n`;
  invalidateModelCache();
  await blockMinute("llm");
  const beforeB=b.hits();
  try {
    await assert.rejects(ask("default", `healthy-required-${unique()}`), BudgetExceededError);
    assert.equal(b.hits(), beforeB);
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE receipt_id=${seed.receiptId} AND attempt>500`;
    invalidateModelCache(); await resetMinutes();
  }
});

test("transport timeout records unknown without immediately trying another service", async () => {
  const subject=`transport-unknown-${unique()}`;
  holdA=gate(); enteredA=gate();
  const beforeA=a.hits(), beforeB=b.hits();
  const request=chatJson({ model:"default", purpose:"prefilter_article", subject, promptVersion:"transport-v1",
    system:"local timeout", user:subject, schema:z.object({ok:z.boolean()}), timeoutMs:150 });
  // Attach the rejection handler before waiting for the stub, so a timeout is always accounted for.
  const rejected=assert.rejects(request);
  try {
    await within(enteredA.promise);
    await rejected;
    assert.equal(a.hits(),beforeA+1); assert.equal(b.hits(),beforeB);
    const [row]=await sql<{status:string}[]>`SELECT status FROM receipts WHERE subject=${subject}`;
    assert.equal(row!.status,"unknown");
    await assert.rejects(chatJson({model:"agnes-3.0-flash-cn",purpose:"prefilter_article",subject,promptVersion:"transport-v1",
      system:"local timeout",user:subject,schema:z.object({ok:z.boolean()}),timeoutMs:150}), ReceiptUnknownError);
    assert.equal(b.hits(),beforeB);
  } finally {
    holdA.open(); holdA=null; enteredA=null;
  }
});

test("fallback score refusals report the actual provider and never try a third pool member", async () => {
  const third = await stub(() => ({ choices: [{ message: { content: '{"attentionScore":80}' } }] }));
  const names = ["DOTS_BASE_URL","DOTS_API_KEY","DOTS_MODEL"];
  const old = Object.fromEntries(names.map((name)=>[name,process.env[name]]));
  process.env.DOTS_BASE_URL=`${third.url}/v1`; process.env.DOTS_API_KEY="stub-only"; process.env.DOTS_MODEL="stub-third";
  process.env.PREFILTER_MODEL="default,agnes-3.0-flash-cn,dots3-note-prev";
  process.env.SCORE_MODEL="default,agnes-3.0-flash-cn,dots3-note-prev";
  analysisAnswers=true;
  try {
    for (const refusedAt of [1,2]) {
      let id="";
      for(let i=0;i<100;i++) {
        const candidate=`refused-meta-${unique()}-${i}`;
        if(await modelFor("prefilter",candidate)==="default") {id=candidate;break;}
      }
      assert.ok(id);
      const input:AnalyzeInputArticle={id,revision:1,title:`A geographic dataset release ${id}`,url:"https://example.com/refusal",
        author:null,publishedAt:new Date("2026-02-01T00:00:00Z"),bodyText:`A geographic dataset release ${id}. `.repeat(30),
        bodyStatus:"ok",excerpt:null,xPost:null,media:[],source:{name:"local refusal",kind:"rss",tier:"T1",firstParty:true}};
      const [row]=await sql<{used:number}[]>`SELECT count(*)::int AS used FROM receipt_attempts
        WHERE service='llm' AND origin='live' AND started_at>now()-interval '1 minute'`;
      await sql`UPDATE budgets SET per_minute=${row!.used+refusedAt} WHERE service='llm'`;
      refuseScoreAt=refusedAt; scoreCalls=0;
      const beforeA=a.hits(),beforeB=b.hits();
      const result=await runAnalysis(input,{stages:"selection"});
      assert.equal(result.scores!.refused,true,JSON.stringify({scores:result.scores,scoreCalls,refuseScoreAt,a:a.hits()-beforeA,b:b.hits()-beforeB,third:third.hits()}));
      assert.equal(result.scores!.values.length,refusedAt-1);
      assert.equal(result.scores!.model,refusedAt===1?"agnes-3.0-flash-cn":"default,agnes-3.0-flash-cn");
      assert.equal(a.hits(),beforeA+refusedAt); assert.equal(b.hits(),beforeB+1); assert.equal(third.hits(),0);
      const [refusal]=await sql<{service:string;status:string}[]>`SELECT service,status FROM receipts
        WHERE subject=${`article:${id}@1`} AND purpose='score_article' AND status='failed'`;
      assert.equal(refusal!.service,"agnes-cn"); assert.equal(refusal!.status,"failed");
      await resetMinutes();
    }
  } finally {
    analysisAnswers=false; refuseScoreAt=0; scoreCalls=0;
    process.env.PREFILTER_MODEL="default,agnes-3.0-flash-cn";
    process.env.SCORE_MODEL="default,agnes-3.0-flash-cn";
    for(const name of names) {if(old[name]===undefined) delete process.env[name]; else process.env[name]=old[name];}
    await resetMinutes(); await third.close();
  }
});
