// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless an
// environment variable or the admin's model page picks one of the named presets below.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

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
}

/** 单次答复的上限：任何调用方要得再多也不越过这条线（现有最大的一档就是它）。 */
const MAX_OUTPUT_TOKENS = 65_536;
/** 开思考的模型要先花掉这一段才吐出可见答复（实测 Agnes 3.0 flash 一次 3.6k-4.1k）。 */
const REASONING_HEADROOM = 6_000;

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {  if (!value) return undefined;
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
  // OpenRouter：站长给的这把 key 实测是**管理/开通**用的——`GET /api/v1/key` 回 `is_management_key: true`，
  // `/models` 能列 458 个模型（其中 15 个 `:free`），但任何 chat/completions 都 401 `User not found`。
  // 推理要另建一把普通 key，所以这条通路先登记、**不进 MODEL_POOL**：池子按 shard 把活分给成员，
  // 配一个只会 401 的门等于把 1/N 的工作扔进重试阶梯。key 到位后把 OPENROUTER_MODEL 设成实测可用的
  // `:free` 模型、再把它加进 MODEL_POOL 即可。
  "openrouter-free": {
    key: "openrouter-free", service: "openrouter", baseUrlEnv: "OPENROUTER_BASE_URL", apiKeyEnv: "OPENROUTER_API_KEY",
    get model() { return process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free"; },
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

export class ModelOutputError extends Error {}

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

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);

  const temperature = opts.temperature ?? 0.2;
  // A reasoning model spends the budget before it answers. Measured 2026-10-06 on Agnes 3.0 flash:
  // `reasoning_effort: high` burned 4,094 hidden tokens and returned an **empty** `content` with
  // `finish_reason: length` at max_tokens 512, then answered normally at 8,192 (52 s, 4,185 tokens).
  // Reasoning therefore buys headroom on top of the caller's own size — capped at the largest output
  // any caller already asks for, so a preset that sized itself (the selection call: 65,536) stays as is.
  const reasoning = /reasoning_effort|"thinking"/.test(JSON.stringify(spec.extra ?? {})) || spec.key.endsWith("-think");
  const maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(opts.maxTokens ?? 1500, 512) + (reasoning ? REASONING_HEADROOM : 0));
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(spec.extra ?? {}),
  };

  const receipt = await paidRequest(
    {
      service: spec.service,
      model: spec.model,
      purpose: opts.purpose,
      subject: opts.subject,
      // `json` belongs in the identity: response_format is part of what the provider was asked for, so an
      // answer produced in JSON mode must not be replayed as the answer to a non-JSON request (or the
      // other way round) when LLM_JSON_MODE is flipped between runs.
      identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, json: spec.jsonMode && opts.json !== false, extra: spec.extra ?? null },
      requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
      attemptTag: opts.attemptTag,
    },
    async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? (reasoning ? 240_000 : 120_000)),
        });
      } catch (error) {
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
        throw error;
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
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
    },
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer.
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`);
  }
  // Right shape, no usable words: hand the answer to the caller (it applies its own editorial gate and keeps
  // what the page already has) but refuse the receipt, so the next attempt is a real request.
  const unusable = opts.usable?.(parsed) ?? null;
  if (unusable) await rejectReceivedResponse(receipt.receiptId, `answer refused: ${unusable.slice(0, 500)}`);
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}
