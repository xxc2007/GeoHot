// Feedback: content, optional email, page URL, one optional screenshot. The screenshot goes to
// the operator's mailbox and only a marker is stored. Abuse control uses an unreadable source
// identifier (HMAC of client IP + UA family), per-source bans and a per-minute limit.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { CapacityGate } from "../lib/capacity.ts";
import { emailFeedbackEnabled, forwardFeedbackToEmail } from "../notify/email.ts";

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", secret).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

const recent = new Map<string, number[]>();
const storageGate = new CapacityGate(1, 8);
let globalRecent: number[] = [];
let uploads = 0;
const admissions = new WeakSet<object>();

/** Before parsing a body: bounded IP identities, global request rate and buffered uploads. */
export function admitFeedback(ip: string): { ticket: object; release: () => void } {
  if (uploads >= 2) throw new FeedbackRejected(429, "rate_limited", "上传繁忙，请稍后再试。", 10);
  const now = Date.now();
  globalRecent = globalRecent.filter((t) => now - t < 60_000);
  if (globalRecent.length >= 30) throw new FeedbackRejected(429, "rate_limited", "提交繁忙，请稍后再试。", 60);
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  rateLimit(createHmac("sha256", secret).update(`feedback-ip|${ip}`).digest("base64url"));
  globalRecent.push(now);
  uploads++;
  const ticket = {};
  admissions.add(ticket);
  let released = false;
  return { ticket, release: () => { if (!released) { released = true; uploads--; admissions.delete(ticket); } } };
}

function rateLimit(source: string, perMinute = 5): void {
  const now = Date.now();
  for (const [k, v] of recent) if (v.every((t) => now - t >= 60_000)) recent.delete(k);
  if (!recent.has(source) && recent.size >= 5000) throw new FeedbackRejected(429, "rate_limited", "提交繁忙，请稍后再试。", 60);
  const list = (recent.get(source) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 60);
  list.push(now);
  recent.set(source, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t > 60_000)) recent.delete(k);
}

/**
 * The page an anonymous visitor names, kept only in a form that is safe to show the operator as a link:
 * an absolute http(s) address or a path on this site. "//host/x" is a protocol-relative address and
 * `javascript:`/`data:` are the two ways a stored value becomes executable, so both are dropped.
 */
export function httpPageUrl(value: string | null | undefined): string | null {
  const raw = value?.trim().slice(0, 500);
  if (!raw) return null;
  if (raw.startsWith("/")) return raw.startsWith("//") ? null : raw;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface FeedbackInput {
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  ip: string;
  userAgent: string;
}

export async function submitFeedback(input: FeedbackInput, ticket?: object): Promise<{ id: number }> {
  const ownAdmission = ticket && admissions.delete(ticket) ? null : admitFeedback(input.ip);
  try { return await storageGate.run(() => storeFeedback(input)); }
  finally { ownAdmission?.release(); }
}

async function storeFeedback(input: FeedbackInput): Promise<{ id: number }> {
  const content = input.content.trim();
  if (content.length < 2) throw new FeedbackRejected(400, "invalid_request", "请写下反馈内容。");
  if (content.length > 5000) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  const email = input.email?.trim() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  // The page an anonymous visitor names is shown to the operator as a link, so only an absolute
  // http(s) address is kept; anything else (javascript:, data:) is dropped rather than stored.
  const pageUrl = httpPageUrl(input.pageUrl);
  const source = feedbackSourceHash(input.ip, input.userAgent);

  let screenshotKey: string | null = null;
  if (input.screenshot) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.screenshot.mime)) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPG、WebP 或 GIF。");
    if (input.screenshot.data.length > 8 * 1024 * 1024) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
    // Stored locally only until it is forwarded (notify/email.ts); the database keeps only an identifier.
    const name = `${randomUUID()}.${input.screenshot.mime.split("/")[1]}`;
    const dir = path.join(config.dataDir, "feedback-screenshots");
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    if (files.length >= 1024) throw new FeedbackRejected(429, "rate_limited", "截图存储繁忙，请稍后再试。", 60);
    let bytes = 0;
    for (const file of files) bytes += (await stat(path.join(dir, file)).catch(() => null))?.size ?? 0;
    if (bytes + input.screenshot.data.length > 256 * 1024 * 1024) throw new FeedbackRejected(429, "rate_limited", "截图存储繁忙，请稍后再试。", 60);
    await writeFile(path.join(dir, name), input.screenshot.data, { flag: "wx" });
    screenshotKey = `local:${name}`;
  }
  let row: { id: number } | undefined;
  try { [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, ip, forward_error)
    VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}, ${input.ip}, 'pending') RETURNING id`; }
  catch (error) {
    if (screenshotKey) await unlink(path.join(config.dataDir, "feedback-screenshots", screenshotKey.slice(6))).catch(() => {});
    throw error;
  }
  const id = row!.id;
  void fillLocation(id, input.ip).catch(() => {});
  void forwardFeedbackToEmail(id).catch(() => {});
  return { id };
}

/** 内网与保留地址不外查，直接标注；公网地址查一次 ipwho.is（https），失败就留给管理员看 IP 原文。 */
function isRoutableIp(ip: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && !ip.startsWith("0.") && !ip.startsWith("10.")
    && !ip.startsWith("127.") && !ip.startsWith("169.254.") && !ip.startsWith("172.16.") && !ip.startsWith("172.17.")
    && !ip.startsWith("172.18.") && !ip.startsWith("172.19.") && !ip.startsWith("172.2") && !ip.startsWith("172.30.")
    && !ip.startsWith("172.31.") && !ip.startsWith("192.168.") && !ip.startsWith("224.") && !ip.startsWith("239.")
    && !ip.startsWith("240.") && ip !== "255.255.255.255";
}

async function fillLocation(id: number, ip: string): Promise<void> {
  let location: string;
  if (!isRoutableIp(ip)) location = "内网或保留地址";
  else {
    const res = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(8_000) });
    const j = (await res.json()) as { success?: boolean; city?: string; region?: string; country?: string };
    location = j.success && (j.city || j.country) ? [j.city, j.region, j.country].filter(Boolean).join(" · ") : "未知";
  }
  await sql`UPDATE feedback SET location = ${location} WHERE id = ${id} AND location IS NULL`;
}

/**
 * Every few minutes: feedback that did not reach the operator (mailbox down, a screenshot read
 * failing) is tried again for a week. Newer than a few minutes is still being sent by its
 * submission.
 */
export async function forwardPendingFeedback(): Promise<{ sent: number; failed: number }> {
  await cleanupFeedbackScreenshots();
  if (!emailFeedbackEnabled()) return { sent: 0, failed: 0 };
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM feedback WHERE forwarded_at IS NULL AND forward_error IS NOT NULL
      AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '7 days'
    ORDER BY id LIMIT 20`;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if ((await forwardFeedbackToEmail(r.id)) === "sent") sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

/** Retention is independent of whether the optional operator mailbox is enabled. */
export async function cleanupFeedbackScreenshots(now = Date.now()): Promise<void> {
  await storageGate.run(async () => {
    await sql`UPDATE feedback SET screenshot_key = 'gone:upload'
      WHERE screenshot_key LIKE 'local:%' AND created_at < ${new Date(now - 24 * 3600_000)}`;
    const rows = await sql<{ screenshot_key: string }[]>`SELECT DISTINCT screenshot_key FROM feedback WHERE screenshot_key LIKE 'local:%'`;
    const live = new Set(rows.map((r) => r.screenshot_key.slice(6)));
    const dir = path.join(config.dataDir, "feedback-screenshots");
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/^[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(name) || live.has(name)) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < now - 24 * 3600_000) await unlink(file).catch(() => {});
    }
  });
}
