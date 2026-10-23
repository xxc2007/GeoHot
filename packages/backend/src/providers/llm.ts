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
  /**
   * 该模型开思考后要先花掉的隐藏 token 数。一个数就是全站同一个；也可以写成按 purpose 查的表，
   * 缺省项落 `default`（再缺就落共用的 REASONING_HEADROOM）。
   *
   * 为什么要能按步骤给：这两个上界来自**不同的东西**，而它们并不总是同时满足——
   *   · 够不够：由**该步骤自己的提示词**实测出的最长链决定（截断了就是不够）；
   *   · 能不能给：由**该步骤的时钟**决定（cap 必须先于时钟触发，否则失败从可重试的 `failed`
   *     退化成花了钱、不自动重试、等人工放行的 `unknown`）。
   * 一个数同时满足两者，只在"每个步骤的链长与时钟之比都一样"时成立；deepseek-v4.1-flash 上不成立：
   * 它的 summarize 提示词实测最长链 18,809（要 >16,761 的余量），而 translate_quoted 的时钟只有 120 s
   * （4,000 + 13,000 = 17,000 token 按 6.72 ms/token 是 114 s，再多就越界）。见 tests/workbuddy-headroom.test.ts。
   */
  reasoningHeadroom?: number | Record<string, number>;
}

/** 单次答复的上限：任何调用方要得再多也不越过这条线（现有最大的一档就是它）。 */
const MAX_OUTPUT_TOKENS = 65_536;
/**
 * 开思考的模型要先花掉这一段才吐出可见答复（实测 Agnes 3.0 flash 一次 3.6k-4.1k）。
 * 这是「默认」而不是「全站唯一定值」：链长是模型的属性，不是提这个要求的步骤的属性，
 * 所以链更长的模型在自己的预设上写 `reasoningHeadroom` 覆盖它；同一个模型的链长在**不同步骤**上
 * 差得足够远时（deepseek-v4.1-flash 就是），那个字段也可以是一张按 purpose 查的表。
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

/**
 * How much hidden chain this preset must be given room for on this step.
 *
 * Deterministic in `(preset, purpose)` on purpose: `requestFor` folds `maxTokens` into the receipt's
 * identity hash, so a headroom that moved between two attempts at the same work would turn every retry
 * into a fresh paid request. `default` is the number for every purpose the preset does not single out.
 */
export function headroomFor(spec: ModelSpec, purpose: string): number {
  const value = spec.reasoningHeadroom;
  if (value === undefined) return REASONING_HEADROOM;
  if (typeof value === "number") return value;
  return value[purpose] ?? value.default ?? REASONING_HEADROOM;
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
  // ── 已删除的注册表成员（2026-10-21 站长要求“把用不了的、无效的模型痕迹彻底清除”）──────────────
  //
  // 下面这些曾经登记过、但**一个都没有可用凭据**（或已被站长否决），留在注册表里只会让后台的模型下拉框
  // 列出一堆选了就报 `Model X is not configured` 的选项，也让 `MODEL_POOL` 里写错名字时看起来像“能用”。
  // 删的是**注册表条目**，不是历史：`receipts` / `receipt_attempts` / `budgets` 里已有的行一律不动
  // （它们是账单与审计的依据，删了就无法解释过去的花费）。
  //
  //   space-bunny-free            opencode  —— 无 OPENCODE_API_KEY；且它只认 summary 一步
  //   or-nemotron-ultra/-nano/-super、or-dots-studio、or-lfm、or-north-mini-code、openrouter-free
  //                               openrouter —— 无 OPENROUTER_API_KEY
  //   glm-5.3-flash、glm-5.3-flash-selection   zhipu —— 无 ZHIPU_API_KEY
  //   deepseek-flash、deepseek-flash-think     deepseek —— 无 DEEPSEEK_API_KEY
  //   qwen3.7-flash、qwen3.8-flash、qwen3-vl-flash  dashscope —— 无 DASHSCOPE_API_KEY
  //   mimo-v2.6-flash             mimo —— 无 XIAOMI_MIMO_API_KEY
  //
  // 要重新启用其中任意一把，不是把旧条目抄回来：先配好那扇门的 key，再按上面那几条注释里
  // 记的实测参数（档位 / jsonMode / vision）重新登记，并跑 `tests/model-pool.test.ts`。
  // 小红书 dots（站长 2026-10-10 给的 key，文档 https://dots.ai/platform/docs）。实测：512K 上下文、
  // 文档默认 RPM 60 / TPM 150 万；`api-key` 头与 `Authorization: Bearer` **两种都收**（同一把 key 两种
  // 写法都回 200），所以 providers 不需要为它加第二种认证头。开思考一次 13–19 秒、1.1k–1.6k 隐藏 token，
  // 4 连发 4 个 200；`reasoning_effort` 写进 extra 是为了让 `reasoning` 那支生效（240 秒超时 + 6k 余量，
  // 见本文件 205-208 行），它在实测里也被接受——不开思考时同一提示 2.4 秒、0 隐藏 token 的答复同样可用，
  // 所以关思考的档留给短任务用。
  "dots3-note-prev": {
    key: "dots3-note-prev", service: "dots", baseUrlEnv: "DOTS_BASE_URL", apiKeyEnv: "DOTS_API_KEY",
    get model() { return process.env.DOTS_MODEL ?? "dots3-note-prev"; },
    extra: { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "max" }, jsonMode: true,
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
  //
  // `reasoningHeadroom` 在这个模型上是**按步骤**给的，因为一个数在算术上不可能同时成立（2026-10-16 实测）：
  //   · 下界由 summarize_article 的提示词给出：长正文（7,268 prompt token）实测最长链 18,809。共用默认的
  //     16,000 让 cap 落在 18,048，6 次里 4 次 `finish_reason: length` + 空答复（长文等于三分之二失败）。
  //     要盖住它，余量必须 > 16,761。
  //   · 上界由 translate_quoted 的时钟给出：它只要 4,000 的可见答复，时钟却只有 120 s（全套里最短的一个）。
  //     按既有判据里这条模型最慢的一档 6.72 ms/token，120 s 只装得下 17,857 token ⇒ 余量不能超过 13,857。
  // 16,761 > 13,857，所以这两个上界不可能由同一个数满足；表里给的就是各自实测出来的那一个。
  // translate_body 与 understand 也各自复核过（链要 504 / 6,802，时钟容得下 18,786 / 19,330），16,000 够用。
  //
  // summarize_article 给 32,000 而不是刚好 16,761 起：同一条提示词重放 13 次，链长是**重尾**的——
  // 6,594 / 8,189 / 10,476 / 16,372 / 17,150 / 17,944 / 18,657 / 18,809 / 25,495 / 25,666 / 28,358 /
  // 34,909 / 59,810，中位数约 17,150，最长那次跑了 288 s。尾部长到没有任何 cap 能在 240 s 内接住它
  // （59,810 × 4.9 ms/token 已是 293 s），所以这里按**时钟**取上限而不是按尾巴：34,048 × 6.72 = 229 s
  // 仍在钟内，cap 先于时钟触发 ⇒ 超出部分落可重试的 `failed`；再往上抬就会变成 abort，落 `unknown`——
  // 花了钱、不自动重试、等人工放行。13 次里 11 次被 34,048 接住，剩下两次是尾部，按设计截断。
  // 算术钉在 tests/workbuddy-headroom.test.ts。
  "workbuddy-hy3": {
    key: "workbuddy-hy3", service: "workbuddy", model: "hy3",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    // translate_quoted 的 120 s 时钟只容得下 8,192 的余量（ask 4,000 + 8,192 = 12,192 × 8.79 ms = 107 s）；
    // 其余步骤维持 16,000——那是 24 h 里 99.5% 成功率下实际在用的值。
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false,
    reasoningHeadroom: { default: 16_000, translate_quoted: 8_192 },
  },
  "workbuddy-deepseek-flash": {
    key: "workbuddy-deepseek-flash", service: "workbuddy", model: "deepseek-v4.1-flash",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    // 2026-10-21 按「时钟安全上限」重算（上限必须在步骤时钟前触发，否则长链落 unknown）：
    // understand 15,360 / translate_body 15,360 / translate_quoted 11,264 / summarize 29,696。
    // summarize 保留 32,000：它是重尾，按实测 13 次重放的分布取到时钟边缘（34,048 × 6.72 = 229 s < 240 s）。
    reasoningHeadroom: { default: 16_000, summarize_article: 32_000, translate_quoted: 11_264 },
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
  "workbuddy-step5-preview": {
    key: "workbuddy-step5-preview", service: "workbuddy", model: "step-5-preview",
    baseUrlEnv: "WORKBUDDY_BASE_URL", apiKeyEnv: "WORKBUDDY_API_KEY",
    // Preserve the production summary fix: the smaller cap was exhausted by hidden reasoning.
    // 9.49–13.68 ms/token：summary 那一步能把余量给到 13,312（2,048 + 13,312 = 15,360 × 13.68 = 210 s < 240 s）；
    // understand 的 16,384 起跳就已经越过时钟，所以那里保持 4,000 不让它更难触发。
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    reasoningHeadroom: { default: 16_000, summarize_article: 13_312, understand_article: 4_000, translate_body: 8_000, translate_quoted: 4_000 },
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
  //
  // ⚠️ 2026-10-20：**国际版那一扇整扇被对端关掉了**，所以这三把模型现在只经中国版这一扇服务。
  // 实测（本机桥与生产桥各一次，三个模型逐个试）：`POST /v2/chat/completions` 一律
  // `HTTP 400 {"code":11128,"msg":"request illegal",…"This call failed channel verification,
  // possibly because it was not sent from an official client."}`——不是某个模型被限，是整条渠道被拒。
  // 生产上近 24 小时的 `workbuddy` 台账是 37 次尝试、0 次应答、全 11128（`budgets` 那一行也因此把
  // `per_minute` 压到 0：不绕过、不再派发）。这是对端的渠道策略，代码这边既不能也不该绕。
  // 站长因此把这三把模型改由仍然答话的中国版账号承载：同三个上游 id、同一个 `max`/`high` 档位。
  // 于是这一扇**必须**带上与国际版同一张按 purpose 的表——它的 summarize 是同一个提示词，单值 16,000
  // 会让长文以 18,048 的 cap 截断（国际版实测 6 次里 4 次空答复）。判据钉在
  // tests/workbuddy-headroom.test.ts，那条用例现在要求两扇门逐字段相等，包括这张表。
  "workbuddy-cn-hy3": {
    key: "workbuddy-cn-hy3", service: "workbuddy-cn", model: "hy3",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false,
    // 与国际版同一条上游模型，所以同一张表（translate_quoted 的 120 s 时钟只容得下 8,192）。
    reasoningHeadroom: { default: 16_000, translate_quoted: 8_192 },
  },
  "workbuddy-cn-step5-preview": {
    key: "workbuddy-cn-step5-preview", service: "workbuddy-cn", model: "step-5-preview",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    // 与国际版同一条上游模型，所以同一张表（13,312 是按国际版实测的 13.68 ms/token 定的；
    // 中国版实测 18.09 ms/token 更慢，但同一个 cap 更早触发只会落可重试的 failed，不会落 unknown）。
    reasoningHeadroom: { default: 16_000, summarize_article: 13_312, understand_article: 4_000, translate_body: 8_000, translate_quoted: 4_000 },
  },
  // 中国版桥上的 deepseek-v4.1-flash。国际版已有 `workbuddy-deepseek-flash`，但那条走 3065 且带
  // `reasoning_effort: "max"`；这一条走中国版 3066，**刻意不带任何 effort 旋钮**——2026-10-22 在
  // 服务器本机对 :3066 实测，同一道判定提示词、8 并发：deepseek-v4.1-flash 3,524 ms / 3,328 tokens，
  // 而 hy3 7,712 ms / 4,096 tokens、step-5-preview 13,974 ms / 2,532 tokens。它天然只吐 39 个隐藏推理
  // token（hy3 是 217–323），所以这里不压也不抬，让对端按默认档跑。headroom 取 4,000：实测 completion
  // 54 tokens，4,000 的余量对每个 purpose 都远超实际链长，且远离任何步骤时钟。
  "workbuddy-cn-deepseek-flash": {
    key: "workbuddy-cn-deepseek-flash", service: "workbuddy-cn", model: "deepseek-v4.1-flash",
    baseUrlEnv: "WORKBUDDY_CN_BASE_URL", apiKeyEnv: "WORKBUDDY_CN_API_KEY",
    // `reasoning_effort` 在这里的作用不是提速，而是**让 Geohot 认得出这扇门会思考**：
    // `llm.ts:458` 的 `reasoning` 判据是「extra 里有 reasoning_effort/thinking」或键名以 `-think` 结尾。
    // 少了它，headroom 归零，score_article 就被压到 1,024、prefilter 压到 512——2026-10-22 实测
    // deepseek 恰恰在这两个 purpose 上大面积 `finish_reason: length`（4 分钟 30 次），
    // 而它对端只吐 39 个隐藏 token，说明截断的是**答案本身**，不是推理。
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    // 2026-10-22 首次上线实测：给 4,000 仍不够（10 分钟 112 次截断）。按国际版 deepseek 的分布重算：
    // understand/translate_body 15,360、translate_quoted 11,264、summarize 29,696。summarize 是重尾，
    // 取到时钟边缘（34,048 × 6.72 ≈ 229 s < 240 s 步骤时钟）。
    reasoningHeadroom: { default: 16_000, summarize_article: 32_000, translate_quoted: 11_264 },
  },

  // ── Qoder CN (maggie gateway on the workstation, reached through a reverse tunnel) ───────────────────
  //
  // What this door is: the operator's own Qoder CN subscription behind `maggie`, an OpenAI-compatible
  // gateway that listens on the workstation's loopback and nowhere else. Production reaches it over
  // `ssh -R 127.0.0.1:3425:127.0.0.1:3425`, so these presets are only *configured* on hosts where
  // QODER_CN_BASE_URL is set; unset keys make each member simply unusable and the pool falls back to the
  // doors that do answer (see `usable()`).
  //
  // Why it gets a budget row of its own rather than riding `llm`: the breaker, the health ledger and the
  // refusal ledger are all keyed on `service`. The quota behind this door belongs to the operator and is
  // counted in a 5-hour window rather than per minute; exhausting it must never make the site believe
  // Agnes or dots are down. One door, one budget row, one health verdict.
  //
  // Measured 2026-10-20 on the workstation, `POST /v1/chat/completions`, real editorial prompts:
  //   • `dfmodel`, `reasoning_effort: max`, JSON mode: 200 with valid JSON and `reasoning_tokens` present.
  //     Structural steps 1.1–7.4 s; understand-shaped 60 k-character prompts 4.0–8.1 s; one full-article
  //     translation 9,649 prompt tokens → 21,006 completion tokens (14,127 hidden) in 80.8 s.
  //   • Concurrency: 8 lanes 3.2 s, 16 lanes 19.8 s, **24 lanes 44.8 s with 5 × HTTP 429**. The window is
  //     therefore ~16 in flight; above it the gate answers 429, and a 429 spends a worker slot.
  //   • Vision: a 1×1 PNG was read correctly ("Pink") in 1.1 s, so `vision: true` is written from the
  //     measurement — this channel's catalog has overstated image support twice before.
  //
  // ⚠️ The one property that does NOT transfer from the other doors: **this gateway ignores `max_tokens`.**
  //   Asked for 200 it returned 3,231 completion tokens; for 16 it returned 1,817; for
  //   `max_completion_tokens: 16` it returned 11,991. Two consequences, both recorded here rather than left
  //   for the next reader to rediscover:
  //     1. `reasoningHeadroom` cannot do its job on this door. Its contract elsewhere in this file — give the
  //        cap room so the cap fires before the clock, so a long chain ends `failed` (retryable) instead of
  //        `unknown` (paid for, not retried, waiting on an operator) — assumes the cap is *honoured*. Under a
  //        gateway that ignores it a small headroom neither protects nor truncates; the request runs to
  //        completion and the clock is the only bound left. So the table below keeps the shape the other
  //        doors use (one receipt identity, and a `finish_reason: length` that would still be reported if it
  //        ever came) and the real protection is the per-step `timeoutMs` the callers already pass:
  //        240 s understand, 180 s translate, 120 s quoted translation.
  //     2. The three call sites the other doors cannot serve are exactly the three this door can, because
  //        the 21,006-token translation finished in 80.8 s — 3.85 ms per output token, the fastest rate of
  //        any door in this file (deepseek-v4.1-flash 4.9–6.7, step-5-preview 9.49, glm 17.80). At that rate
  //        understand's 16,384-token ask is ~63 s against a 240 s clock and translate's 8,000 is ~31 s
  //        against 180 s, so the cap-and-clock meeting point that forced glm out of UNDERSTAND_MODEL and
  //        TRANSLATE_MODEL does not bind here at all.
  //
  // Effort: `max` where the catalog advertises it. dfmodel advertises low / high / max and qfmodel
  // low / medium / xhigh, so each preset sends a value its upstream has a contract for and neither is
  // silently downgraded to a sibling's spelling.
  "qoder-cn-dfmodel": {
    key: "qoder-cn-dfmodel", service: "qoder-cn", model: "qoder-cn/dfmodel",
    baseUrlEnv: "QODER_CN_BASE_URL", apiKeyEnv: "QODER_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    reasoningHeadroom: { default: 16_000, summarize_article: 32_000, translate_quoted: 8_000 },
  },
  "qoder-cn-qfmodel": {
    key: "qoder-cn-qfmodel", service: "qoder-cn", model: "qoder-cn/qfmodel",
    baseUrlEnv: "QODER_CN_BASE_URL", apiKeyEnv: "QODER_CN_API_KEY",
    extra: { reasoning_effort: "xhigh" }, jsonMode: true, vision: true,
    reasoningHeadroom: { default: 16_000, summarize_article: 32_000, translate_quoted: 8_000 },
  },

  // ── WorkBuddy AI（国际版）的三把模型，走同一台 magpie 网关 ──────────────────────────────
  // 站长 WorkBuddy AI 国际版订阅里的模型，经 `maggie` 网关（OpenAI 兼容，工作站 loopback:3425）
  // 暴露；生产通过反向隧道 `ssh -R 127.0.0.1:3425:127.0.0.1:3425` 访问，与 qoder-cn 共用同一条隧道。
  // 单独开 service `workbuddy-ai`：熔断器/健康账本/拒绝账本都按 service 记账，这份额度撞墙时
  // 不该让站点以为 qoder 或中国版 WorkBuddy 也倒了。
  //
  // 2026-10-22 服务器本机经反向隧道实测（真实编辑提示词）：
  //   • deepseek-v4.1-flash：判定提示词 1,421 ms / 22 tokens / 0 个隐藏推理；1,500 字英译中 2,843 ms。
  //     全池最快的门，适合 score/prefilter/translate。
  //   • hy3：9,882 ms / 752 tokens（1,238 字隐藏推理）。慢但稳。
  //   • step-5-preview：5,620 ms / 253 tokens（457 字隐藏推理）。
  //
  // ⚠️ 与 qoder-cn 两把的关键差别：**这台网关遵守 max_tokens**（16 → length/16 tokens；
  //   4000 → 449 tokens/stop）。所以 reasoningHeadroom 在这里有效，按各模型的隐藏推理量留余量。
  "workbuddy-ai-hy3": {
    key: "workbuddy-ai-hy3", service: "workbuddy-ai", model: "workbuddy-ai/hy3",
    baseUrlEnv: "QODER_CN_BASE_URL", apiKeyEnv: "QODER_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: false,
    reasoningHeadroom: { default: 16_000, translate_quoted: 8_192 },
  },
  "workbuddy-ai-step5-preview": {
    key: "workbuddy-ai-step5-preview", service: "workbuddy-ai", model: "workbuddy-ai/step-5-preview",
    baseUrlEnv: "QODER_CN_BASE_URL", apiKeyEnv: "QODER_CN_API_KEY",
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    reasoningHeadroom: { default: 16_000, summarize_article: 13_312, understand_article: 4_000, translate_body: 8_000, translate_quoted: 4_000 },
  },
  "workbuddy-ai-deepseek-flash": {
    key: "workbuddy-ai-deepseek-flash", service: "workbuddy-ai", model: "workbuddy-ai/deepseek-v4.1-flash",
    baseUrlEnv: "QODER_CN_BASE_URL", apiKeyEnv: "QODER_CN_API_KEY",
    // 2026-10-22 站长指令：「不要调推理，一定要用最大的推理强度，确保模型发挥最大性能，
    // 保证模型工作流的质量」。所以这一档固定 reasoning_effort: max，**任何步骤都不降档**。
    // 历史备注（保留供追溯）：这条上游在 short-answer 场景实测隐藏推理接近 0，但判据
    // （llm.ts requestFor 里的 /reasoning_effort|"thinking"/ 正则）要求 extra 里有旋钮，
    // 否则 headroom 归零、score 被压到 1,024。用 max 同时满足判据和站长的质量要求。
    extra: { reasoning_effort: "max" }, jsonMode: true, vision: true,
    reasoningHeadroom: { default: 20_000, summarize_article: 32_000, translate_quoted: 11_264 },
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
function requestFor<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec, legacySummaryParameters = false, beforeMax = false, legacyHeadroom?: number) {
  const temperature = opts.temperature ?? 0.2;
  // Dots documents disabling thinking for short answers. Keep selection/understanding unchanged;
  // Dots 的 summary 关思考；下面两个 step5 的旧参数只作为「恢复身份」，不是新的派发选择。
  let extra = spec.key === "dots3-note-prev" && opts.purpose === "summarize_article" && !legacySummaryParameters
    ? { chat_template_kwargs: { enable_thinking: false } } : spec.extra;
  if (beforeMax && extra && "reasoning_effort" in extra) extra = { ...extra, reasoning_effort: "high" };
  const reasoning = /reasoning_effort|"thinking"/.test(JSON.stringify(extra ?? {})) || spec.key.endsWith("-think");
  const legacyStepSummary = legacySummaryParameters && opts.purpose === "summarize_article"
    && ["workbuddy-step5-preview", "workbuddy-cn-step5-preview"].includes(spec.key);
  const oldStep = beforeMax && ["workbuddy-step5-preview", "workbuddy-cn-step5-preview"].includes(spec.key);
  const headroom = reasoning ? (legacyHeadroom ?? (legacyStepSummary ? 4_000 : oldStep ? (opts.purpose === "summarize_article" ? 13_312 : 4_000) : headroomFor(spec, opts.purpose))) : 0;
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
    // Legacy identities are recovery-only: reuse paid answers and respect pending/unknown;
    // a failed old identity may retry only through the current dispatch parameters.
    const versions = [current];
    if (["workbuddy-step5-preview", "workbuddy-cn-step5-preview", "workbuddy-ai-step5-preview"].includes(model.key)) {
      versions.push({ name, request: requestFor(opts, model, false, false, opts.purpose === "summarize_article" ? 32_000 : 16_000).request });
    }
    if (["dots3-note-prev", "workbuddy-step5-preview", "workbuddy-cn-step5-preview"].includes(model.key)) {
      versions.push({ name, request: requestFor(opts, model, false, true).request });
      if (opts.purpose === "summarize_article") versions.push(
        { name, request: requestFor(opts, model, true).request },
        { name, request: requestFor(opts, model, true, true).request },
      );
    }
    return versions;
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
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true, model.key, "unbilled");
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
