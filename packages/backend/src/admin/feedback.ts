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

export const FEEDBACK_STATUSES = ["new", "triaged", "replied", "resolved", "spam"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export async function listFeedback(f: { status?: string; q?: string; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  // `fb.id` 不是装饰：这一页按 OFFSET 翻页，而 created_at 会相同（同一秒批量提交、导入的历史行），
  // 并列行没有确定次序时，同一条可能在第 1、2 页各出现一次，也可能一页都不出现。
  const rows = await sql`
    SELECT fb.id, fb.content, fb.email, fb.page_url, split_part(fb.screenshot_key, ':', 1) AS screenshot, fb.source_hash, fb.status, fb.note,
           fb.forwarded_at, fb.forward_error, fb.created_at, fb.updated_at, fb.ip, fb.location,
           (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
    FROM feedback fb
    WHERE (${f.status ?? null}::text IS NULL OR fb.status = ${f.status ?? null})
      AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
    ORDER BY fb.created_at DESC, fb.id LIMIT 50 OFFSET ${(page - 1) * 50}`;
  const counts = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`;
  return { page, rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
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
    await audit(actor, "feedback.update", `feedback:${id}`, null, { status: before.status, note: before.note }, { status: after!.status, note: after!.note });
    return after;
  });
}

function screenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  return /^[\w.-]+$/.test(name) ? path.join(config.dataDir, "feedback-screenshots", name) : null;
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
  // The row is cleared first. Unlinking first meant that a failing UPDATE left a feedback row still
  // advertising a `screenshot_key` whose file was already gone — the 后台 thumbnail broken forever, and
  // the privacy promise of this command is kept either way: only the path is removed here.
  await sql`UPDATE feedback SET content = '（已按要求删除）', email = NULL, page_url = NULL, screenshot_key = NULL, updated_at = now() WHERE id = ${id}`;
  if (file) await unlink(file).catch(() => {});
  await audit(actor, "feedback.erase", `feedback:${id}`, why, null, null);
  return { erased: true };
}
