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
import { chatJson, headroomFor, ModelOutputError, MODELS } from "@aihot/backend/providers/llm";

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
  WORKBUDDY_CN_BASE_URL: `${provider.url}/v1`, WORKBUDDY_CN_API_KEY: "test-key",
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

test("a per-purpose headroom is chosen by the purpose, and defaults where the table has no entry", async () => {
  // summarize_article is the one purpose deepseek-v4.1-flash needs more room on (measured chain 18,809
  // against a 2,048-token ask). `ask()` above sends purpose "invariant_test", which the table does not
  // name, so the request must fall back to the table's `default` — not to the shared 6,000.
  await ask("workbuddy-deepseek-flash", "per-purpose-default", 2_048);
  assert.equal(bodies.at(-1)!.max_tokens, 2_048 + 16_000, "an unnamed purpose takes the table's default");

  const summarize = await chatJson({
    model: "workbuddy-deepseek-flash", purpose: "summarize_article", subject: `${P}-per-purpose-sum`,
    promptVersion: "t1", system: "", user: "input per-purpose-sum",
    schema: z.object({ ok: z.boolean() }), maxTokens: 2_048, json: false,
  });
  assert.equal(bodies.at(-1)!.max_tokens, 2_048 + 32_000, "summarize_article gets the room its chain needs");
  assert.ok(summarize.receiptId > 0);
});

test("every workbuddy preset carries the headroom and the vision verdict the measurement produced", () => {
  // deepseek-v4.1-flash's headroom is a per-purpose table, not one number: its summarize prompt measured a
  // 18,809-token chain while understand's 240 s clock caps that step at 16,218 — see the arithmetic test below.
  assert.deepEqual(MODELS["workbuddy-deepseek-flash"]!.reasoningHeadroom, { default: 16_000, summarize_article: 32_000, translate_quoted: 8_000 });
  assert.equal(MODELS["workbuddy-hy3"]!.reasoningHeadroom, 16_000);
  // deepseek-v4.1-flash reads images; hy3 tokenizes one and then answers the wrong colour.
  assert.equal(MODELS["workbuddy-deepseek-flash"]!.vision, true);
  assert.equal(MODELS["workbuddy-hy3"]!.vision, false);
  // The second pair. Each headroom is the smallest that clears that model's own measured chain, so neither can
  // borrow 16,000: glm would land `unknown` on structure, and step-5-preview does not need the room.
  assert.equal(MODELS["workbuddy-glm-flash"]!.reasoningHeadroom, 8_000);
  assert.equal(MODELS["workbuddy-step5-preview"]!.reasoningHeadroom, 4_000);
  // step-5-preview reads images (3 of 3 named the colour and the number); glm refuses and says so. Both catalog
  // files claim `supportsImages: true` for glm anyway — the second false claim on this channel after hy3.
  assert.equal(MODELS["workbuddy-step5-preview"]!.vision, true);
  assert.equal(MODELS["workbuddy-glm-flash"]!.vision, false);
  // The strongest effort each model advertises, not one value for the channel: only glm lists `max`.
  assert.deepEqual(MODELS["workbuddy-glm-flash"]!.extra, { reasoning_effort: "max" });
  assert.deepEqual(MODELS["workbuddy-step5-preview"]!.extra, { reasoning_effort: "high" });
  // The Chinese account reaches the same four ids through 3066. Same model, same dials, same vision verdicts —
  // only `service` and the two env vars differ, and that separation is the whole point (two accounts, two
  // breakers). Anything that drifts here means the two doors stopped being the same model.
  //
  // The headroom is the one field that is deliberately NOT shared for deepseek: on 2026-10-16 the operator put
  // only the *international* door into the pool (`x0.00 · Free now`) and left the Chinese one out, so only the
  // door that serves carries the per-purpose table. A member that is not serving does not get re-numbered; see
  // the test below for what has to happen before the Chinese door may be added.
  const SHARED = ["workbuddy-cn-hy3", "workbuddy-cn-glm-flash", "workbuddy-cn-step5-preview"] as const;
  for (const cn of SHARED) {
    const intl = cn.replace("workbuddy-cn-", "workbuddy-") as keyof typeof MODELS;
    assert.equal(MODELS[cn]!.model, MODELS[intl]!.model, `${cn} must name the same upstream model as ${intl}`);
    assert.deepEqual(MODELS[cn]!.reasoningHeadroom, MODELS[intl]!.reasoningHeadroom, `${cn} headroom drifted from ${intl}`);
    assert.equal(MODELS[cn]!.vision, MODELS[intl]!.vision, `${cn} vision verdict drifted from ${intl}`);
    assert.deepEqual(MODELS[cn]!.extra, MODELS[intl]!.extra, `${cn} effort drifted from ${intl}`);
    assert.equal(MODELS[cn]!.service, "workbuddy-cn", `${cn} must ride its own service or it spends the other account's breaker`);
    assert.equal(MODELS[cn]!.baseUrlEnv, "WORKBUDDY_CN_BASE_URL");
    assert.equal(MODELS[cn]!.apiKeyEnv, "WORKBUDDY_CN_API_KEY");
    assert.notEqual(MODELS[cn]!.key, MODELS[intl]!.key);
  }
  // deepseek's two doors still agree on everything except the headroom, which is the only thing the
  // pool membership decision was allowed to change.
  for (const field of ["model", "vision", "service"] as const) {
    if (field === "service") continue; // each door rides its own breaker by design
    assert.equal(MODELS["workbuddy-cn-deepseek-flash"]![field], MODELS["workbuddy-deepseek-flash"]![field],
      `deepseek's two doors drifted on ${field}`);
  }
  assert.deepEqual(MODELS["workbuddy-cn-deepseek-flash"]!.extra, MODELS["workbuddy-deepseek-flash"]!.extra);
});

// The one thing that must not be forgotten if the Chinese door is ever added to the pool: it needs the same
// per-purpose table first. Its summarize prompt is the same prompt, so a flat 16,000 truncates exactly the
// way the international door's did (4 of 6 runs empty). Pinned so that adding it later is a decision with an
// argument attached, not a one-line .env edit followed by silent long-article failures.
test("the Chinese deepseek door carries a flat headroom because it is not in the pool — and that is what adding it would have to fix", () => {
  const cn = MODELS["workbuddy-cn-deepseek-flash"]!;
  const intl = MODELS["workbuddy-deepseek-flash"]!;
  assert.equal(typeof cn.reasoningHeadroom, "number", "the Chinese door is expected to stay un-tuned while it is out of the pool");
  assert.equal(cn.reasoningHeadroom, 16_000);
  // And the gap is real, not cosmetic: the flat number cannot serve summarize.
  const summarizeAsked = 2_048;
  const measuredChain = 18_809;
  assert.ok(
    headroomFor(cn, "summarize_article") < measuredChain - summarizeAsked,
    "the Chinese door's flat headroom would now clear summarize — if it is still out of the pool, this test is stale",
  );
  assert.ok(
    headroomFor(intl, "summarize_article") > measuredChain - summarizeAsked,
    "the international door's table must clear the chain it was measured against",
  );
});

test("the two new presets differ from the zhipu entries of the same upstream model, or they would spend its breaker", () => {
  // `glm-5.3-flash` already exists as a *direct Zhipu* endpoint on ZHIPU_API_KEY and service "zhipu". The
  // WorkBuddy pair must be distinct keys on service "workbuddy": `modelFor` resolves a budget row by the
  // preset's `service`, so a shared key would charge the wrong breaker — and here it would charge a key with
  // no configured base URL at all.
  assert.equal(MODELS["glm-5.3-flash"]!.service, "zhipu");
  assert.equal(MODELS["workbuddy-glm-flash"]!.service, "workbuddy");
  assert.equal(MODELS["workbuddy-glm-flash"]!.model, MODELS["glm-5.3-flash"]!.model, "same upstream model, reached by a different door");
  assert.notEqual(MODELS["workbuddy-glm-flash"]!.key, MODELS["glm-5.3-flash"]!.key);
  assert.equal(MODELS["workbuddy-glm-flash"]!.baseUrlEnv, "WORKBUDDY_BASE_URL");
  assert.equal(MODELS["workbuddy-step5-preview"]!.service, "workbuddy");
  // step-5-preview has no direct entry at all, so this key is the only door to it.
  assert.ok(!Object.hasOwn(MODELS, "step-5-preview"), "the bridge passes unknown ids through, which is exactly why the preset must exist");
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

// The two presets added after the first pair do not share deepseek-v4.1-flash's rate, and the test above runs
// one shared MS_PER_TOKEN over the whole channel. That was right while both members were the same upstream
// model's family; it is wrong now, and wrong in the direction that hides a failure: glm-5.3-flash spends about
// 2.6x as many milliseconds per output token, so a cap that fires in time for deepseek arrives after the clock
// for glm, and an abort is not a truncation (failed/retried vs unknown/paid-for-and-waited-on).
test("each new preset clears the chain measured for it, and stays inside the clock on every step it serves", () => {
  // Measured by replaying GEOHOT's own prefilter/score/structure/summarize/understand prompts at the effort the
  // preset writes, four purposes per model. `clears` is the longest completion minus the smallest ask among
  // those purposes — structure asks only 800, so glm's 7,001-token reply needs 6,201 of headroom, not 7,001.
  // These are lower bounds: no `finish_reason: length` was observed, so the tail is unprobed, not proven short.
  const MEASURED = [
    { key: "workbuddy-glm-flash", msPerToken: 17.8, clears: 6_201 },
    { key: "workbuddy-step5-preview", msPerToken: 9.49, clears: 1_737 },
    // The Chinese account reaches the same four model ids through a second bridge, so the dials and the rates
    // carry over unchanged and must be checked on both doors — the measurements are properties of the model.
    { key: "workbuddy-cn-glm-flash", msPerToken: 17.8, clears: 6_201 },
    { key: "workbuddy-cn-step5-preview", msPerToken: 9.49, clears: 1_737 },
  ];
  // What each step asks for and the clock it is given: llm.ts:420 defaults a reasoning preset to 240 s, and only
  // score (analyze.ts:73), translate (translate.ts:90/285) and understand (analyze.ts:321) pass their own.
  const SERVED = [
    { step: "prefilter", asked: 512, clock: 240_000 },
    { step: "score", asked: 1_024, clock: 240_000 },
    { step: "structure", asked: 800, clock: 240_000 },
    { step: "summarize", asked: 2_048, clock: 240_000 },
    { step: "group batch", asked: 200 + 90 * 3, clock: 240_000 },
    { step: "group pair", asked: 400, clock: 240_000 },
    { step: "group signal", asked: 150 + 60 * 3, clock: 240_000 },
    { step: "digest", asked: 1_200, clock: 240_000 },
    { step: "report lead", asked: 800, clock: 240_000 },
    { step: "report period", asked: 2_500, clock: 240_000 },
    { step: "monitor", asked: 2_500, clock: 240_000 },
  ];
  for (const { key, msPerToken, clears } of MEASURED) {
    // Read through the same accessor the request builder uses. These two presets carry a flat number, so
    // asking per step answers the same value for all of them; a preset whose table says otherwise would show
    // up here rather than after a truncation in the ledger.
    const headroom = headroomFor(MODELS[key]!, "structure_article");
    assert.ok(headroom > clears, `${key}: a ${headroom}-token headroom does not clear the longest chain measured for it, ${clears}`);
    for (const { step, asked, clock } of SERVED) {
      const widest = asked + headroom;
      const seconds = Math.round((widest * msPerToken) / 1000);
      assert.ok(
        widest * msPerToken < clock,
        `${key} on ${step}: ${widest} tokens is about ${seconds} s at ${msPerToken} ms/token, past its ` +
          `${clock / 1000} s clock — the cap would never fire and every long reply would land unknown`,
      );
    }
  }
});

// The exception the test above cannot cover, pinned so it stays a decision instead of becoming a surprise in the
// ledger. glm-5.3-flash is kept out of these three steps by the lists in .env; the arithmetic below is why, and
// if someone later raises one of these clocks or lowers one of these asks, this test is where they find out.
test("the three steps glm-5.3-flash is kept out of are over budget by arithmetic, not by caution", () => {
  const msPerToken = 17.8;
  const OVER_BUDGET = [
    // 16,384 alone is 292 s against 240 s, so no headroom value fixes this one; the clock is not ours to raise
    // (it is what the worker's 255 s graceful shutdown leaves).
    { step: "understand", asked: UNDERSTAND_MAX_TOKENS, clock: UNDERSTAND_TIMEOUT_MS },
    // 8,000 alone is 142 s against 180 s — 21% of margin — and 16,000 would need 285 s, past even the 255 s
    // shutdown ceiling. This is why the exclusion is permanent rather than a tighter headroom.
    { step: "translate body", asked: 8_000, clock: 180_000 },
    { step: "translate quoted", asked: 4_000, clock: 120_000 },
  ];
  const headroom = headroomFor(MODELS["workbuddy-glm-flash"]!, "structure_article");
  for (const { step, asked, clock } of OVER_BUDGET) {
    assert.ok(
      (asked + headroom) * msPerToken >= clock,
      `${step}: glm now fits in ${clock / 1000} s — remove it from that step's exclusion list in .env`,
    );
  }
  for (const { asked } of OVER_BUDGET.filter((s) => s.step === "translate body")) {
    assert.ok((asked + headroom) * msPerToken > 255_000, "the body translation cannot be rescued by the worker's shutdown ceiling either");
  }
  // The Chinese door carries the same model, so the same three steps are over budget through it. If only one
  // door were excluded, the pool would quietly reintroduce glm on the other and the arithmetic above would
  // describe half the truth.
  const cnHeadroom = headroomFor(MODELS["workbuddy-cn-glm-flash"]!, "structure_article");
  assert.equal(cnHeadroom, headroom, "the two doors carry the identical upstream model, so they cannot carry different headrooms");
  for (const { step, asked, clock } of OVER_BUDGET) {
    assert.ok(
      (asked + cnHeadroom) * msPerToken >= clock,
      `${step}: glm through the Chinese door now fits in ${clock / 1000} s — it has to be excluded from that step's list too`,
    );
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
  const LONGEST_SUCCESSFUL = { score_article: 7_007, structure_article: 6_760, summarize_article: 7_834 };
  for (const key of ["workbuddy-deepseek-flash", "workbuddy-hy3", "workbuddy-cn-deepseek-flash", "workbuddy-cn-hy3"]) {
    const spec = MODELS[key]!;
    for (const [purpose, longest] of Object.entries(LONGEST_SUCCESSFUL)) {
      const headroom = headroomFor(spec, purpose);
      assert.ok(headroom > longest, `${key} on ${purpose}: a ${headroom}-token headroom does not clear the longest chain seen, ${longest}`);
    }
    const widest = UNDERSTAND_MAX_TOKENS + headroomFor(spec, "understand_article");
    const seconds = Math.round((widest * MS_PER_TOKEN) / 1000);
    assert.ok(
      widest * MS_PER_TOKEN < UNDERSTAND_TIMEOUT_MS,
      `${key}: understand's widest request is ${widest} tokens, about ${seconds} s at ${MS_PER_TOKEN} ms/token, ` +
        `which is past its ${UNDERSTAND_TIMEOUT_MS / 1000} s clock — the cap would never fire and every long reply would land unknown`,
    );
  }
});

// The measurement that forced deepseek-v4.1-flash's headroom to be a per-purpose table instead of one number,
// so that "just make it 24,000 everywhere" has to argue with the second bound. Both bounds come from things we
// do not get to pick: the first from the prompt the step actually sends, the second from the step's clock.
test("deepseek-v4.1-flash cannot be served by one headroom: summarize needs more than translate_quoted can afford", () => {
  const MS_PER_TOKEN = 6.72; // the slow end of the 4.9-6.7 ms/token band this channel measures
  const spec = MODELS["workbuddy-deepseek-flash"]!;
  const ms = (tokens: number) => (tokens * MS_PER_TOKEN) / 1000;

  // Lower bound — summarize_article, measured 2026-10-16 by replaying the site's own buildArticlePrompt output
  // (7,268 prompt tokens) at effort max through the bridge. At the shared 16,000 headroom the cap is 18,048 and
  // 4 of 6 runs came back `finish_reason: length` with empty content; with the cap lifted to 65,536 the same
  // prompt stopped by itself at 18,809. So the room this step needs is 18,809 - 2,048.
  const SUMMARIZE = { asked: 2_048, clock: 240_000, longestChain: 18_809 };
  const summarizeNeed = SUMMARIZE.longestChain - SUMMARIZE.asked;

  // Upper bound — translate_quoted. It asks for at most 4,000 visible tokens and its clock is 120 s, the
  // shortest in the system, so it is the tightest ceiling there is: 120 s buys 17,857 tokens at the slow rate.
  const QUOTED = { asked: 4_000, clock: 120_000 };
  const quotedCeiling = QUOTED.clock / MS_PER_TOKEN - QUOTED.asked;

  assert.ok(
    summarizeNeed > quotedCeiling,
    `the two bounds have met: one headroom could now serve both (summarize needs ${Math.round(summarizeNeed)}, ` +
      `translate_quoted affords ${Math.round(quotedCeiling)}) — collapse the table back to a single number`,
  );

  // The table that is actually configured has to sit inside both bounds, on every step this model serves.
  const SERVED = [
    { purpose: "summarize_article", asked: SUMMARIZE.asked, clock: SUMMARIZE.clock, longestChain: SUMMARIZE.longestChain },
    { purpose: "translate_quoted", asked: QUOTED.asked, clock: QUOTED.clock, longestChain: 4_367 },
    // translate_body: measured 8,504 at a 24,000 cap, all three runs `stop`.
    { purpose: "translate_body", asked: 8_000, clock: 180_000, longestChain: 8_504 },
    // understand_article: measured 23,186 and 17,256 at the 32,384 cap, both `stop`.
    { purpose: "understand_article", asked: UNDERSTAND_MAX_TOKENS, clock: UNDERSTAND_TIMEOUT_MS, longestChain: 23_186 },
    // score_article / structure_article: measured 9,633 and 5,580 at 17,024 / 16,800, all `stop`.
    { purpose: "score_article", asked: 1_024, clock: 240_000, longestChain: 9_633 },
    { purpose: "structure_article", asked: 800, clock: 240_000, longestChain: 5_580 },
  ];
  for (const { purpose, asked, clock, longestChain } of SERVED) {
    const headroom = headroomFor(spec, purpose);
    assert.ok(
      headroom > longestChain - asked,
      `${purpose}: ${headroom} tokens of headroom does not clear the longest chain measured for it, ` +
        `${longestChain} against an ask of ${asked} (needs > ${longestChain - asked})`,
    );
    const cap = asked + headroom;
    assert.ok(
      cap * MS_PER_TOKEN < clock,
      `${purpose}: the cap is ${cap} tokens, about ${Math.round(ms(cap))} s — past its ${clock / 1000} s clock, ` +
        "so the cap could never fire and every long reply would land unknown instead of the retryable failed",
    );
  }
  // The other door carries the same model but is deliberately NOT in the pool (2026-10-16: only the
  // international `x0.00 · Free now` door was added), so it keeps its flat number and is not checked against
  // this table. The test below pins what adding it would require.
});

// summarize_article's chain is heavy-tailed, and that is the whole reason its number is 32,000 rather than the
// smallest value that clears the observed maximum. Pinned so that "raise it until nothing truncates" has to
// argue with the clock: past this ceiling the failure changes KIND, from a retryable truncation to an abort
// that is paid for, never retried, and waits on an operator.
test("summarize's headroom is bounded by its clock, because no cap can catch this model's tail", () => {
  const MS_PER_TOKEN = 6.72;
  const ASKED = 2_048;
  const CLOCK = 240_000;

  // Thirteen replays of the site's own summarize prompt at effort max, cap lifted to 65,536 so nothing was
  // cut off. The tail runs 3.5x the median; the longest needed 288 s of wall clock by itself.
  const CHAINS = [6_594, 8_189, 10_476, 16_372, 17_150, 17_944, 18_657, 18_809, 25_495, 25_666, 28_358, 34_909, 59_810];
  const sorted = [...CHAINS].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const longest = sorted[sorted.length - 1]!;
  assert.ok(longest > 2 * median, "the tail has stopped being heavy; this test's premise needs re-measuring");

  // No headroom can make the longest chain fit: the cap would have to be past the clock.
  const capForLongest = ASKED + (longest - ASKED);
  assert.ok(
    capForLongest * MS_PER_TOKEN > CLOCK,
    "the longest chain now fits inside the clock — the cap could be raised to clear it after all",
  );

  // So the configured number is the largest cap that still fires before the clock, not the tail.
  const headroom = headroomFor(MODELS["workbuddy-deepseek-flash"]!, "summarize_article");
  const cap = ASKED + headroom;
  assert.ok(cap * MS_PER_TOKEN < CLOCK, `summarize's cap of ${cap} tokens is past its 240 s clock`);
  const clockCeiling = CLOCK / MS_PER_TOKEN - ASKED;
  assert.ok(
    headroom <= clockCeiling,
    `the configured ${headroom} is above what the clock affords (${Math.round(clockCeiling)}) — ` +
      "replies past the cap would abort as unknown instead of truncating as failed",
  );
  // And it still has to be worth having: it must clear the bulk of the measured distribution, not just the median.
  const cleared = CHAINS.filter((c) => c <= cap).length;
  assert.ok(
    cleared >= CHAINS.length - 2,
    `a ${cap}-token cap only clears ${cleared} of ${CHAINS.length} measured chains; the number is too small to be worth the tail it still cuts`,
  );
});
