// Content-group deliveries (Feishu custom-bot webhooks): selected cards and reset pushes.
// One row per target and dedupe key, so nothing is pushed twice; an outcome we cannot know
// ("unknown") is never retried automatically; content older than a target's enabled_at is never
// back-filled. FEISHU_CONTENT_PUSH_ENABLED is the safety valve: off, deliveries are recorded as
// skipped and nothing leaves the process.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { postWebhook } from "./feishu.ts";

export interface DeliveryRequest {
  subjectKind: "codex_reset" | "selected";
  subjectId: string;
  dedupeKey: string;
  /** When the underlying content appeared; older than a target's enabled_at means skip. */
  contentAt: Date;
  card: unknown;
}

interface Target {
  key: string;
  kind: "feishu_webhook" | "feishu_chat" | "log";
  enabled_at: Date | null;
  config_ref: string | null;
}

/** Default content targets; they start disabled and are switched on in production only. */
export async function ensureContentTargets() {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, config_ref, note) VALUES
      ('feishu-content-main', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_WEBHOOK_URL', '飞书内容主群'),
      ('feishu-content-mirror', 'content', 'feishu_webhook', false, 'FEISHU_PUSH_MIRROR_WEBHOOK_URL', '飞书内容镜像群')
    ON CONFLICT (key) DO NOTHING`;
}

export async function deliverContent(req: DeliveryRequest): Promise<Array<{ target: string; status: string }>> {
  const targets = await sql<Target[]>`SELECT key, kind, enabled_at, config_ref FROM notify_targets WHERE purpose = 'content' AND enabled`;
  const results: Array<{ target: string; status: string }> = [];
  for (const t of targets) {
    if (t.enabled_at && req.contentAt < t.enabled_at) continue;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status, payload)
      VALUES (${t.key}, ${req.subjectKind}, ${req.subjectId}, ${req.dedupeKey}, 'pending', ${sql.json(req.card as never)})
      ON CONFLICT (target_key, dedupe_key) DO NOTHING RETURNING id`;
    if (!row) continue; // already delivered, skipped or in doubt
    if (!config.feishuContentPushEnabled || t.kind !== "feishu_webhook") {
      await sql`UPDATE deliveries SET status = 'skipped', response = 'content push disabled', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "skipped" });
      continue;
    }
    const url = t.config_ref ? credential("integrations", t.config_ref) : undefined;
    if (!url) {
      await sql`UPDATE deliveries SET status = 'failed', response = 'webhook not configured', updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "failed" });
      continue;
    }
    await sql`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = ${row.id}`;
    try {
      const res = await postWebhook(url, req.card);
      // 三态而不是两态：只有机器人明确 ack 才算 sent；4xx 是明确拒绝 → failed；
      // 2xx 但没有 ack（拦截页、奇怪的正文）与 5xx 一样是"不知道"——报成 failed 与报成 sent 都是撒谎。
      const status = res.ok ? "sent" : res.status >= 400 && res.status < 500 ? "failed" : "unknown";
      await sql`UPDATE deliveries SET status = ${status}, response = ${res.body.slice(0, 500)}, sent_at = ${res.ok ? new Date() : null}, updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status });
    } catch (error) {
      // Timeout or connection loss after sending may still have delivered: never resend.
      await sql`UPDATE deliveries SET status = 'unknown', response = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${row.id}`;
      results.push({ target: t.key, status: "unknown" });
    }
  }
  return results;
}

/**
 * Sends a stored delivery again after an operator checked the group and found it missing. Only
 * for deliveries in doubt or definitely failed; the safety valve still applies.
 */
/** 409：这一行现在不能被这次点击重发。`adminHandler` 按 `code === "conflict"` 转 409，文案直接给运营看。 */
class Rejected extends Error {
  readonly code = "conflict";
}

/** 人工重发的次数上限：超过就必须在后台改判（已送达 / 放弃），不能让一次点击无限重来。 */
const MAX_RESENDS = 3;

export async function resendDelivery(id: number): Promise<{ status: string }> {
  const [d] = await sql<{ status: string; payload: unknown; target_key: string; config_ref: string | null; kind: string; attempts: number; subject_kind: string; subject_id: string }[]>`
    SELECT d.status, d.payload, d.target_key, t.config_ref, t.kind, d.attempts, d.subject_kind, d.subject_id
    FROM deliveries d JOIN notify_targets t ON t.key = d.target_key WHERE d.id = ${id}`;
  if (!d) throw new Rejected("这条投递记录不存在，请刷新列表");
  if (d.status !== "unknown" && d.status !== "failed") throw new Rejected(`这条投递现在是「${d.status}」，不需要重发`);
  if (d.attempts >= MAX_RESENDS) throw new Rejected(`这条已经试过 ${d.attempts} 次，请改判「已送达」或「放弃」，不要再重发`);
  if (!config.feishuContentPushEnabled || d.kind !== "feishu_webhook") throw new Rejected("内容推送在这个环境是关闭的（FEISHU_CONTENT_PUSH_ENABLED=false），无法重发");
  const url = d.config_ref ? credential("integrations", d.config_ref) : undefined;
  if (!url) throw new Rejected("这个群没有配 webhook 地址（凭据缺失），无法重发");
  // 只推还在公开精选里的那条：编辑撤回之后重放旧卡片，等于把已经收回的东西再发给一群真人。
  if (d.subject_kind === "selected") {
    const [live] = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE article_id = ${d.subject_id} AND visibility = 'public' AND selected`;
    if (!live) throw new Rejected("这条内容已经不是公开精选了（被撤回或取消精选），不重发");
  }
  // 领取这一行：条件写在这里，两个标签页或一次双击只有一次能真的发出去。
  // 以前是先读状态、再无条件 `status = 'sending'`——那正是 `resolveDelivery` 这一轮刚修掉的同一个洞，
  // 而这里的后果不是数据难看，是真人群里收到两张一样的卡。
  const claimed = await sql`
    UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now()
    WHERE id = ${id} AND status IN ('unknown', 'failed') RETURNING attempts`;
  if (!claimed.count) throw new Rejected("这条投递刚刚被另一次操作领走了，请刷新后看它的结果");
  try {
    const res = await postWebhook(url, d.payload);
    const status = res.ok ? "sent" : res.status >= 400 && res.status < 500 ? "failed" : "unknown";
    await sql`UPDATE deliveries SET status = ${status}, response = ${res.body.slice(0, 500)}, sent_at = ${res.ok ? new Date() : null}, updated_at = now() WHERE id = ${id}`;
    return { status };
  } catch (error) {
    await sql`UPDATE deliveries SET status = 'unknown', response = ${String(error).slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
    return { status: "unknown" };
  }
}

/**
 * Deliveries a stopped process left half way: "sending" may have reached the group, so it becomes
 * "unknown" (alerted, resolved in the admin); "pending" never left, so it becomes "failed" (the
 * admin can send it). Nothing is re-sent automatically.
 */
export async function markStaleDeliveries(): Promise<{ unknown: number; failed: number }> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const unknown = await sql`UPDATE deliveries SET status = 'unknown', response = coalesce(response, '发送中进程中断，是否送达未知'), updated_at = now()
                            WHERE status = 'sending' AND updated_at < ${cutoff}`;
  const failed = await sql`UPDATE deliveries SET status = 'failed', response = coalesce(response, '发送前进程中断，没有发出'), updated_at = now()
                           WHERE status = 'pending' AND updated_at < ${cutoff}`;
  return { unknown: unknown.count, failed: failed.count };
}
