// WorkBuddy's models think before they answer, and how long they think is a property of the model, not of
// the step that asks. deepseek-v4.1-flash spent 7,606 hidden tokens on GEOHOT's own selection-score prompt
// against a 6,000-token shared headroom, so its reply arrived empty with `finish_reason: length` and read
// as "No JSON object in model output" — a parser bug that was not there. Two things are pinned here: the
// preset's own headroom is what sizes the request, and a reply the cap cut off says so.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { UNDERSTAND_MAX_TOKENS, UNDERSTAND_TIMEOUT_MS } from "@aihot/backend/editorial/analyze";
import { chatJson, ModelOutputError, MODELS } from "@aihot/backend/providers/llm";

type Body = { model?: string; max_tokens?: number; reasoning_effort?: string };
let content = '{"ok":true}';
let finishReason: string | undefined;
let usageValue: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const bodies: Body[] = [];
const provider = await stub((_hit, req) => {
  bodies.push(JSON.parse(req.body) as Body);
  return {
    id: "stub",
    choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    usage: usageValue,
  };
});
const P = `workbuddy-headroom-${tag()}`;
Object.assign(process.env, {
  WORKBUDDY_BASE_URL: `${provider.url}/v1`, WORKBUDDY_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: `${provider.url}/v1`, DEEPSEEK_API_KEY: "test-key",
});

after(async () => {
  await sql`DELETE FROM receipts WHERE subject LIKE ${`${P}%`}`;
  await provider.close();
  await closeDb();
});

const ask = (model: string, name: string, maxTokens: number) =>
  chatJson({
    model, purpose: "invariant_test", subject: `${P}-${name}`, promptVersion: "t1",
    system: "s", user: `input ${name}`, schema: z.object({ ok: z.boolean() }), maxTokens,
  });
const capture = <T>(promise: Promise<T>) => promise.then(() => null, (error: unknown) => error as Error);
const statusOf = async (subject: string) =>
  (await sql<{ status: string; error: string }[]>`SELECT status, error FROM receipts WHERE subject = ${subject}`)[0]!;

test("the preset's own headroom sizes the request, not the shared default", async () => {
  await ask("workbuddy-deepseek-flash", "dsf", 2048);
  const dsf = bodies.at(-1)!;
  assert.equal(dsf.model, "deepseek-v4.1-flash", "the preset still names the upstream model");
  assert.equal(dsf.reasoning_effort, "max");
  assert.equal(dsf.max_tokens, 2048 + 16_000, "the chain has to fit under the cap the request asks for");

  await ask("deepseek-flash-think", "think", 2048);
  assert.equal(bodies.at(-1)!.max_tokens, 2048 + 6_000, "a preset without its own headroom keeps the shared one");

  // The cap is still a cap: the selection call sizes itself at 65,536 and is not pushed past it.
  await ask("workbuddy-deepseek-flash", "capped", 65_536);
  assert.equal(bodies.at(-1)!.max_tokens, 65_536);
});

test("both workbuddy presets carry the headroom and the vision verdict the measurement produced", () => {
  assert.equal(MODELS["workbuddy-deepseek-flash"]!.reasoningHeadroom, 16_000);
  assert.equal(MODELS["workbuddy-hy3"]!.reasoningHeadroom, 16_000);
  // deepseek-v4.1-flash reads images; hy3 tokenizes one and then answers the wrong colour.
  assert.equal(MODELS["workbuddy-deepseek-flash"]!.vision, true);
  assert.equal(MODELS["workbuddy-hy3"]!.vision, false);
});

test("a reply the cap cut off says what it cost, instead of reading as a parse bug", async () => {
  const subject = `${P}-cut-off`;
  content = "";
  finishReason = "length";
  usageValue = { prompt_tokens: 351, completion_tokens: 26_048, total_tokens: 26_399, completion_tokens_details: { reasoning_tokens: 26_048 } };
  try {
    const error = await capture(ask("workbuddy-deepseek-flash", "cut-off", 2048));
    assert.ok(error instanceof ModelOutputError, `expected ModelOutputError, got ${String(error)}`);
    assert.match(error.message, /unusable output for .*No JSON object in model output/);
    assert.match(error.message, /finish_reason: length after 26048 completion tokens \(26048 of them hidden chain\)/);

    const receipt = await statusOf(subject);
    assert.equal(receipt.status, "failed", "a cut-off answer is not a delivered one");
    assert.match(receipt.error, /^unusable output:/, "the refusal prefix the ledger counts on still matches");
    assert.match(receipt.error, /finish_reason: length after 26048 completion tokens/);
  } finally {
    content = '{"ok":true}';
    finishReason = undefined;
  }
});

test("an unusable answer that was not cut off carries no truncation note", async () => {
  const subject = `${P}-malformed`;
  content = "sorry, not json";
  finishReason = undefined;
  try {
    const error = await capture(ask("workbuddy-deepseek-flash", "malformed", 2048));
    assert.ok(error instanceof ModelOutputError, `expected ModelOutputError, got ${String(error)}`);
    assert.match(error.message, /No JSON object in model output/);
    assert.doesNotMatch(error.message, /finish_reason: length/);
    const receipt = await statusOf(subject);
    assert.match(receipt.error, /^unusable output:/);
    assert.doesNotMatch(receipt.error, /finish_reason: length/, "a parse failure is not a truncation");
  } finally {
    content = '{"ok":true}';
  }
});

test("the headroom clears the chains we measured, and understand's clock clears its cap", () => {
  // The two halves of why the number is 16,000, so that raising it has to argue with the second half.
  //
  // Big enough: over a 30 h production window the longest *successful* reply each step got back ran 7,007
  // completion tokens on score, 6,760 on structure, 7,834 on summarize and 21,172 on understand. The first
  // three are cleared by the headroom alone; understand is not, which is why what has to fit there is the
  // step's own budget plus the headroom.
  //
  // Not too big: the cap must fire before the clock does. A cap that binds lands `failed` — retried, and the
  // receipt says it was cut off. An abort lands `unknown`: the call is paid for, the answer is gone, and an
  // operator has to release it. These models measured 4.9-6.7 ms per output token, so at the slow end the
  // widest request the step can make still has to fit inside the step's timeout.
  const MS_PER_TOKEN = 6.72;
  const LONGEST_SUCCESSFUL = { score: 7_007, structure: 6_760, summarize: 7_834 };
  for (const key of ["workbuddy-deepseek-flash", "workbuddy-hy3"]) {
    const headroom = MODELS[key]!.reasoningHeadroom!;
    for (const [step, longest] of Object.entries(LONGEST_SUCCESSFUL)) {
      assert.ok(headroom > longest, `${key} on ${step}: a ${headroom}-token headroom does not clear the longest chain seen, ${longest}`);
    }
    const widest = UNDERSTAND_MAX_TOKENS + headroom;
    const seconds = Math.round((widest * MS_PER_TOKEN) / 1000);
    assert.ok(
      widest * MS_PER_TOKEN < UNDERSTAND_TIMEOUT_MS,
      `${key}: understand's widest request is ${widest} tokens, about ${seconds} s at ${MS_PER_TOKEN} ms/token, ` +
        `which is past its ${UNDERSTAND_TIMEOUT_MS / 1000} s clock — the cap would never fire and every long reply would land unknown`,
    );
  }
});
