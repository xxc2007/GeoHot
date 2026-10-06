// Feedback handling: list, status and note, per-source bans, and deletion on request
// (privacy notice: feedback material is removed once handling ends or when the sender asks).
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
           fb.forwarded_at, fb.forward_error, fb.created_at, fb.updated_at,
           EXISTS (SELECT 1 FROM feedback_bans b WHERE b.source_hash = fb.source_hash) AS banned,
           (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
    FROM feedback fb
    WHERE (${f.status ?? null}::text IS NULL OR fb.status = ${f.status ?? null})
      AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
    ORDER BY fb.created_at DESC, fb.id LIMIT 50 OFFSET ${(page - 1) * 50}`;
  const counts = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`;
  const bans = await sql`SELECT source_hash, reason, created_by, created_at FROM feedback_bans ORDER BY created_at DESC LIMIT 100`;
  return { page, rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), bans };
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

/** Refuses further feedback from one source (an unreadable hash of IP and browser family). */
export async function banSource(sourceHash: string, reason: string, actor: string) {
  // An empty hash would ban nothing and still leave a row; an empty reason is not a signed decision.
  if (!sourceHash?.trim()) throw new InvalidInput("缺少要封禁的来源标识");
  if (!reason?.trim()) throw new InvalidInput("reason is required");
  await sql`INSERT INTO feedback_bans (source_hash, reason, created_by) VALUES (${sourceHash}, ${reason}, ${actor}) ON CONFLICT (source_hash) DO NOTHING`;
  await audit(actor, "feedback.ban", `feedback-source:${sourceHash}`, reason, null, null);
}

export async function unbanSource(sourceHash: string, actor: string) {
  const rows = await sql`DELETE FROM feedback_bans WHERE source_hash = ${sourceHash} RETURNING reason`;
  if (rows.length) await audit(actor, "feedback.unban", `feedback-source:${sourceHash}`, null, { reason: rows[0]!.reason }, null);
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

/** Removes the sender's material (text, email, page, screenshot) and keeps only the handling record. */
export async function eraseFeedback(id: number, reason: string, actor: string) {
  if (!reason.trim()) throw new InvalidInput("reason is required");
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  if (!row) return null;
  const file = screenshotPath(row.screenshot_key);
  // The row is cleared first. Unlinking first meant that a failing UPDATE left a feedback row still
  // advertising a `screenshot_key` whose file was already gone — the 后台 thumbnail broken forever, and
  // the privacy promise of this command is kept either way: only the path is removed here.
  await sql`UPDATE feedback SET content = '（已按要求删除）', email = NULL, page_url = NULL, screenshot_key = NULL, updated_at = now() WHERE id = ${id}`;
  if (file) await unlink(file).catch(() => {});
  await audit(actor, "feedback.erase", `feedback:${id}`, reason, null, null);
  return { erased: true };
}
