// Feishu messaging for operations alerts: the alert chat, falling back to the internal chat.
// The former content-group webhook push and the feishu feedback forward were torn out with the
// notify chain (2026-10-31); feedback now goes only over SMTP (notify/email.ts). Everything outward
// is off unless explicitly enabled (development and parallel runs stay silent).
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { config, credential, envFlag } from "../config.ts";

const API = "https://open.feishu.cn/open-apis";

// 同一个阀门只有一种读法（`envFlag`：`1` 与 `true` 都算开），但它必须在使用点现读环境——
// 告警的测试是在运行时改 `process.env` 的，取成启动时的快照就会把它们全部改成"永远不发"。
// 以前这里写的是 `=== "true"`，于是 `FEISHU_INTERNAL_ENABLED=1` 的意思是"告警永不发"。
export const feishuInternalEnabled = () => envFlag("FEISHU_INTERNAL_ENABLED", false);

let tokenCache: { token: string; expires: number } | null = null;

async function tenantToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const appId = credential("integrations", "FEISHU_APP_ID");
  const appSecret = credential("integrations", "FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu message app is not configured");
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { code: number; tenant_access_token?: string; expire?: number; msg?: string };
  if (json.code !== 0 || !json.tenant_access_token) throw new Error(`feishu token: ${json.msg}`);
  tokenCache = { token: json.tenant_access_token, expires: Date.now() + (json.expire ?? 3600) * 1000 };
  return tokenCache.token;
}

async function sendToChat(chatId: string, msgType: "text" | "post" | "interactive", content: unknown): Promise<string> {
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await tenantToken()}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { code: number; data?: { message_id: string }; msg?: string };
  if (json.code !== 0 || !json.data) throw new Error(`feishu send: ${json.msg}`);
  return json.data.message_id;
}

// ---- Operations alerts ------------------------------------------------------------------------------
// Read by the site owner, not an engineer (operations/alerts.ts): what readers see, whether it heals,
// what the owner must do, and a last line of detail for the AI or engineer it is forwarded to.

export type Level = "now" | "today" | "digest";

export interface Finding {
  key: string;
  level: Level;
  /** Plain words: no queue, unit or table names. */
  title: string;
  /** What readers see, or what it costs. */
  impact?: string;
  /** Whether it heals by itself. */
  heals?: string;
  /** What the owner has to do ("转给 AI" when it is engineering work). */
  action?: string;
  /** For the AI or engineer the owner forwards it to. */
  detail?: string;
  /** When the problem began, when known; otherwise when it was first seen. */
  since?: Date;
}

const MARK: Record<Exclude<Level, "digest">, string> = { now: "🔴", today: "🟠" };

/** "9月29日" in Beijing time. */
export function beijingDay(at: Date | string | number): string {
  const [, m, d] = beijingDate(at).split("-").map(Number);
  return `${m}月${d}日`;
}

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (at: Date | string | number) => `${beijingDay(at)} ${beijingTime(at)}`;

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}`;
  return `${Math.floor(min / 1440)} 天`;
}

/** The message for an open problem: first notice or a repeat. */
export function formatAlert(f: Finding, since: Date, now: number, repeat = false): { title: string; lines: string[] } {
  const level = f.level === "digest" ? "today" : f.level;
  const lasting = now - since.getTime() >= 60_000 ? `（已持续 ${duration(now - since.getTime())}）` : "";
  const lines = [f.impact && `影响：${f.impact}`, f.heals && `会自己好吗：${f.heals}`, f.action && `你需要：${f.action}`, f.detail && `给 AI 的细节：${f.detail}`];
  return { title: `${MARK[level]} ${repeat ? "仍未恢复：" : ""}${f.title}${lasting}`, lines: lines.filter((l): l is string => !!l) };
}

export function formatRecovery(title: string, since: Date, now: number): { title: string; lines: string[] } {
  return { title: `✅ 已恢复：${title}`, lines: [`持续 ${duration(now - since.getTime())}（${beijingStamp(since)} 起）`] };
}

/** Operations alert: the alert chat, falling back to the internal feedback chat — never a content group. */
export async function sendAlert(title: string, lines: string[]): Promise<"sent" | "disabled"> {
  // Production needs no label; any other environment that has sending on says which one it is.
  const text = `${config.environmentName === "production" ? "" : `【${config.environmentName}】`}${title}\n${lines.join("\n")}`;
  if (!feishuInternalEnabled()) {
    console.log(JSON.stringify({ level: "warn", msg: "alert (not sent: FEISHU_INTERNAL_ENABLED is off)", title, lines }));
    return "disabled";
  }
  const chat = credential("integrations", "FEISHU_ALERT_CHAT_ID") ?? credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (!chat) return "disabled";
  await sendToChat(chat, "text", { text });
  return "sent";
}
