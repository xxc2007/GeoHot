// GEOHOT × WorkBuddy bridge — a local OpenAI-compatible endpoint in front of a signed-in WorkBuddy account.
//
// Why this exists: WorkBuddy (workbuddy.ai / copilot.tencent.com) exposes chat only at
// `POST /v2/chat/completions`, and that endpoint is **stream-only** (a non-stream request is rejected with
// `{"code":11101,"msg":"Non-stream chat request is currently not supported"}`) and **requires the first
// message to be a system message** (`{"code":11128,"msg":"first message is not system prompt"}`).
// GEOHOT's providers/llm.ts does `await res.text()` and `JSON.parse` on a single response — it speaks
// non-streaming OpenAI only, and only sends a system message when the caller passes one.
//
// This bridge sits between them: it accepts GEOHOT's ordinary non-stream request, re-issues it upstream as a
// stream, folds the SSE deltas back into one JSON body, and passes `usage` through untouched so receipts and
// the budget breaker keep seeing real token counts.
//
// It is a deployment tool, not part of the site: nothing in apps/ or packages/ knows it exists. It holds no
// secret of its own — it reads the WorkBuddy desktop app's own credential file, which is encrypted with a key
// that only the WorkBuddy binary can hand out, and it keeps both in memory only. See tooling/workbuddy-README.md.
//
//   node tooling/workbuddy-bridge.ts                start the server (http://127.0.0.1:3065/v1)
//   node tooling/workbuddy-bridge.ts --check        read the credential, report account + models, no server
//   node tooling/workbuddy-bridge.ts --models       print the models this account can be asked for
//   node tooling/workbuddy-bridge.ts --probe <id>   send one real request to <id> and print the round trip
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 本文件自己的指纹 —— 与 brain-stub.ts 同样的理由：Node 启动时把整份代码读进内存，它不热更新自己。
 * 改了这里却忘了重启桥，行为是旧的而 healthz 是 200。部署后拿磁盘上的这份文件重算 sha256 比对即可。
 */
const SOURCE_PATH = import.meta.filename;
const SOURCE_SHA256 = (() => {
  try {
    return createHash("sha256").update(readFileSync(SOURCE_PATH)).digest("hex");
  } catch {
    return null;
  }
})();
const STARTED_AT = new Date().toISOString();

// ── Configuration ───────────────────────────────────────────────────────────────────────────────────
const PORT = int(process.env.WORKBUDDY_BRIDGE_PORT, 3065);
/** 桥只监听回环：它拿的是真凭据，能被同一台机器上的任何进程调用已经是它能给出的最大暴露面。 */
const HOST = "127.0.0.1";
/**
 * 可选的调用口令。设了就必须带 `Authorization: Bearer <它>`；不设则接受任何非空口令（与 brain-stub 一致，
 * 因为 GEOHOT 的 providers/llm.ts 总会带一个非空的 LLM_API_KEY，而回环绑定才是真正的边界）。
 */
const REQUIRED_TOKEN = process.env.WORKBUDDY_BRIDGE_TOKEN?.trim() || null;
/** 上游请求超时。桥自己拿的是思考模型的活，默认给足。 */
const UPSTREAM_TIMEOUT_MS = int(process.env.WORKBUDDY_BRIDGE_TIMEOUT_MS, 300_000);
/** 客户端没写 reasoning_effort 时，按模型给一个默认档。 */
const DEFAULT_EFFORT = process.env.WORKBUDDY_BRIDGE_EFFORT?.trim() || null;
/** 认领 GEOHOT 那边没有 system 消息的请求：国际端点强制首条为 system。 */
const FALLBACK_SYSTEM = "You are a helpful assistant.";

const GLOBAL_BASE = "https://www.workbuddy.ai";
const CN_BASE = "https://copilot.tencent.com";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 30_000;
/** 上游 body 上限，与插件一致。 */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;

// ── Credential: locate, unlock, decrypt ─────────────────────────────────────────────────────────────
/**
 * WorkBuddy 把 accessToken / refreshToken / nickname 用一层信封加密后写进一个**明文 JSON** 文件：
 * 每个字段是 `{$wbEncrypted:1, envelope:"<base64>"}`，信封里是 `{suite, keyId, nonce, authTag, ciphertext}`。
 * 密钥不在文件里 —— 它由 WorkBuddy 二进制持有，只能让那个二进制自己吐出来（见 unlockSecret）。
 * 所以这份文件即使被读走，没有 WorkBuddy 那台机器上的那个二进制也解不开。
 */
type Variant = {
  id: string;
  app: string;
  region: "global" | "cn";
  base: string;
  envVar: string;
  ownFile: string;
  desktopPath: string;
};

const HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");

function desktopAuthPath(product: string): string {
  // %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<product>.info
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "CodeBuddyExtension", "Data", "Public", "auth", `${product}.info`);
}

const VARIANTS: Record<string, Variant> = {
  "workbuddy-ai": {
    id: "workbuddy-ai", app: "WorkBuddy AI", region: "global", base: GLOBAL_BASE,
    envVar: "WORKBUDDY_AI_AUTH_FILE", ownFile: ".workbuddy-ai-auth.json",
    desktopPath: desktopAuthPath("workbuddy-desktop-ai"),
  },
  workbuddy: {
    id: "workbuddy", app: "WorkBuddy", region: "cn", base: CN_BASE,
    envVar: "WORKBUDDY_AUTH_FILE", ownFile: ".workbuddy-auth.json",
    desktopPath: desktopAuthPath("workbuddy-desktop"),
  },
};

const VARIANT = VARIANTS[process.env.WORKBUDDY_VARIANT?.trim() || "workbuddy-ai"];
if (!VARIANT) throw new Error(`WORKBUDDY_VARIANT 只能是 ${Object.keys(VARIANTS).join(" / ")}`);

/** 二进制路径：环境变量优先，其次是两台机器上的已知安装位置。 */
function electronBinary(): string {
  const override = process.env.WORKBUDDY_AI_ELECTRON_BIN?.trim() || process.env.WORKBUDDY_ELECTRON_BIN?.trim();
  if (override) return override;
  const guesses = [
    "D:\\workbuddy国际版\\WorkBuddyAI\\WorkBuddyAI.exe",
    "D:\\workbuddy CN\\WorkBuddyAI\\WorkBuddy.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "WorkBuddyAI", "WorkBuddyAI.exe"),
  ].filter(Boolean);
  const found = guesses.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "找不到 WorkBuddy 二进制：请设 WORKBUDDY_AI_ELECTRON_BIN 指向 WorkBuddyAI.exe（" +
      "解凭据的那把密钥只能由它给出）。试过：" + guesses.join(" | "),
    );
  }
  return found;
}

/**
 * at-rest 密钥：让 WorkBuddy 自己（以 Electron 的 node 模式）把内部 binding 的值写出来。
 * 这是唯一一条不碰 WorkBuddy 私有格式的路 —— 密钥由它的原生层派生，磁盘上没有副本。
 *
 * 它吐出来的**不是密钥本身，而是一份 JSON**（`{version, atRestSecretKey, atRestDeveloperPublicKey}`），
 * 密钥在 `atRestSecretKey` 里。拿整份 stdout 当密钥会得到一个能过 GCM 之外所有检查、却永远解不开的
 * 错误 keyId —— 所以这里必须解析，并在解析不出来时明确报错而不是退回去用原文。
 */
function unlockSecret(): Promise<string> {
  const bin = electronBinary();
  const script = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-e", script],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      (error, stdout) => {
        if (error) return reject(new Error(`无法从 ${path.basename(bin)} 取到 at-rest 密钥：${error.message}`));
        const text = String(stdout).trim();
        if (!text) return reject(new Error(`${path.basename(bin)} 返回了空的 at-rest 密钥`));
        let document: { atRestSecretKey?: unknown };
        try {
          document = JSON.parse(text) as typeof document;
        } catch {
          return reject(new Error(`${path.basename(bin)} 没有回 JSON（前 120 字：${text.slice(0, 120)}）—— WorkBuddy 的存储格式变了`));
        }
        const secret = document.atRestSecretKey;
        if (typeof secret !== "string" || !secret) {
          return reject(new Error(`${path.basename(bin)} 回的是 JSON，但里面没有 atRestSecretKey（键：${Object.keys(document).join(",")}）`));
        }
        resolve(secret);
      },
    );
  });
}

type Envelope = { suite: number; keyId: string; nonce: string; authTag: string; ciphertext: string };

/** AAD 的字节布局由 WorkBuddy 定死：前缀 "WB-AAD\0" 之后是一串带长度前缀的字段。 */
function associatedData(keyId: string, suite: number): Buffer {
  const lp = (value: string): Buffer => {
    const body = Buffer.from(value, "utf8");
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32BE(body.length);
    return Buffer.concat([head, body]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lp("WBEV1"),
    lp("sym-v1"),
    suiteBytes,
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function openField(secretKey: string, wrapped: unknown): string {
  const field = wrapped as { envelope?: unknown } | null;
  if (!field || typeof field !== "object" || typeof field.envelope !== "string") {
    throw new Error("凭据字段不是 {$wbEncrypted:1, envelope} 形状 —— WorkBuddy 的存储格式变了");
  }
  const envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8")) as Envelope;
  const key = createHash("sha256").update(secretKey, "utf8").digest();
  // keyId 是**派生密钥的 sha256** 前 16 个十六进制字符（不是密钥自己的字节）。对不上说明这份凭据不是这台
  // 机器上那个二进制写的 —— 与其拿错密钥去解、再让 GCM 报一句看不懂的认证失败，不如在这里说清楚。
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (keyId !== envelope.keyId) {
    throw new Error(
      `at-rest 密钥与凭据文件不匹配（派生 keyId ${keyId}，文件里是 ${envelope.keyId}）——` +
      "这台机器上的 WorkBuddy 账号换过了？请确认 WORKBUDDY_AI_ELECTRON_BIN 指向的二进制与登录的应用是同一个。",
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(associatedData(envelope.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

type Credential = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  uid: string;
  domain: string;
  nickname: string | null;
  source: string;
};

/** 桌面应用写的那份（权威），以及桥自己刷过之后留下的那份（见 saveOwn）。 */
function candidateFiles(): string[] {
  const fromEnv = process.env[VARIANT.envVar]?.trim();
  const own = path.join(HOME, VARIANT.ownFile);
  return [fromEnv || VARIANT.desktopPath, own].filter((p, i, all) => all.indexOf(p) === i);
}

/**
 * 部署在一台没有 WorkBuddy 桌面应用的机器上（线上服务器就是这样）时用的那份凭据：
 * `WORKBUDDY_CREDENTIAL_JSON` 指向一个 JSON 文件，字段是**明文**，不需要 at-rest 密钥。
 * 形状与桌面那份一致（`{version, credential:{account,auth}}` 或裸 `{account,auth}`），
 * 只是 accessToken / refreshToken 直接是字符串而不是 {$wbEncrypted:1, envelope}。
 * 本机（有桌面应用）仍然走原来的加密路径 —— 有明文文件就先试它。
 */
function plaintextFile(): string | null {
  const file = process.env.WORKBUDDY_CREDENTIAL_JSON?.trim();
  return file ? file : null;
}

function expiryToMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 0xe8d4a51000 ? n : n * 1000; // 大于 1000-01-01(ms) 的当毫秒，否则当秒
}

async function readCredential(): Promise<Credential> {
  const plain = plaintextFile();
  if (plain) return readPlaintextCredential(plain);
  const secretKey = await unlockSecret();
  const tried: string[] = [];
  for (const file of candidateFiles()) {
    if (!existsSync(file)) { tried.push(`${file}（不存在）`); continue; }
    const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // 桥自己写的那份是 {version, credential:{...}}，桌面那份是 {account, auth, ...}：两种形状都认。
    const own = document.credential as Record<string, unknown> | undefined;
    const auth = (own ?? document.auth) as Record<string, unknown> | undefined;
    const account = (own ? own.account : document.account) as Record<string, unknown> | undefined;
    if (!auth?.accessToken) { tried.push(`${file}（没有 auth.accessToken）`); continue; }
    const credential: Credential = {
      accessToken: openField(secretKey, auth.accessToken),
      refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : openField(secretKey, auth.refreshToken),
      expiresAtMs: expiryToMs(auth.expiresAt),
      uid: String(account?.uid ?? ""),
      domain: String(auth.domain ?? ""),
      nickname: typeof account?.nickname === "string" ? account.nickname : null,
      source: file,
    };
    // nickname 也是加密字段：解不开不影响调用，所以失败就当没有。
    try { if (auth.nickname) credential.nickname = openField(secretKey, auth.nickname); } catch { /* 可选字段 */ }
    return credential;
  }
  throw new Error(
    `没找到 ${VARIANT.app} 的登录凭据。先在那台桌面应用里登录一次。试过：${tried.join(" | ")}`,
  );
}

/** 明文凭据（线上服务器用；见 plaintextFile 的注释）。字段直接是字符串，不做解密。 */
async function readPlaintextCredential(file: string): Promise<Credential> {
  if (!existsSync(file)) {
    throw new Error(`WORKBUDDY_CREDENTIAL_JSON 指向的 ${file} 不存在 —— 先把凭据文件放上去（chmod 600，属主与桥的运行用户一致）`);
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${String(error)}`);
  }
  const own = document.credential as Record<string, unknown> | undefined;
  const auth = (own ?? document.auth) as Record<string, unknown> | undefined;
  const account = (own ? own.account : document.account) as Record<string, unknown> | undefined;
  const accessToken = auth?.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error(`${file} 里没有明文 auth.accessToken —— 这份文件应当由「本地解密后导出」生成，不能直接拷桌面那份（那份是加密的）`);
  }
  const refreshToken = auth?.refreshToken;
  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : "",
    expiresAtMs: expiryToMs(auth?.expiresAt),
    uid: String(account?.uid ?? ""),
    domain: String(auth?.domain ?? ""),
    nickname: typeof account?.nickname === "string" ? account.nickname : null,
    source: file,
  };
}

// ── Credential cache + refresh ──────────────────────────────────────────────────────────────────────
const REFRESH_MARGIN_MS = 5 * 60_000;
let cached: Credential | null = null;
let refreshing: Promise<Credential> | null = null;

async function credential(force = false): Promise<Credential> {
  if (!force && cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return cached;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const read = await readCredential();
        // 桌面那份还没过期就直接用；过期了才去续，避免每次调用都换一次 token。
        if (read.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) return read;
        return await refreshCredential(read);
      } finally {
        refreshing = null;
      }
    })();
  }
  cached = await refreshing;
  return cached;
}

function commonHeaders(c: Credential): Record<string, string> {
  const origin = VARIANT.region === "global" ? GLOBAL_BASE : CN_BASE;
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": CLIENT_UA,
  };
}

/**
 * 官方客户端每次对话请求都带的一组「会话头」。
 *
 * 2026-10-21 实测：**国际版的上游渠道校验看的不是 QIMEI 设备指纹，而是这组会话头。**
 * 缺了它，无论 `CODEBUDDY_QIMEI36` 填不填、`X-IDE-*` 写不写，上游一律回
 * `HTTP 400 {"code":11128,"msg":"request illegal","displayTips":{"en":"This call failed channel
 * verification, possibly because it was not sent from an official client."}}`。
 *
 * 收窄过程（同一份凭据、同一个模型，每次只改头）：
 *   · 只加 `X-Domain` 或只加 `X-User-Id` —— 仍然 400
 *   · 只加四个 ID 里的任意一个 —— 仍然 400
 *   · `X-Conversation-ID` + `X-Conversation-Request-ID` + `X-Conversation-Message-ID` —— **200**
 *   · 上述三个再补 `X-Request-ID` —— 也是 200（官方客户端就是四个都发）
 * 所以门槛是那个三元组；`X-Request-ID` 跟着发是因为官方客户端发它，少发不多得。
 * 四个值在官方客户端里就是 `randomUUID()`，每次请求新生成，彼此无关联。
 *
 * 这也解释了 2026-10-19 18:32 那次「突然整条渠道被拒」：不是账号被封、不是额度用完、
 * 不是模型被限——是这一组头从来没发过，而对端在那一刻上线了这项校验。
 */
function conversationHeaders(): Record<string, string> {
  return {
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
    "X-Request-ID": randomUUID(),
  };
}

/**
 * 续期：`POST /v2/plugin/auth/token/refresh`，refreshToken 走 `X-Refresh-Token` 头，无 body。
 * 实测（2026-10-11）这条端点回 200 且 `expiresIn` 是 27609882 秒（≈319 天），所以正常情况下桥根本走不到这里；
 * 它存在只是为了让「token 过期」不变成一个必须手工重启桥的故障。
 */
async function refreshCredential(c: Credential): Promise<Credential> {
  if (!c.refreshToken) throw new Error("凭据里没有 refreshToken，无法续期：请在 WorkBuddy 桌面应用里重新登录");
  const response = await fetch(`${VARIANT.base}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      ...commonHeaders(c),
      "X-Refresh-Token": c.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const text = await response.text();
  let envelope: { code?: number; msg?: string; data?: Record<string, unknown> };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    throw new Error(`续期端点回了非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`);
  }
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`续期失败（HTTP ${response.status}, code ${envelope.code}）：${envelope.msg ?? text.slice(0, 160)}`);
  }
  const data = envelope.data ?? {};
  const accessToken = data.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("续期没有返回 accessToken：请在 WorkBuddy 桌面应用里重新登录");
  }
  const refreshed: Credential = {
    ...c,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : c.refreshToken,
    expiresAtMs: Date.now() + (expiryToMs(data.expiresIn) || 3600_000),
  };
  cached = refreshed;
  console.log(`[bridge] token 已续期，新到期时间 ${new Date(refreshed.expiresAtMs).toISOString()}`);
  return refreshed;
}

// ── Model catalog (what this account may be asked for) ──────────────────────────────────────────────
type CatalogModel = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: { supportedEfforts?: string[] | string; defaultEffort?: string; onlyReasoning?: boolean; canDisableThinking?: boolean };
  billing?: { credits?: string; free?: boolean };
};

function catalogFile(): string {
  const name = VARIANT.region === "global" ? ".workbuddy-ai-catalog.json" : ".workbuddy-catalog.json";
  return process.env.WORKBUDDY_CATALOG_FILE?.trim() || path.join(HOME, name);
}

/**
 * 目录是可选的：它只用来给每个模型夹一下 max_tokens、并把 effort 的默认档说得准一点。
 * 读不到就按"不知道上限"处理 —— 少一个优化，不是少一个功能。
 */
function readCatalog(): Map<string, CatalogModel> {
  const out = new Map<string, CatalogModel>();
  try {
    const document = JSON.parse(readFileSync(catalogFile(), "utf8")) as { entries?: Record<string, { models?: CatalogModel[] }> };
    for (const entry of Object.values(document.entries ?? {})) {
      for (const model of entry.models ?? []) if (model?.id) out.set(model.id, model);
    }
  } catch {
    // 目录缺失或格式变了：不影响调用，只是拿不到上限。
  }
  return out;
}

function effortsOf(model: CatalogModel | undefined): string[] {
  const raw = model?.reasoning?.supportedEfforts;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw) return [raw];
  const fallback = model?.reasoning?.defaultEffort;
  return fallback ? [fallback] : [];
}

// ── Upstream call: non-stream in, stream out, folded back ───────────────────────────────────────────
type ChatBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  [key: string]: unknown;
};

class BridgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** GEOHOT 只发非流式；桥自己转流式。这里拒绝的只是"客户端要流式"，因为桥不转发流。 */
function prepareBody(raw: ChatBody, catalog: Map<string, CatalogModel>): Record<string, unknown> {
  const model = typeof raw.model === "string" ? raw.model : "";
  if (!model) throw new BridgeError(400, "请求里没有 model");

  const messages = Array.isArray(raw.messages) ? [...(raw.messages as Record<string, unknown>[])] : [];
  if (!messages.length) throw new BridgeError(400, "请求里没有 messages");
  // 国际端点硬性要求首条是 system（否则 400 / code 11128）。GEOHOT 只在调用方给了 system 时才发它，
  // 所以这里补一条 —— 补的是通用提示，不是替调用方改它的编辑口径。
  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: FALLBACK_SYSTEM });
  for (const message of messages) {
    // 上游不认 "developer"，会当成"首条不是 system"而 400。
    if (message.role === "developer") message.role = "system";
  }

  const body: Record<string, unknown> = { ...raw, model, messages, stream: true };
  delete body.stream_options;

  const known = catalog.get(model);
  const ceiling = known?.maxTokens;
  const asked = Number(raw.max_tokens);
  if (Number.isFinite(asked) && asked > 0) {
    // GEOHOT 给思考模型加 6000 余量后可能越过模型自己的上限，越了会被上游拒。夹到目录写的那个数。
    body.max_tokens = ceiling ? Math.min(asked, ceiling) : asked;
  } else {
    delete body.max_tokens;
  }

  // effort：客户端写了就用它的（GEOHOT 的 extra 会带过来）；没写才用桥的默认档。
  if (body.reasoning_effort === "off" || body.reasoning_effort === "") delete body.reasoning_effort;
  if (body.reasoning_effort === undefined) {
    const preferred = DEFAULT_EFFORT ?? known?.reasoning?.defaultEffort ?? null;
    if (preferred) body.reasoning_effort = preferred;
  }
  return body;
}

type FoldedReply = {
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  upstreamId: string | null;
};

/** 把上游的 SSE 折回一个答复。usage 原样留着 —— receipts 与熔断都要看真实 token 数。 */
async function foldStream(response: Response): Promise<FoldedReply> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let upstreamId: string | null = null;

  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError(502, "上游没有返回响应体");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；最后一段可能被截断，留在 buffer 里等下一块。
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        if (typeof event.id === "string" && !upstreamId) upstreamId = event.id;
        const choice = (event.choices as Record<string, unknown>[] | undefined)?.[0];
        if (choice) {
          const delta = choice.delta as Record<string, unknown> | undefined;
          if (typeof delta?.content === "string") content += delta.content;
          if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        }
        if (event.usage && typeof event.usage === "object") usage = event.usage as Record<string, unknown>;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { content, reasoning, finishReason, usage, upstreamId };
}

function upstreamStatus(status: number, kind: string): number {
  if (status === 401) return 401;
  if (status === 402) return 402;
  if (status === 429) return 429;
  return kind === "client" ? 400 : 502;
}

async function chat(raw: ChatBody, catalog: Map<string, CatalogModel>): Promise<Record<string, unknown>> {
  const body = prepareBody(raw, catalog);
  const model = String(body.model);
  const started = Date.now();

  const attempt = async (force: boolean): Promise<Response> => {
    const current = await credential(force);
    return fetch(`${VARIANT.base}/v2/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${current.accessToken}`,
        ...commonHeaders(current),
        ...conversationHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  };

  let response = await attempt(false);
  // 401 = 这个 token 死了。续一次再试一次；再失败就是账号的问题，不该由桥反复重试。
  if (response.status === 401) {
    console.log("[bridge] 上游回 401，续期后重试一次");
    response = await attempt(true);
  }

  if (!response.ok) {
    const text = await response.text();
    const kind = response.status === 429 ? "rate limited" : response.status >= 500 ? "upstream error" : "rejected";
    throw new BridgeError(
      upstreamStatus(response.status, response.status === 400 ? "client" : "server"),
      `workbuddy ${kind} (HTTP ${response.status}): ${text.slice(0, 500)}`,
    );
  }

  const folded = await foldStream(response);
  const latency = Date.now() - started;
  // usage 里带一个 reasoning_tokens 的规范位置：GEOHOT 只是把它记进 receipt，缺了不影响。
  const usage = folded.usage
    ? {
        ...folded.usage,
        completion_tokens_details: {
          reasoning_tokens:
            (folded.usage.completion_thinking_tokens as number | undefined) ??
            ((folded.usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens as number | undefined) ??
            null,
        },
      }
    : null;

  console.log(
    `[bridge] ${model} effort=${String(body.reasoning_effort ?? "-")} ${latency}ms ` +
    `content=${folded.content.length}字 reasoning=${folded.reasoning.length}字 finish=${folded.finishReason}`,
  );

  return {
    id: folded.upstreamId ?? `chatcmpl-wb-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: folded.content, reasoning_content: folded.reasoning || undefined },
        finish_reason: folded.finishReason ?? "stop",
        logprobs: null,
      },
    ],
    usage: usage ?? {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      note: "上游这次没有回 usage",
    },
    workbuddy: { model, effort: body.reasoning_effort ?? null, latencyMs: latency, upstream: VARIANT.base },
  };
}

// ── HTTP surface ────────────────────────────────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > REQUEST_BODY_LIMIT) reject(new BridgeError(413, "请求体超过 64MB"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

async function health(): Promise<Record<string, unknown>> {
  const catalog = readCatalog();
  let account: Record<string, unknown>;
  try {
    const current = await credential(false);
    account = {
      ok: true,
      variant: VARIANT.id,
      app: VARIANT.app,
      region: VARIANT.region,
      upstream: VARIANT.base,
      uid: current.uid,
      domain: current.domain,
      nickname: current.nickname,
      expiresAt: new Date(current.expiresAtMs).toISOString(),
      credentialSource: current.source,
    };
  } catch (error) {
    account = { ok: false, variant: VARIANT.id, error: String(error instanceof Error ? error.message : error) };
  }
  return {
    ok: true,
    role: "geohot-workbuddy-bridge",
    port: PORT,
    source: { path: SOURCE_PATH, sha256: SOURCE_SHA256, startedAt: STARTED_AT, pid: process.pid },
    tokenRequired: REQUIRED_TOKEN !== null,
    defaultEffort: DEFAULT_EFFORT,
    account,
    catalog: { file: catalogFile(), models: catalog.size },
    notes: [
      "上游只收流式请求，桥负责把 SSE 折回一个 JSON 答复；GEOHOT 那边照旧用非流式。",
      "上游要求首条消息是 system；调用方没给时桥补一条通用 system。",
      "max_tokens 会被夹到目录里该模型的上限（hy3 是 64000）。",
    ],
  };
}

async function main(): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (REQUIRED_TOKEN) {
        const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
        if (presented !== REQUIRED_TOKEN) throw new BridgeError(401, "口令不对：请把 WORKBUDDY_BRIDGE_TOKEN 的值写进 GEOHOT 的 LLM_API_KEY");
      }
      if (req.method === "GET" && (route === "/healthz" || route === "/health")) return json(res, 200, await health());
      if (req.method === "GET" && route === "/v1/models") {
        const catalog = readCatalog();
        return json(res, 200, {
          object: "list",
          data: [...catalog.values()].map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "workbuddy" })),
        });
      }
      if (req.method === "POST" && route === "/v1/chat/completions") {
        const raw = JSON.parse(await readBody(req)) as ChatBody;
        return json(res, 200, await chat(raw, readCatalog()));
      }
      return json(res, 404, { error: { message: `未知路由 ${req.method} ${route}`, type: "workbuddy_bridge_route" } });
    } catch (error) {
      if (error instanceof BridgeError) {
        return json(res, error.status, { error: { message: error.message, type: "workbuddy_bridge" } });
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] 500 ${req.method} ${route}: ${message}`);
      return json(res, 502, { error: { message, type: "workbuddy_bridge_internal" } });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`[bridge] GEOHOT × WorkBuddy 桥 http://${HOST}:${PORT}/v1`);
    console.log(`[bridge] 变体 ${VARIANT.id}（${VARIANT.app}，${VARIANT.region}）→ ${VARIANT.base}`);
    console.log(`[bridge] 自检：curl http://${HOST}:${PORT}/healthz`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\n[bridge] ${signal}：关闭`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1_500).unref();
    });
  }
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const mode = process.argv[2];
const isMain = !!process.argv[1] && path.resolve(import.meta.filename).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isMain && mode === "--check") {
  const catalog = readCatalog();
  const current = await credential(false);
  console.log(JSON.stringify({
    variant: VARIANT.id,
    app: VARIANT.app,
    region: VARIANT.region,
    upstream: VARIANT.base,
    credential: {
      uid: current.uid,
      domain: current.domain,
      nickname: current.nickname,
      expiresAt: new Date(current.expiresAtMs).toISOString(),
      daysLeft: Math.round((current.expiresAtMs - Date.now()) / 86_400_000),
      accessTokenChars: current.accessToken.length,
      refreshTokenChars: current.refreshToken.length,
      source: current.source,
    },
    catalog: {
      file: catalogFile(),
      models: catalog.size,
      usable: [...catalog.values()].map((m) => ({
        id: m.id,
        maxTokens: m.maxTokens ?? null,
        efforts: effortsOf(m),
        defaultEffort: m.reasoning?.defaultEffort ?? null,
        free: m.billing?.free ?? null,
      })),
    },
    notes: [
      "凭据只在内存里；--check 不会把 token 写进任何文件。",
      "free=true 的模型走的是账号的免费额度，credit 记 0。",
    ],
  }, null, 2));
  process.exit(0);
}

if (isMain && mode === "--export-credential") {
  // 给「桥跑在一台没有 WorkBuddy 桌面应用的机器上」用：本机解出明文，写成一份 JSON，
  // 由人 scp 过去（线上 chmod 600 + WORKBUDDY_CREDENTIAL_JSON 指它）。
  const current = await credential(false);
  const target = process.argv[3]?.trim();
  if (!target) {
    console.error("用法：node tooling/workbuddy-bridge.ts --export-credential <输出文件>");
    process.exit(2);
  }
  const document = {
    version: 1,
    note: "由 tooling/workbuddy-bridge.ts --export-credential 导出；明文，等同密码，落地即 chmod 600。",
    credential: {
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      expiresAt: current.expiresAtMs,
      domain: current.domain,
      source: current.source,
      account: { uid: current.uid, nickname: current.nickname },
    },
  };
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    written: target,
    uid: current.uid,
    domain: current.domain,
    expiresAt: new Date(current.expiresAtMs).toISOString(),
    accessTokenChars: current.accessToken.length,
    refreshTokenChars: current.refreshToken.length,
  }, null, 2));
  process.exit(0);
}

if (isMain && mode === "--models") {
  const catalog = readCatalog();
  for (const model of catalog.values()) {
    console.log(
      `${model.id.padEnd(22)} ctx=${String(model.contextWindow ?? "?").padEnd(8)} max=${String(model.maxTokens ?? "?").padEnd(7)} ` +
      `efforts=${JSON.stringify(effortsOf(model)).padEnd(26)} free=${model.billing?.free ?? "?"}`,
    );
  }
  process.exit(0);
}

if (isMain && mode === "--probe") {
  const model = process.argv[3];
  if (!model) throw new Error("用法：node tooling/workbuddy-bridge.ts --probe <model-id> [effort]");
  const effort = process.argv[4];
  const started = Date.now();
  const reply = await chat({
    model,
    reasoning_effort: effort,
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你是地理热点网站的编辑。只输出 JSON，不要任何解释。" },
      { role: "user", content: '给这条地理新闻打分并起标题：{"title":"南极海冰面积连续第三年创历史新低","source":"Nature"}。输出 {"score":0-100,"title":"不超过20字的标题"}' },
    ],
  }, readCatalog());
  const choice = (reply.choices as Record<string, unknown>[])[0]!;
  const message = choice.message as Record<string, unknown>;
  console.log(JSON.stringify({
    model,
    effort: effort ?? "(桥的默认)",
    ms: Date.now() - started,
    finishReason: choice.finish_reason,
    reasoningChars: String(message.reasoning_content ?? "").length,
    usage: reply.usage,
    content: message.content,
  }, null, 2));
  process.exit(0);
}

if (isMain) await main();
