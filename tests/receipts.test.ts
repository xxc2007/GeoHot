// Paid requests: an answer already received is reused, the rate window counts every request actually sent
// (retries of one logical request included) while the spend windows count only what could have cost money,
// a lost answer is bought again at most once, an answer
// that parses but cannot be used is refused so the next round asks again, and the valve stops calls before
// they are sent.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { BudgetExceededError, completeReceipt, paidRequest, ReceiptUnknownError, rejectReceivedResponse } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  await provider.close();
  await closeDb();
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "socialdata", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("an answer that parses but cannot be used is refused, and the refusal outlives the caller completing it", async () => {
  // Deliberately before the budget case below: that one reads the attempts counted so far and leaves room
  // for exactly two sends, so this must not run after it.
  const subject = `usable-${tag()}`;
  const unusable = (d: { ok: boolean }) => (d.ok ? null : "结构对，但这条答复不能上版面");
  const askUsable = (usable: (d: { ok: boolean }) => string | null) =>
    chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }), usable });
  const statusOf = async (id: number) => (await sql<{ status: string; error: string }[]>`SELECT status, error FROM receipts WHERE id = ${id}`)[0];

  answer = () => '{"ok":false}';
  const before = provider.hits();
  const refused = await askUsable(unusable);
  assert.equal(refused.reused, false);
  assert.equal((await statusOf(refused.receiptId)).status, "failed", "形状对而不可用的答复不是可复放的好答案");
  assert.match(String((await statusOf(refused.receiptId)).error), /answer refused/);
  // Every caller completes the receipt it was handed; that must not book a refused answer as delivered.
  await completeReceipt(sql, refused.receiptId);
  assert.equal((await statusOf(refused.receiptId)).status, "failed");
  await askUsable(unusable);
  assert.equal(provider.hits() - before, 2, "拒收之后，同一份输入下一轮真的再问一次");

  answer = () => '{"ok":true}';
  const good = await askUsable(unusable);
  await completeReceipt(sql, good.receiptId);
  assert.equal((await statusOf(good.receiptId)).status, "completed");
  // A refusal never downgrades an answer already booked as delivered: it backs content the site shows, and
  // `failed` would make the same inputs be paid for a second time.
  await rejectReceivedResponse(good.receiptId, "这条不该改");
  assert.equal((await statusOf(good.receiptId)).status, "completed");
  const replay = await askUsable(unusable);
  assert.equal(replay.reused, true, "能用的好答案仍然复放，不重复付费");
  assert.equal(provider.hits() - before, 3, "只有被拒收的那一步再花了一次钱");
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => outcomes.push(error instanceof ModelOutputError ? "unusable" : error instanceof BudgetExceededError ? "budget" : String(error)),
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("an unknown outcome is released automatically once, so a lost answer costs at most one repeat", async () => {
  // A service without a budget row: the budget tests above may have used up deepseek's.
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  let sent = 0;
  const lost = () => {
    sent += 1;
    return Promise.reject(new Error("socket hang up after sending"));
  };
  const status = async () => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject = ${req.subject}`)[0]!.status;
  const age = () => sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${req.subject}`;

  await assert.rejects(paidRequest(req, lost));
  assert.equal(await status(), "unknown");
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "not within half an hour");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "failed");
  await assert.rejects(paidRequest(req, lost));
  assert.equal(sent, 2, "one repeat after the release");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "a second loss waits for the admin");
  await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
  assert.equal(sent, 2);
});

test("the spend windows count what cost money, not every attempt", async () => {
  // 第三十四轮评审：三个窗原先都数全部尝试。连不上/DNS/429 不产生账单，
  // 一次代理故障（每篇 5 步 × 重试 8 次）就能把当天额度烧光而一条中文稿都不产出。
  answer = () => '{"ok":true}';
  const t = tag();
  const [seed] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status, request, attempts)
    VALUES (${`unbilled-${t}`}, 'deepseek', 'invariant_test', 'failed', '{}'::jsonb, 1) RETURNING id`;
  const insert = (status: string, from: number, to: number) => sql`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status, started_at, finished_at)
    SELECT ${seed!.id}, n, 'deepseek', 'live', ${status}::text, now() - interval '2 hours', now() - interval '2 hours'
    FROM generate_series(${from}::int, ${to}::int) n`;
  const billed = sql`NOT (status = 'failed' AND usage IS NULL)`;
  const spend = async () => (await sql<{ hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 hour' AND ${billed})::int AS hour,
           count(*) FILTER (WHERE ${billed})::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`)[0]!;

  try {
    await insert("failed", 1, 300);
    const c = await spend();
    await sql`UPDATE budgets SET per_minute = 1000, per_hour = ${c.hour + 1}, per_day = ${c.day + 1} WHERE service = 'deepseek'`;
    const before = provider.hits();
    await ask(`unbilled-call-${t}`);
    assert.equal(provider.hits() - before, 1, "300 次没打到对方的尝试不该占花费额度");

    // 同样这 300 行，换成「结果说不清」（可能已经计费）就必须立刻算数。
    await sql`UPDATE receipt_attempts SET status = 'unknown' WHERE receipt_id = ${seed!.id}`;
    const d = await spend();
    await sql`UPDATE budgets SET per_hour = ${d.hour}, per_day = ${d.day} WHERE service = 'deepseek'`;
    assert.ok(d.day >= 300, "unknown 是花费：usage 是空的也不能免掉");
    await assert.rejects(() => ask(`unknown-call-${t}`), BudgetExceededError, "额度立刻不够，而不是被免单");
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE receipt_id = ${seed!.id}`;
    await sql`DELETE FROM receipts WHERE id = ${seed!.id}`;
  }
});
