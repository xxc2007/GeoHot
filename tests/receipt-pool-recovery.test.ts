import { stub, Reply, gate, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { ReceiptBusyError, ReceiptUnknownError, completeReceipt } from "@aihot/backend/providers/receipts";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";

const fixtureTag = `pool-recovery-${tag()}`;
const unique = () => `${fixtureTag}-${tag()}`;
const envNames = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_JSON_MODE", "AGNES_CN_BASE_URL", "AGNES_CN_API_KEY", "AGNES_CN_MODEL", "AGNES_CN_JSON_MODE", "PREFILTER_MODEL", "SCORE_MODEL", "LLM_EXTRA_JSON", "AGNES_CN_EXTRA_JSON"];
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let savedBudgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
let savedSettings: Array<{ key: string; value: unknown }> = [];
let failA = false;
let holdA: { promise: Promise<void>; open: (value: void) => void } | null = null;
let enteredA: { promise: Promise<void>; open: (value: void) => void } | null = null;
const a = await stub(async () => {
  enteredA?.open();
  if (holdA) await holdA.promise;
  return failA ? new Reply(503, { error: "local rejection" }) : { choices: [{ message: { content: '{"ok":true}' } }] };
});
const b = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
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
