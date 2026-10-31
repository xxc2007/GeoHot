// Feedback-to-email delivery over plain SMTP with implicit TLS (smtp.qq.com). Zero dependencies:
// the conversation is a small state machine over node:tls, and every payload part is base64, so
// the wire stays 7-bit ASCII safe and base64 lines can never begin with a "." (no dot-stuffing).
// The feishu forward path (notify/feishu.ts) stays as the dormant fallback; this channel is
// enabled by FEEDBACK_EMAIL_ENABLED and needs an SMTP user + authorization code (QQ 邮箱的授权码).
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { config, credential, envFlag } from "../config.ts";
import { sql } from "../db.ts";
import { CapacityExceeded, CapacityGate } from "../lib/capacity.ts";

export const emailFeedbackEnabled = () => envFlag("FEEDBACK_EMAIL_ENABLED", false);

/** RFC 2047 B-encoding as ONE encoded word: QQ mail mis-decodes folded multi-encoded-word
 * subjects (its list preview mangles everything after the first fold), and single long
 * encoded words are what QQ itself emits — every client tested accepts them. */
export function encodedWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

const wrappedBase64 = (data: Buffer) => data.toString("base64").replace(/(.{76})/g, "$1\r\n").trim();

export interface MailAttachment {
  /** ASCII filename as it appears on the wire; must be a plain stored name, never a path. */
  filename: string;
  mime: string;
  data: Buffer;
}
export interface MailInput {
  from: string;
  to: string;
  subject: string;
  /** Plain UTF-8 body; sent base64-encoded as text/plain. */
  text: string;
  attachment?: MailAttachment | null;
  /** Fixed timestamp for tests; real sends omit it. */
  date?: Date;
}

function createStableId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** One complete DATA payload (headers + body, CRLF line endings, no trailing dot). */
export function buildFeedbackMail(input: MailInput): string {
  const boundary = "geohot-" + createStableId(input.subject + "\u0000" + input.text);
  const head = [
    `From: =?UTF-8?B?${Buffer.from("GEOHOT 反馈", "utf8").toString("base64")}?= <${input.from}>`,
    `To: <${input.to}>`,
    `Subject: ${encodedWord(input.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrappedBase64(Buffer.from(input.text, "utf8")),
  ];
  if (input.attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${input.attachment.mime}; name="${input.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrappedBase64(input.attachment.data),
    );
  }
  parts.push(`--${boundary}--`);
  return head.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + "\r\n";
}

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  data: string;
  timeoutMs?: number;
}

function connect(host: string, port: number, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host }, () => resolve(sock));
    sock.once("error", reject);
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => sock.destroy(new Error("smtp timeout")));
  });
}

/** One server reply; multiline "250-" continuations fold until the terminating "250 " line. */
function readReply(sock: tls.TLSSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const fail = (e: Error) => { cleanup(); reject(e); };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let idx; (idx = buf.indexOf("\r\n")) >= 0;) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue;
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve(Number(line.slice(0, 3)));
          return;
        }
      }
    };
    const cleanup = () => { sock.off("data", onData); sock.off("error", fail); };
    sock.on("data", onData);
    sock.on("error", fail);
  });
}

/**
 * The wire transport, behind an injectable object: tests stub `smtpTransport.submit` to record
 * payloads instead of opening real TLS sockets. Production always uses the TLS implementation.
 */
export const smtpTransport: { submit: (o: SmtpOptions) => Promise<void> } = { submit: submitOverTls };

/** One SMTP submission: EHLO → AUTH LOGIN → MAIL → RCPT → DATA → QUIT, each reply code checked. */
async function submitOverTls(o: SmtpOptions): Promise<void> {
  const sock = await connect(o.host, o.port, o.timeoutMs ?? 30_000);
  try {
    const expect = async (code: number, label: string) => {
      const got = await readReply(sock);
      if (got !== code) throw new Error(`smtp ${label} 得到 ${got}，期望 ${code}`);
    };
    await expect(220, "greeting");
    sock.write(`EHLO geohot.local\r\n`);
    await expect(250, "ehlo");
    sock.write("AUTH LOGIN\r\n");
    await expect(334, "auth 用户名提示");
    sock.write(Buffer.from(o.user, "utf8").toString("base64") + "\r\n");
    await expect(334, "auth 密码提示");
    sock.write(Buffer.from(o.pass, "utf8").toString("base64") + "\r\n");
    await expect(235, "auth");
    sock.write(`MAIL FROM:<${o.from}>\r\n`);
    await expect(250, "mail from");
    sock.write(`RCPT TO:<${o.to}>\r\n`);
    await expect(250, "rcpt to");
    sock.write("DATA\r\n");
    await expect(354, "data 开始");
    // Chunked write keeps a large base64 screenshot from building one huge TLS record queue.
    const payload = o.data.replace(/\r?\n/g, "\r\n");
    for (let i = 0; i < payload.length; i += 131_072) {
      if (!sock.write(payload.slice(i, i + 131_072))) await new Promise<void>((r) => sock.once("drain", r));
    }
    if (!sock.write("\r\n.\r\n")) await new Promise<void>((r) => sock.once("drain", r));
    await expect(250, "data 接受");
    sock.write("QUIT\r\n");
  } finally {
    sock.destroy();
  }
}

const emailDelivery = new CapacityGate(1, 0);

/**
 * Emails one feedback (with its screenshot, when one is still stored locally) to the operator's
 * mailbox. Until that succeeds the feedback keeps the reason in forward_error, and the forwarding
 * sweep (operations/feedback.ts) tries it again for a week — the same contract as the feishu path.
 */
export async function forwardFeedbackToEmail(id: number): Promise<"sent" | "disabled" | "busy"> {
  if (!emailFeedbackEnabled()) return "disabled";
  try { return await emailDelivery.run(() => deliverFeedbackByEmail(id)); }
  catch (error) {
    if (error instanceof CapacityExceeded) return "busy";
    throw error;
  }
}

const SCREENSHOT_GIVE_UP_MS = 24 * 3600_000;

/**
 * Resolve a stored screenshot name (uuid.ext generated by storeFeedback) inside the screenshots
 * directory, with an explicit containment check — the database value is never trusted as a path.
 */
function containedScreenshotPath(key: string | null): { file: string; name: string } | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  if (!/^[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(name)) return null;
  const root = path.resolve(config.dataDir, "feedback-screenshots");
  const file = path.resolve(root, name);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return { file, name };
}

async function deliverFeedbackByEmail(id: number): Promise<"sent" | "disabled"> {
  const user = credential("integrations", "FEEDBACK_SMTP_USER");
  const pass = credential("integrations", "FEEDBACK_SMTP_PASS");
  if (!user || !pass) return "disabled";
  const host = credential("integrations", "FEEDBACK_SMTP_HOST") ?? "smtp.qq.com";
  const port = Number(credential("integrations", "FEEDBACK_SMTP_PORT") ?? "465");
  const to = credential("integrations", "FEEDBACK_EMAIL_TO") ?? user;
  const [fb] = await sql<{ id: number; content: string; email: string | null; note: string | null; page_url: string | null; screenshot_key: string | null; created_at: Date }[]>`
    SELECT id, content, email, note, page_url, screenshot_key, created_at FROM feedback WHERE id = ${id} AND forwarded_at IS NULL`;
  if (!fb) return "disabled";

  let attachment: MailAttachment | null = null;
  const noteLines: string[] = [];
  const stored = containedScreenshotPath(fb.screenshot_key);
  if (stored) {
    const data = await readFile(stored.file).catch(() => null);
    if (data) {
      const ext = stored.name.split(".").pop() ?? "png";
      attachment = { filename: stored.name, mime: `image/${ext}`, data };
    } else if (Date.now() - fb.created_at.getTime() >= SCREENSHOT_GIVE_UP_MS) {
      await sql`UPDATE feedback SET screenshot_key = 'gone:missing' WHERE id = ${fb.id}`;
      noteLines.push("（截图文件已不存在）");
    } else {
      // The sweep retries; after a day the text goes without it — same give-up as the feishu path.
      throw new Error("截图文件读取失败，稍后重试");
    }
  } else if (fb.screenshot_key === "gone:upload") {
    noteLines.push("（截图未能随转发上传，已删除）");
  } else if (fb.screenshot_key === "gone:missing") {
    noteLines.push("（截图文件已不存在）");
  }

  const text = [
    fb.content,
    `页面：${fb.page_url ?? "—"}`,
    `邮箱：${fb.email ?? "（未留）"}`,
    ...(fb.note ? [fb.note] : []),
    ...noteLines,
  ].join("\r\n");
  const subject = `GEOHOT 反馈 #${fb.id}：${fb.content.slice(0, 40)}`;

  try {
    await smtpTransport.submit({
      host, port, user, pass, from: user, to,
      data: buildFeedbackMail({ from: user, to, subject, text, attachment, date: new Date() }),
    });
  } catch (error) {
    await sql`UPDATE feedback SET forward_error = ${String(error instanceof Error ? error.message : error).slice(0, 300)} WHERE id = ${fb.id}`;
    throw error;
  }
  if (attachment) {
    await sql`UPDATE feedback SET screenshot_key = 'emailed' WHERE id = ${fb.id}`;
    await unlink(path.resolve(config.dataDir, "feedback-screenshots", attachment.filename)).catch(() => {});
  }
  await sql`UPDATE feedback SET forwarded_at = now(), forward_error = NULL WHERE id = ${fb.id}`;
  return "sent";
}
