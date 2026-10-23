// The Qoder CN door. Everything here is a measurement written down, because this channel breaks two of the
// assumptions the rest of `llm.ts` is built on and a future reader must not have to rediscover them:
//
//  1. It ignores `max_tokens`. Asked for 200 it answered with 3,231 completion tokens; for 16 it answered
//     1,817; for `max_completion_tokens: 16` it answered 11,991. `reasoningHeadroom` therefore cannot do the
//     job it does on every other door — it cannot make the cap fire before the clock, because there is no
//     working cap. What is pinned below is the shape the rest of the file expects (so a `finish_reason:
//     length` would still be reported if it ever came) plus the one bound that does hold: the per-step
//     `timeoutMs` the callers pass. The rates in the arithmetic test are the argument for why the tightest
//     of those clocks still clears this model's longest measured chain.
//  2. Its quota is the operator's own subscription, counted in a five-hour window, so it carries a budget
//     row of its own (`0074_qoder_cn_budget.sql`). If it rode `llm`, exhausting it would report Agnes as the
//     provider that stopped.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { UNDERSTAND_MAX_TOKENS, UNDERSTAND_TIMEOUT_MS } from "@aihot/backend/editorial/analyze";
import { CAPABILITIES } from "@aihot/backend/editorial/models";
import { chatJson, headroomFor, MODELS } from "@aihot/backend/providers/llm";
import { providerName } from "@aihot/backend/operations/alerts";

type Body = { model?: string; max_tokens?: number; reasoning_effort?: string; response_format?: { type?: string } };
const bodies: Body[] = [];
const provider = await stub((_hit, req) => {
  bodies.push(JSON.parse(req.body) as Body);
  return {
    id: "stub",
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
});
const P = `qoder-cn-presets-${tag()}`;
Object.assign(process.env, {
  QODER_CN_BASE_URL: `${provider.url}/v1`, QODER_CN_API_KEY: "test-key",
});

after(async () => {
  await sql`DELETE FROM receipts WHERE subject LIKE ${`${P}%`}`;
  await provider.close();
  await closeDb();
});

const ask = (model: string, name: string, maxTokens = 2_048, purpose = "invariant_test") =>
  chatJson({
    model, purpose, subject: `${P}-${name}`, promptVersion: "t1",
    system: "s", user: `input ${name}`, schema: z.object({ ok: z.boolean() }), maxTokens,
  });

test("each preset names its own upstream model and only the effort spelling that model advertises", async () => {
  // dfmodel advertises low/high/max; qfmodel advertises low/medium/xhigh. Sending dfmodel's spelling to
  // qfmodel (or the reverse) is a silent downgrade, so the two are written differently on purpose.
  await ask("qoder-cn-dfmodel", "df");
  const df = bodies.at(-1)!;
  assert.equal(df.model, "qoder-cn/dfmodel", "the preset sends the id the gateway routes on");
  assert.equal(df.reasoning_effort, "max");
  assert.equal(df.response_format?.type, "json_object", "jsonMode is on: the editorial steps parse JSON");

  await ask("qoder-cn-qfmodel", "qf");
  const qf = bodies.at(-1)!;
  assert.equal(qf.model, "qoder-cn/qfmodel");
  assert.equal(qf.reasoning_effort, "xhigh", "qfmodel's strongest effort is xhigh, not max");
});

test("both presets ride one service, so exhausting the operator's window trips one breaker and not Agnes's", () => {
  for (const key of ["qoder-cn-dfmodel", "qoder-cn-qfmodel"] as const) {
    assert.equal(MODELS[key]!.service, "qoder-cn", `${key} must not spend another door's breaker`);
    assert.equal(MODELS[key]!.baseUrlEnv, "QODER_CN_BASE_URL");
    assert.equal(MODELS[key]!.apiKeyEnv, "QODER_CN_API_KEY");
    assert.equal(MODELS[key]!.vision, true, "a 1x1 PNG was read back as its colour through this gateway");
  }
  // The preset keys are distinct from every other door's, or `modelFor` would resolve the wrong breaker
  // (see the workbuddy pair for the same argument).
  const keys = Object.keys(MODELS);
  assert.equal(keys.filter((k) => k === "qoder-cn-dfmodel").length, 1);
  assert.equal(keys.filter((k) => k === "qoder-cn-qfmodel").length, 1);
});

test("the presets carry the per-purpose table because a flat number would truncate summarize", () => {
  // Copied from workbuddy-deepseek-flash deliberately: the editorial steps ask the same sizes, and the
  // summarize prompt is the same heavy-tailed one (18,809-token chain measured there). On this door the
  // headroom cannot actually truncate anything — the gateway ignores the cap — but the table keeps the
  // receipt identity and the reported `finish_reason` honest, and it is what a working cap would need.
  for (const key of ["qoder-cn-dfmodel", "qoder-cn-qfmodel"] as const) {
    assert.deepEqual(MODELS[key]!.reasoningHeadroom, { default: 16_000, summarize_article: 32_000, translate_quoted: 8_000 });
  }
});

test("this door can serve every step, including the three the slow glm door had to be excluded from", () => {
  // Measured on the workstation 2026-10-20: a 9,649-token prompt produced a 21,006-token completion
  // (14,127 of them hidden chain) in 80.8 s, i.e. 3.85 ms per output token — the fastest rate of any door in
  // llm.ts (deepseek-v4.1-flash 4.9-6.7, step-5-preview 9.49, glm 17.80). The exclusion of glm from
  // UNDERSTAND_MODEL and TRANSLATE_MODEL was pure arithmetic: 16,384 tokens at 17.8 ms is 292 s against a
  // 240 s clock. At this rate the same ask is about 63 s, so the meeting point that forced glm out does not
  // bind here. Pinned so that a slower measurement invalidates the claim instead of silently degrading.
  const MS_PER_TOKEN = 6.54; // the slow end of the 3.85-6.54 ms band this door measured
  const SERVED = [
    { step: "understand", asked: UNDERSTAND_MAX_TOKENS, clock: UNDERSTAND_TIMEOUT_MS },
    { step: "translate body", asked: 8_000, clock: 180_000 },
    { step: "translate quoted", asked: 4_000, clock: 120_000 },
    { step: "summarize", asked: 2_048, clock: 240_000 },
    { step: "score", asked: 1_024, clock: 240_000 },
    { step: "structure", asked: 800, clock: 240_000 },
    { step: "prefilter", asked: 512, clock: 240_000 },
  ];
  for (const { step, asked, clock } of SERVED) {
    const widest = asked + headroomFor(MODELS["qoder-cn-dfmodel"]!, step.replace(" ", "_"));
    const seconds = Math.round((widest * MS_PER_TOKEN) / 1000);
    assert.ok(
      widest * MS_PER_TOKEN < clock,
      `${step}: ${widest} tokens is about ${seconds} s at ${MS_PER_TOKEN} ms/token, past its ${clock / 1000} s clock`,
    );
  }
  // 对照项本身也要仍然成立，否则上面那组断言什么也没证明。2026-10-21: glm 的两扇门已从注册表删除，
  // 所以这条对照改成量**当前池里最慢的那把**（step-5-preview, 9.49 ms/token）在同一个 understand 时钟下
  // 的余量：它比这扇门慢一倍多，若它都装得下，这扇门自然是宽裕的；若哪天它装不下，这段对照就该重写。
  const slowest = UNDERSTAND_MAX_TOKENS + headroomFor(MODELS["workbuddy-step5-preview"]!, "understand_article");
  assert.ok(
    slowest * 9.49 > UNDERSTAND_MAX_TOKENS * MS_PER_TOKEN,
    "the comparison is stale: the slowest door is not actually slower than this one",
  );
});

test("every capability this door can serve is one whose output the editorial steps can parse", () => {
  // `usable()` rejects a `jsonMode: false` preset for the ten JSON capabilities and keeps it only for the
  // free-text one (summarize — its answer is prose, not a schema). Translate is *not* free text: it returns
  // `{body_html, body_text}` and is parsed. This door answers JSON, so declaring jsonMode true keeps it usable
  // for both kinds; declaring false would silently bench it from ten of the eleven steps.
  const FREE_TEXT = Object.entries(CAPABILITIES).filter(([, c]) => "freeText" in c && c.freeText).map(([k]) => k);
  assert.deepEqual(FREE_TEXT, ["summarize"], "the free-text capability set moved; re-read usable()");
  const KEYED = Object.entries(CAPABILITIES).filter(([, c]) => "freeText" in c && c.freeText).length;
  assert.equal(Object.keys(CAPABILITIES).length - KEYED, 10, "ten of the eleven capabilities demand parseable JSON");
  for (const key of ["qoder-cn-dfmodel", "qoder-cn-qfmodel"] as const) {
    assert.notEqual(MODELS[key]!.jsonMode, false, `${key} answers JSON, so it must stay usable for those ten steps`);
  }
});

test("the door is named for humans, and its budget row exists so the breaker is not silently unlimited", async () => {
  // Without a budgets row `checkBudget` throws BudgetExceededError("missing") on the first paid call —
  // a stopped door, not a free one. The row is what makes the exhaustion visible instead of mysterious.
  assert.equal(providerName("qoder-cn"), "Qoder CN（工作站 maggie 网关）");
  const rows = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service = 'qoder-cn'`;
  assert.equal(rows.length, 1, "0074_qoder_cn_budget.sql did not seed the row");
  assert.equal(rows[0]!.per_minute, 60, "0075 preserves the integrated local budget; it is not an official provider rate guarantee");
  assert.equal(rows[0]!.per_hour, 3_600, "0075 preserves the integrated local hourly budget without resetting receipts");
  assert.equal(rows[0]!.per_day, 12_000);
  // The receipt must name the door, not the upstream: service is what the breaker and the health ledger key on.
  const receipt = await sql<{ service: string; model: string }[]>`
    SELECT service, model FROM receipts WHERE subject = ${`${P}-df`}`;
  assert.equal(receipt[0]!.service, "qoder-cn");
  assert.equal(receipt[0]!.model, "qoder-cn/dfmodel");
});
