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
  // 「没有自己的余量表就用共享的 6,000」这条判据要有一个在册且没有 reasoningHeadroom 的成员来钉。
  // 2026-10-21: 原先用 deepseek 直连那扇门（已删），改用同样没有该字段的 Agnes 国内版。
  AGNES_CN_BASE_URL: `${provider.url}/v1`, AGNES_CN_API_KEY: "test-key",
  // 让 agnes-cn 成为「开思考、但没有自己的 reasoningHeadroom」的那一类：extra 里有 reasoning_effort，
  // 于是 headroomFor() 落到共用的 REASONING_HEADROOM。原来钉这条的是 deepseek-flash-think。
  AGNES_CN_EXTRA_JSON: JSON.stringify({ reasoning_effort: "high" }),
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

  // 2026-10-21: `deepseek-flash-think` 已从注册表删除（deepseek 直连那扇门没有 key）。
  // 「没有自己的余量表就用共享的 6,000」这条判据换一个仍然在册的成员来钉：agnes-cn 没有 reasoningHeadroom。
  await ask("agnes-3.0-flash-cn", "think", 2048);
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
  assert.deepEqual(MODELS["workbuddy-deepseek-flash"]!.reasoningHeadroom, { default: 16_000, summarize_article: 32_000, translate_quoted: 11_264 });
  assert.deepEqual(MODELS["workbuddy-hy3"]!.reasoningHeadroom, { default: 16_000, translate_quoted: 8_192 });
  // deepseek-v4.1-flash reads images; hy3 tokenizes one and then answers the wrong colour.
  assert.equal(MODELS["workbuddy-deepseek-flash"]!.vision, true);
  assert.equal(MODELS["workbuddy-hy3"]!.vision, false);
  // step-5-preview 的余量是按步骤给的：summary 那一步的可见答复只有 2,048，却要装下更长的链，
  // 所以它单独写 8,000（其余 4,000）。视觉：3 次里 3 次正确说出了颜色与数字。
  assert.deepEqual(MODELS["workbuddy-step5-preview"]!.reasoningHeadroom, { default: 4_000, summarize_article: 13_312 });
  assert.equal(MODELS["workbuddy-step5-preview"]!.vision, true);
  // The strongest effort each model advertises, not one value for the channel.
  // 2026-10-21: `workbuddy-glm-flash` 已从注册表删除（glm 那扇门在本部署上没有 key），这两条改成断言
  // **现存**的两个档位仍然各写各的：deepseek/hy3 是 `max`，step-5-preview 只声明到 `high`。
  assert.deepEqual(MODELS["workbuddy-deepseek-flash"]!.extra, { reasoning_effort: "max" });
  assert.deepEqual(MODELS["workbuddy-hy3"]!.extra, { reasoning_effort: "max" });
  assert.deepEqual(MODELS["workbuddy-step5-preview"]!.extra, { reasoning_effort: "high" });
  // The Chinese account reaches the same four ids through 3066. Same model, same dials, same vision verdicts —
  // only `service` and the two env vars differ, and that separation is the whole point (two accounts, two
  // breakers). Anything that drifts here means the two doors stopped being the same model.
  //
  // 2026-10-20：国际版那一扇被对端渠道校验整扇关掉（三个模型逐个试都是 `code:11128` "not sent from an
  // official client"），站长把这三把模型改由仍答话的中国版承载。所以 deepseek 也进了这张表：现在
  // **两扇门逐字段相等，包括那张按 purpose 的余量表**——服务的门必须带得上它自己的 summarize 表。
  // 2026-10-21: `workbuddy-cn-deepseek-flash` 与 `workbuddy-cn-glm-flash` 已从注册表删除
  // （站长只要中国版的 step 与 hy；deepseek/glm 走国际版那扇）。这里只剩仍在册的两把。
  const SHARED = ["workbuddy-cn-hy3", "workbuddy-cn-step5-preview"] as const;
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
});

// 2026-10-21：中国版 deepseek 已从注册表删除，deepseek-v4.1-flash 只剩国际版这一扇门。
// 它仍然必须带那张按 purpose 的表：summarize 的提示词实测最长链 18,809，单值 16,000 会让长文
// 以 18,048 的 cap 截断（历史实测 6 次里 4 次空答复）。
test("the deepseek door carries the per-purpose table, because it needs it to write long summaries", () => {
  // 2026-10-21: translate_quoted 从 8,000 抬到 11,264——那是 120 s 时钟容得下的最大余量
  // （4,000 + 11,264 = 15,264 × 6.7 ms = 102 s）。其余不变。
  const TABLE = { default: 16_000, summarize_article: 32_000, translate_quoted: 11_264 };
  for (const key of ["workbuddy-deepseek-flash"] as const) {
    assert.deepEqual(MODELS[key]!.reasoningHeadroom, TABLE, `${key} lost the per-purpose headroom table`);
    const summarizeAsked = 2_048;
    const measuredChain = 18_809;
    assert.ok(
      headroomFor(MODELS[key]!, "summarize_article") > measuredChain - summarizeAsked,
      `${key}: a flat headroom would truncate the 18,809-token summarize chain this prompt actually produced`,
    );
  }
});

test("every workbuddy preset rides its own service and door, so one account's breaker never spends the other's", () => {
  // 2026-10-21: 这条原来拿 glm 与直连 zhipu 对照。glm 那两扇门都已从注册表删除，但**判据本身仍然成立**
  // 且更值得钉：注册表里的 key 与 service 必须成对，否则 `modelFor` 会拿 A 扇门的成员去扣 B 扇门的熔断。
  for (const [key, service, baseUrlEnv] of [
    ["workbuddy-deepseek-flash", "workbuddy", "WORKBUDDY_BASE_URL"],
    ["workbuddy-hy3", "workbuddy", "WORKBUDDY_BASE_URL"],
    ["workbuddy-step5-preview", "workbuddy", "WORKBUDDY_BASE_URL"],
    ["workbuddy-cn-hy3", "workbuddy-cn", "WORKBUDDY_CN_BASE_URL"],
    ["workbuddy-cn-step5-preview", "workbuddy-cn", "WORKBUDDY_CN_BASE_URL"],
  ] as const) {
    const spec = MODELS[key];
    assert.ok(spec, `${key} must exist in the registry`);
    assert.equal(spec.service, service, `${key} must ride ${service}`);
    assert.equal(spec.baseUrlEnv, baseUrlEnv);
    assert.equal(spec.key, key, "the registry key and the preset key must agree");
  }
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

// 每条预设的速率不一样，所以时钟要按**它自己**的 ms/token 去验，不能用一条带的数去量所有成员。
// 判据：上限必须在时钟之前触发——触发了是 `failed`（可重试），没触发而让请求跑到超时是 `unknown`
// （钱花了、不自动重试、等人放行）。
test("each new preset clears the chain measured for it, and stays inside the clock on every step it serves", () => {
  // 量法：用 GEOHOT 自己的 prefilter/score/structure/summarize/understand 提示词、按各预设写的档位重放，
  // 每个模型四个 purpose。`clears` 是「最长答复减去最小的一次问量」——structure 只问 800，所以一条
  // 1,737 token 的答复需要 937 的余量，而不是 1,737。这些是**下界**：没有观察到 `finish_reason: length`，
  // 说明尾巴还没被探到，不等于它短。
  // 2026-10-21: glm 的两行随注册表条目一起删除（本部署没有 zhipu key，那扇门从未发出过请求）。
  const MEASURED = [
    { key: "workbuddy-step5-preview", msPerToken: 9.49, clears: 1_737 },
    // The Chinese account reaches the same model id through a second bridge, so the dials and the rates
    // carry over unchanged and must be checked on both doors — the measurements are properties of the model.
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

// 2026-10-21: 这一段原来是「glm-5.3-flash 被排除在这三步之外」的算术证明。glm 的两扇门都已从注册表
// 删除（本部署从未配过 zhipu key），所以那条排除说明随条目一起消失。但**判据本身仍然值得钉**——它说的是
// 「时钟不是我们可以抬的」：一个思考模型如果每输出 token 花得太慢，就给不出比时钟更长的上限，那时截断
// 会变成 unknown（花了钱、不重试、等人放行）。下面用它去量**现在池子里最慢的那把**，这样这条算术不会
// 因为模型换了而变成永远为真的摆设。
test("the slowest member in the pool still has to fit inside the understand clock, or its cap could never fire", () => {
  // step-5-preview 实测 9.49 ms/token（四个 purpose 重放的慢端），是当前池子里最慢的一把。
  const msPerToken = 9.49;
  const headroom = headroomFor(MODELS["workbuddy-step5-preview"]!, "understand_article");
  const widest = UNDERSTAND_MAX_TOKENS + headroom;
  // 反过来说：只要它**还**在时钟内，这条断言就是绿的；一旦有人把它的余量抬到装不下，它必须变红。
  assert.ok(
    widest * msPerToken < UNDERSTAND_TIMEOUT_MS,
    `understand's widest request for the slowest member is ${widest} tokens ≈ ${Math.round((widest * msPerToken) / 1000)} s, ` +
      `past its ${UNDERSTAND_TIMEOUT_MS / 1000} s clock — the cap could never fire and every long reply would land unknown`,
  );
  // 而翻译那两步的时钟更短，所以它们更吃紧：把最慢成员的余量代进去，必须仍然装得下。
  for (const { step, asked, clock } of [
    { step: "translate body", asked: 8_000, clock: 180_000 },
    { step: "translate quoted", asked: 4_000, clock: 120_000 },
  ]) {
    const cap = asked + headroomFor(MODELS["workbuddy-step5-preview"]!, step === "translate quoted" ? "translate_quoted" : "translate_body");
    assert.ok(cap * msPerToken < clock, `${step}: ${cap} tokens ≈ ${Math.round((cap * msPerToken) / 1000)} s is past its ${clock / 1000} s clock`);
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
  for (const key of ["workbuddy-deepseek-flash", "workbuddy-hy3", "workbuddy-cn-hy3"]) {
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
