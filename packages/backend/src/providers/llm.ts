// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { logicalKeyFor, paidRequest, ProviderRejectedError, rejectReceivedResponse, type ReceiptRequest } from "./receipts.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
  /** 该模型开思考后要先花掉的隐藏 token 数，只在比共用默认值更大时才写。 */
  reasoningHeadroom?: number;
}

/** 单次答复的上限：任何调用方要得再多也不越过这条线（现有最大的一档就是它）。 */
const MAX_OUTPUT_TOKENS = 65_536;
/**
 * 开思考的模型要先花掉这一段才吐出可见答复（实测 Agnes 3.0 flash 一次 3.6k-4.1k）。
 * 这是「默认」而不是「全站唯一定值」：链长是模型的属性，不是提这个要求的步骤的属性，
 * 所以链更长的模型在自己的预设上写 `reasoningHeadroom` 覆盖它。
 */
const REASONING_HEADROOM = 6_000;

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // The same Agnes 3.0 flash served from the mainland endpoint, under its own key and its own budget row.
  // Measured 2026-10-09 with the site's real request shape (JSON mode + `reasoning_effort: high` + a scored
  // editorial prompt): 200, valid JSON, correct Chinese fields, 1.7-9.0 s single call, and 8 concurrent calls
  // all succeeding. What that burst did NOT show is the steady rate — counted per minute in production
  // (2026-10-10 01:22-01:33) it accepts 5-13 answers a minute and answers 429 above that, which is what
  // migration 0052 sized the breaker to. That is still ~550/hour against the `.com` endpoint's 420, and the
  // `.com` key had burned its whole day's text quota (1 request/minute) — so this door is why a backfill run
  // is possible at all.
  // Env-driven like `default` so retuning needs no code change; unset keys make the pool member simply
  // unconfigured (and dropped from the pool, editorial/models.ts:membersFor) rather than silently mis-routing.
  "agnes-3.0-flash-cn": {
    key: "agnes-3.0-flash-cn", service: "agnes-cn", baseUrlEnv: "AGNES_CN_BASE_URL", apiKeyEnv: "AGNES_CN_API_KEY",
    get model() { return process.env.AGNES_CN_MODEL ?? "agnes-3.0-flash"; },
    get extra() { return extraFromEnv(process.env.AGNES_CN_EXTRA_JSON ?? process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.AGNES_CN_JSON_MODE !== "false"; },
    get vision() { return process.env.AGNES_CN_VISION === "true"; },
  },
  // OpenCode Zen. The key offered on 2026-10-09 lists 82 models but answers exactly one: every `-free`
  // tier returns 403 (not enabled on the account) and every paid model 402 (no balance). This entry is that
  // one model, registered `jsonMode: false` because it ignores `response_format` and answers in prose.
  // Every step but 标题摘要 parses a JSON object, so in a pool it is dropped for the other ten and can only
  // ever carry the summary step — `editorial/models.ts:membersFor` enforces that rather than hoping.
  "space-bunny-free": {
    key: "space-bunny-free", service: "opencode", model: "space-bunny-free",
    baseUrlEnv: "OPENCODE_BASE_URL", apiKeyEnv: "OPENCODE_API_KEY", jsonMode: false,
  },
  // 小红书 dots（站长 2026-10-10 给的 key，文档 https://dots.ai/platform/docs）。实测：512K 上下文、
  // 文档默认 RPM 60 / TPM 150 万；`api-key` 头与 `Authorization: Bearer` **两种都收**（同一把 key 两种
  // 写法都回 200），所以 providers 不需要为它加第二种认证头。开思考一次 13–19 秒、1.1k–1.6k 隐藏 token，
  // 4 连发 4 个 200；`reasoning_effort` 写进 extra 是为了让 `reasoning` 那支生效（240 秒超时 + 6k 余量，
  // 见本文件 205-208 行），它在实测里也被接受——不开思考时同一提示 2.4 秒、0 隐藏 token 的答复同样可用，
  // 所以关思考的档留给短任务用。
  "dots3-note-prev": {
    key: "dots3-note-prev", service: "dots", baseUrlEnv: "DOTS_BASE_URL", apiKeyEnv: "DOTS_API_KEY",
    get model() { return process.env.DOTS_MODEL ?? "dots3-note-prev"; },
    extra: { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "high" }, jsonMode: true,
  },
  // OpenRouter：站长 2026-10-10 给的两把 key 实测都是**管理/开通**用的（`GET /api/v1/key` 回
  // `is_management_key: true`，任何 chat/completions 都 401 `User not found`）。管理 key 的用途正是签发普通
  // key——用 `POST /api/v1/keys` 当场签出一把推理 key（name=geohot-inference-…，HTTP 201），它就能推理了。
  // 每个成员一条（池子按 shard 把活分给成员，得能单独点名才轮得到它们）；六条都是免费档，
  // 免费档的额度是**按账号**算的（约 20 次/分钟），所以它们共用 `openrouter` 这一行熔断，见迁移 0056。
  // 实测（同一提示、JSON 模式）：ultra 12 秒 / nano-reasoning 19 秒 / super 45 秒 /
  // dots-studio 与 lfm 秒级 / north-mini-code 偏代码；gemma-4 两条当时对端 429。
  "or-nemotron-ultra": {
    key: "or-nemotron-ultra", service: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    extra: { reasoning_effort: "high" }, jsonMode: true,
  },
  "or-nemotron-nano": {
    key: "or-nemotron-nano", service: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    extra: { reasoning_effort: "high" }, jsonMode: true,
  },
  "or-nemotron-super": {
    key: "or-nemotron-super", service: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    extra: { reasoning_effort: "high" }, jsonMode: true,
  },
  // 同一个模型（小红书 dots）在 OpenRouter 上也有一份免费档：直连那条是主路，这条是多出来的一条并发放量。
  "or-dots-studio": {
    key: "or-dots-studio", service: "openrouter", model: "dots-studio/dots-3-note-preview:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY", jsonMode: true,
  },
  "or-lfm": {
    key: "or-lfm", service: "openrouter", model: "liquid/lfm-2.5-2.6b:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY", jsonMode: true,
  },
  "or-north-mini-code": {
    key: "or-north-mini-code", service: "openrouter", model: "cohere/north-mini-code:free",
    baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY", jsonMode: true,
  },
  // 兜底通路：`OPENROUTER_MODEL` 一改就换名字，不用改代码（key 到位前它是唯一那条登记）。
  "openrouter-free": {
    key: "openrouter-free", service: "openrouter", baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    get model() { return process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free"; },
    jsonMode: true,
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
  // WorkBuddy (the DSH desktop channel). These go through tooling/workbuddy-bridge.ts, which owns the
  // signed-in desktop credential and folds the upstream's mandatory SSE back into one JSON reply —
  // so from here they look like any other non-streaming OpenAI endpoint. Start the bridge first, or
  // these fail with a connect error (which the caller treats as retryable).
  //
  // Both are "always reasoning" models: thinking cannot be turned off, and the effort dial only moves how
  // long the hidden chain gets. Measured 2026-10-12 by replaying GEOHOT's own prompts at effort `max`,
  // deepseek-v4.1-flash spends ~7.6k hidden tokens on the selection-score prompt and ~12-17k on understand.
  // In production the same model's chain runs p50 2.0k / p90 5.7k on score, p50 2.4k / p90 5.0k on
  // structure and p50 7.9k / p90 15.9k on understand. The 6,000-token default headroom sat *inside* that
  // distribution: over one 30 h window, 255 of the 269 replies this model failed had `completion_tokens`
  // exactly at the request's cap — the chain ate the whole budget and the answer came back empty with
  // `finish_reason: length`, which reads like a parser bug and is not one. Hence the explicit
  // `reasoningHeadroom` on both: the cap has to clear the chain, or the step fails for a reason that has
  // nothing to do with the article.
  //
  // Why 16,000 and not more. The cap is a ceiling, not a target — latency follows the chain, not the cap —
  // but it is not free to raise, because a cap that binds lands `failed` and is retried while an abort
  // lands `unknown`, which spends the call and then waits for an operator. So the cap has to fire *before*
  // the clock, i.e. `(asked + headroom) x ms/token` has to fit the step's timeout. These models measured
  // 4.9-6.7 ms per output token, and every step that can pick one allows at least 180 s; 16,000 keeps the
  // widest cap (understand's 16,384 + 16,000) inside the 240 s that step now allows, while still clearing
  // every purpose's observed chain maximum with room — the largest, understand's, reached 21,010 tokens of
  // completion, against 32,384 available. The chain is heavy-tailed and no number is airtight: single
  // replays of the structure and understand prompts ran past 47,000 hidden tokens, and those will keep
  // truncating. Truncating is the acceptable failure; aborting is not.
  //
  // `vision`: deepseek-v4.1-flash reads images (measured — named the colour of a test PNG on every try),
  // hy3 does not (it tokenizes the image and then answers the wrong colour), so hy3 is declared text-only
  // and analyze.ts stops attaching one to it.
  "workbuddy-hy3": {
    key: "workbuddy-hy3", service: "workbuddy", model: "hy3",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false, reasoningHeadroom: 16_000,
  },
  "workbuddy-deepseek-flash": {
    key: "workbuddy-deepseek-flash", service: "workbuddy", model: "deepseek-v4.1-flash",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true, reasoningHeadroom: 16_000,
  },
  // The channel's other two models. Neither belongs to WorkBuddy — `glm-5.3-flash` and `step-5-preview` are
  // the desktop catalog's own entries, reachable through the same bridge, so they ride `service: "workbuddy"`
  // and the one budget row that goes with it. Names are `workbuddy-*` on purpose: `glm-5.3-flash` and
  // `glm-5.3-flash-selection` already exist above as *direct Zhipu* endpoints on their own key and budget,
  // and a model that shares a registry key with another service is a model that spends the wrong breaker.
  //
  // Effort. glm-5.3-flash is the only model on this channel whose dial moves anything: replaying GEOHOT's
  // selection-score prompt at low / high / max it spent 81-110 / 199-337 / 999-2626 hidden tokens in
  // 3.6-5.1 / 6.0-10.1 / 22.1-57.1 s — monotone in both directions, and `max` is advertised in both catalog
  // files, so `max`. step-5-preview advertises low / medium / high and gets `high`: it never lists `max`,
  // and sending one anyway would be a value the upstream has no contract for. That is probably free, because
  // the dial is a latency knob here rather than a depth knob — the same prompt at max / high / off / unset
  // spent 161 / 290 / 312 / 222 hidden tokens, i.e. the spread inside one setting is as wide as the spread
  // across settings, the same non-monotonicity hy3 showed. Writing the strongest value each model *advertises*
  // keeps `high` from later reading as a deliberate downgrade.
  //
  // Headroom, and why neither number is 16,000. The number is not a preference: it is the smallest one that
  // clears the longest chain the step's own prompt actually produced, and it is bounded above by the step's
  // clock, because the cap has to fire before the clock does or the failure lands `unknown` — paid for, not
  // retried, waiting on an operator — instead of the retryable `failed` a truncation gets. That bound is a
  // property of the model: measured over four purposes replayed at max, these two spend 17.80 ms per output
  // token (glm, median 18.96) and 9.49 ms (step-5-preview), against deepseek-v4.1-flash's 4.9-6.7. Handing
  // glm 16,000 would push structure's 800-token ask to 16,800 tokens, which is 299 s against a 240 s step:
  // past the clock, so the cap could never fire and every long reply would land `unknown`. 8,000 does fit —
  // 8,800 tokens is 158 s — and still clears the 7,001 completion tokens glm actually spent, whose binding
  // need is 6,201 because structure only asks for 800. 6,000 would not fit *downward*: it is below the
  // measured 7,001. step-5-preview takes 4,000 rather than 2,000 because 2,000 clears its 1,737-token binding
  // need by only 1.10x on structure, the step with the widest spread, and at 9.49 ms/token the extra 2,000
  // buys 1.89x for about 19 s.
  //
  // The three call sites the headroom cannot fix, and why glm is kept out of them by configuration. They ask
  // 16,384 / 8,000 / 4,000 tokens against 240 s / 180 s / 120 s, so at glm's rate the cap alone wants longer
  // than the step allows — 16,384 x 17.80 ms is 292 s — and no value of this field changes that, because the
  // clock is not ours to raise: it is what the worker's 255 s graceful shutdown leaves.
  //
  // Over budget is not the same as always failing, and the difference matters. The one understand-shaped call
  // actually run end to end through `chatJson` at 16,384 / 240 s returned in 170 s with a 10,284-token chain
  // and `finish_reason: stop`, which reverse-derives 16.5 ms per output token and puts the meeting point of
  // cap and clock near 14,500 tokens. So the exposure is chains past ~14,500, and those abort `unknown` —
  // paid for, not retried, waiting on an operator — instead of truncating into the retryable `failed`. The
  // measured understand chains were 4,054, 5,359 and 10,284, so this is the tail rather than the common case.
  // A tail that lands work in a state nothing retries is not worth buying, so these three call sites name a
  // pool without glm (UNDERSTAND_MODEL / TRANSLATE_MODEL). It is a configured exclusion and not a guard in
  // `usable()` on purpose: such a guard would also strip `workbuddy-hy3`, whose 16,000 headroom puts its
  // understand cap at 32,384 tokens against a 240 s clock, and hy3 has been serving that step in production
  // since it was added — a guard would silently retire a working member, which is worse than the tail it
  // would be closing.
  //
  // `vision`: step-5-preview reads images — 3 of 3 named both the colour and the number in a test PNG, twice
  // on a hidden chain of only 139 and 48 tokens. glm-5.3-flash does not, and says so: asked to read the same
  // PNG it answered "当前模型不支持图像识别，无法查看图片。请切换到支持多模态（图像输入）的模型后重试。" and, on
  // the retry, declined to guess the colour instead of inventing one. The token count agrees — the identical
  // request cost it 86 prompt tokens against step-5-preview's 231, and the ~145 difference is the 512x512
  // image. Both catalog files nevertheless declare `supportsImages: true` for glm: the second time this
  // channel's catalog has claimed an image capability the model does not have (hy3 was the first), which is
  // why `vision` here is written from the measurement and never from the catalog.
  "workbuddy-glm-flash": {
    key: "workbuddy-glm-flash", service: "workbuddy", model: "glm-5.3-flash",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false, reasoningHeadroom: 8_000,
  },
  "workbuddy-step5-preview": {
    key: "workbuddy-step5-preview", service: "workbuddy", model: "step-5-preview",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    extra: { reasoning_effort: "high" }, jsonMode: true, vision: true, reasoningHeadroom: 4_000,
  },
  // ── The same four models, reached through the *Chinese* WorkBuddy account ────────────────────────────
  //
  // Two desktop channels ship under one name and they are not the same product: the international build
  // talks to `www.workbuddy.ai`, the Chinese build to `copilot.tencent.com`, and each is signed in to its
  // own account with its own quota. So they are two bridges (`geohot-workbuddy` on 3065, `geohot-workbuddy-cn`
  // on 3066) and two services here — `workbuddy` and `workbuddy-cn` — because the breaker and the health
  // ledger are both keyed on `service`, and one account's wall must not spend the other's budget.
  //
  // Why this pair exists at all (2026-10-12): the international account's `deepseek-v4.1-flash` hit an
  // account-level frequency wall — `{"code":6004,"msg":"usage exceeds frequency limit … reset at
  // 2026-10-12 19:10:18 UTC+8"}`, HTTP 429 on every attempt, 236 consecutive failures in 90 minutes while
  // its three siblings on the same account answered normally. The Chinese account served the identical
  // model id on the same minute: 3749 ms, `finish_reason: stop`, credit 0.03. The wall was on the account,
  // not on the model — which is exactly what a second door is for, and why `deepseek-v4.1-flash` stays
  // reachable here after being pulled from the international pool.
  //
  // Effort and headroom are the *model's* properties and so are copied verbatim from the international
  // presets above, not re-measured: same model ids, same dials (`max` / `max` / `max` / `high` for
  // deepseek / hy3 / glm / step-5-preview), same measured rates that sized each headroom. The one thing
  // that does differ is the account, and that lives in the two env vars.
  "workbuddy-cn-deepseek-flash": {
    key: "workbuddy-cn-deepseek-flash", service: "workbuddy-cn", model: "deepseek-v4.1-flash",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true, reasoningHeadroom: 16_000,
  },
  "workbuddy-cn-hy3": {
    key: "workbuddy-cn-hy3", service: "workbuddy-cn", model: "hy3",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false, reasoningHeadroom: 16_000,
  },
  "workbuddy-cn-glm-flash": {
    key: "workbuddy-cn-glm-flash", service: "workbuddy-cn", model: "glm-5.3-flash",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false, reasoningHeadroom: 8_000,
  },
  "workbuddy-cn-step5-preview": {
    key: "workbuddy-cn-step5-preview", service: "workbuddy-cn", model: "step-5-preview",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "high" }, jsonMode: true, vision: true, reasoningHeadroom: 4_000,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
  /**
   * Is this answer usable? Return the reason it is not, or null.
   *
   * A schema says the reply has the right shape; it cannot say the words are any good — an English digest or a
   * one-line lead parses fine. Callers already refuse such answers, but the receipt stayed cached as a good one,
   * so every later attempt for the same inputs got that same unusable reply for free, forever. Rejecting it makes
   * the next attempt ask again (receipts.ts: a `failed` receipt is re-callable), which is the only way a story
   * recovers without an operator forcing a rewrite.
   */
  usable?: (data: z.infer<S>) => string | null;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

/** `name` is what the operator scripts log as the failure category (`backfill-papers.ts` sanitises to it),
 *  so a subclass that leaves it at the inherited `"Error"` makes every one of these look the same in the
 *  cycle ledger — 2026-10-13: a dozen dates failed 「失败：Error」 every quarter-hour, for two different
 *  causes (an unusable model answer, and a receipt stuck at `unknown`), and the log could not tell them apart. */
export class ModelOutputError extends Error {
  constructor(message: string) { super(message); this.name = "ModelOutputError"; }
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

/** Keep candidate identities and real HTTP requests on the same parameter calculation. */
function requestFor<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec, legacySummaryParameters = false) {
  const temperature = opts.temperature ?? 0.2;
  // Dots documents disabling thinking for short answers. Keep selection/understanding unchanged;
  // Space Bunny summaries need the existing reasoning headroom. Previous summary parameters
  // for both models below are recovery identities, never new dispatch choices.
  const extra = spec.key === "dots3-note-prev" && opts.purpose === "summarize_article" && !legacySummaryParameters
    ? { chat_template_kwargs: { enable_thinking: false } } : spec.extra;
  const reasoning = /reasoning_effort|"thinking"/.test(JSON.stringify(extra ?? {})) || spec.key.endsWith("-think")
    || (spec.key === "space-bunny-free" && opts.purpose === "summarize_article" && !legacySummaryParameters);
  const headroom = reasoning ? spec.reasoningHeadroom ?? REASONING_HEADROOM : 0;
  const maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(opts.maxTokens ?? 1500, 512) + headroom);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const json = spec.jsonMode && opts.json !== false;
  const request: ReceiptRequest = {
    service: spec.service, model: spec.model, purpose: opts.purpose, subject: opts.subject,
    identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, json, extra: extra ?? null },
    requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
    attemptTag: opts.attemptTag,
  };
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: opts.user }],
    temperature, max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}), ...(extra ?? {}),
  };
  return { request, body, reasoning };
}

/** What a truncated answer cost, in the three numbers that explain it: the cap it hit, the tokens it
 *  spent, and how many of those were the hidden chain the caller never sees. */
function truncationDetail(usage: Record<string, unknown> | null | undefined): string {
  const details = usage?.completion_tokens_details as { reasoning_tokens?: number } | undefined;
  return `finish_reason: length after ${usage?.completion_tokens ?? "?"} completion tokens (${details?.reasoning_tokens ?? "?"} of them hidden chain)`;
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  // A reasoning model spends the budget before it answers. Measured 2026-10-06 on Agnes 3.0 flash:
  // `reasoning_effort: high` burned 4,094 hidden tokens and returned an **empty** `content` with
  // `finish_reason: length` at max_tokens 512, then answered normally at 8,192 (52 s, 4,185 tokens).
  // Reasoning therefore buys headroom on top of the caller's own size — capped at the largest output
  // any caller already asks for, so a preset that sized itself (the selection call: 65,536) stays as is.
  const { request } = requestFor(opts, spec);
  // Dynamic import avoids the registry/model-selection module's static import cycle.
  const { recoveryModelsForPurpose, budgetFallbackModelsForPurpose } = await import("../editorial/models.ts");
  const candidateNames = await recoveryModelsForPurpose(opts.purpose, opts.model);
  const candidates = candidateNames.flatMap((name) => {
    const model = MODELS[name]!;
    const current = { name, request: requestFor(opts, model).request };
    return ["dots3-note-prev", "space-bunny-free"].includes(model.key) && opts.purpose === "summarize_article"
      ? [current, { name, request: requestFor(opts, model, true).request }] : [current];
  });
  const needsVision = Array.isArray(opts.user) && opts.user.some((part) => part.type === "image_url");
  const fallbackNames = await budgetFallbackModelsForPurpose(opts.purpose, opts.model, needsVision);
  const dispatch = (model: ModelSpec) => {
    const prepared = requestFor(opts, model);
    const url = credential("models", model.baseUrlEnv)!;
    const key = credential("models", model.apiKeyEnv)!;
    return { request: prepared.request, call: async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(prepared.body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? (prepared.reasoning ? 240_000 : 120_000)),
        });
      } catch (error) {
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true, model.key);
        throw error;
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable, model.key);
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    } };
  };
  const receipt = await paidRequest(request, dispatch(spec).call, candidates.map((c) => c.request),
    fallbackNames.map((name) => dispatch(MODELS[name]!)));

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  // A cut-off answer is not a malformed one. Without this, an empty reply reads as "no JSON object in
  // model output" and the next person goes hunting for a parser bug that is not there.
  const truncated = response.choices?.[0]?.finish_reason === "length" ? ` — ${truncationDetail(response.usage)}` : "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}${truncated}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}${truncated}`);
  }
  // Right shape, no usable words: hand the answer to the caller (it applies its own editorial gate and keeps
  // what the page already has) but refuse the receipt, so the next attempt is a real request.
  const unusable = opts.usable?.(parsed) ?? null;
  if (unusable) await rejectReceivedResponse(receipt.receiptId, `answer refused: ${unusable.slice(0, 500)}${truncated}`);
  const actualModel = candidates.find((c) => logicalKeyFor(c.request) === receipt.logicalKey)?.name ?? spec.key;
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: actualModel, usage: response.usage ?? null };
}
