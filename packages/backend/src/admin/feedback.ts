// Feedback handling: list, status and note, and deletion on request
// (privacy notice: feedback material is removed once handling ends or when the sender asks).
// 2026-10-31: the per-source ban feature was removed at the operator's request — the rate limits
// in operations/feedback.ts stay; the feedback_bans table is kept for history but nothing reads it.
// The same change started storing the raw submitter IP (migration 0100) so the admin can see
// time / IP / location per feedback; the HMAC source_hash stays as the rate-limit key.
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { InvalidInput } from "./invalid.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { adminReadOrBusy } from "./admin-read.ts";

export const FEEDBACK_STATUSES = ["new", "triaged", "replied", "resolved", "spam"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export async function listFeedback(f: { status?: string; q?: string; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  // 管理页读带数据库侧 deadline：ILIKE 三列 OR 加 OFFSET 翻页在冷数据上能拖住整个连接。
  return adminReadOrBusy(async (db) => {
    // `fb.id` 不是装饰：这一页按 OFFSET 翻页，而 created_at 会相同（同一秒批量提交、导入的历史行），
    // 并列行没有确定次序时，同一条可能在第 1、2 页各出现一次，也可能一页都不出现。
    const rows = await db`
      SELECT fb.id, fb.content, fb.email, fb.page_url, split_part(fb.screenshot_key, ':', 1) AS screenshot, fb.source_hash, fb.status, fb.note,
             fb.forwarded_at, fb.forward_error, fb.created_at, fb.updated_at, fb.ip, fb.location,
             (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
      FROM feedback fb
      WHERE (${f.status ?? null}::text IS NULL OR fb.status = ${f.status ?? null})
        AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
      ORDER BY fb.created_at DESC, fb.id LIMIT 51 OFFSET ${(page - 1) * 50}`;
    const counts = await db<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`;
    // 51 行是为了回答「还有没有下一页」：按「这页满 50 条」推断，尾页正好满 50 时点下一页是空表。
    return { page, rows: rows.slice(0, 50), hasMore: rows.length > 50, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });
}

/** A malformed request from the back office: mapped to 400 by the admin handler, not logged as a 500. */

export async function updateFeedback(id: number, input: { status?: string; note?: string | null; version: string }, actor: string) {
  // 2026-10-02: this used to throw a bare Error, so a typo in the status reached the reader as
  // "500 internal_error / unknown status done" — an input mistake reported as a server fault.
  if (input.status && !FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) throw new InvalidInput(`unknown status ${input.status}`);
  return sql.begin(async (tx) => {
    const [before] = await tx`SELECT id, status, note, updated_at FROM feedback WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (new Date(before.updated_at as Date).toISOString() !== input.version) throw new Conflict("这条反馈已被修改，请刷新后再操作");
    const [after] = await tx`
      UPDATE feedback SET status = coalesce(${input.status ?? null}, status), note = ${input.note === undefined ? before.note : input.note}, updated_at = now()
      WHERE id = ${id} RETURNING id, status, note, updated_at`;
    // 第 8 参是 db（第 7 参是 requestId）：不传的时候 audit() 走全局 sql（另一条连接），回滚后审计行照样留下，
    // 还可能在持 FOR UPDATE 时再借一条连接。
    await audit(actor, "feedback.update", `feedback:${id}`, null, { status: before.status, note: before.note }, { status: after!.status, note: after!.note }, undefined, tx);
    return after;
  });
}

function screenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  // Same name set the writer produces (`${randomUUID()}.${ext}` in operations/feedback.ts) and the
  // forwarder accepts (notify/email.ts): lowercase hex-and-dash UUID plus a known image extension.
  // `..` and `.` are not members, so no dot-segment can travel through the join.
  return /^[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(name) ? path.join(config.dataDir, "feedback-screenshots", name) : null;
}

export async function feedbackScreenshot(id: number): Promise<string | null> {
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return screenshotPath(row?.screenshot_key ?? null);
}

/** Removes the sender's material (text, email, page, screenshot) and keeps only the handling record.
 *  The reason is optional since 2026-10-31: the operator may erase without stating one; the audit
 *  line still records who erased and when. */
export async function eraseFeedback(id: number, reason: string, actor: string) {
  const why = reason.trim() || "（未填原因）";
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  if (!row) return null;
  const file = screenshotPath(row.screenshot_key);
  // 2026-10-31 站长要求：删除后条目直接从列表消失（整行删除），不留"已按要求删除"的外壳；
  // 审计日志保留是什么被删、谁删的。投递历史表（deliveries）不动。
  // 删除与审计同一事务（2026-11-05）：审计行说"删了这条"，就不该出现"删掉了但没记录"的窗口；
  // 文件删除放在提交之后——文件系统不在事务里，先删文件再回滚会留下一条指向不存在文件的记录。
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feedback WHERE id = ${id}`;
    await audit(actor, "feedback.erase", `feedback:${id}`, why, { hadScreenshot: row.screenshot_key !== null }, null, undefined, tx);
  });
  if (file) await unlink(file).catch(() => {});
  return { erased: true };
}

/** Operator reply, straight from the site mailbox to the reader's address (2026-10-31). Sends over
 *  the same SMTP channel as the forwarder, references the feedback number, and flips the status to
 *  replied so the exchange stays inside the admin. */
export async function replyFeedback(id: number, input: { subject?: string; body: string }, actor: string) {
  const body = (input.body ?? "").trim();
  if (body.length < 2) throw new InvalidInput("请写下回复内容。");
  if (body.length > 8000) throw new InvalidInput("回复内容最多 8000 字。");
  const [fb] = await sql<{ id: number; email: string | null }[]>`
    SELECT id, email FROM feedback WHERE id = ${id}`;
  if (!fb) return null;
  if (!fb.email) throw new InvalidInput("这条反馈没有留下邮箱，无法回复。");
  const { sendOperatorReply } = await import("../notify/email.ts");
  await sendOperatorReply(fb.email, `GEOHOT 反馈 #${fb.id} 的回复`, body);
  // 状态与审计同一事务；邮件在事务之前发出——SMTP 不参与回滚，发出去的话收不回来，
  // 所以"已回复"必须在邮件确实发出之后再落库。
  await sql.begin(async (tx) => {
    await tx`UPDATE feedback SET status = 'replied', updated_at = now() WHERE id = ${id}`;
    await audit(actor, "feedback.reply", `feedback:${id}`, (input.subject ?? "").trim(), { to: fb.email }, { sent: true, status: "replied" }, undefined, tx);
  });
  return { replied: true, email: fb.email };
}