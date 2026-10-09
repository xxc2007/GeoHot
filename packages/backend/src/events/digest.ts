// Story digest: rewritten incrementally as reports arrive; contradictions with earlier reporting are
// stated explicitly. v1 `digest` and `latest` read the same stored version.
//
// Nothing here publishes prose nobody wrote. The digest, its title and its latest line are reader-facing
// editorial judgement, so an answer the stub assembled from a rule (`usage.brain.rule`, no fixture, no
// author — see editorial/provenance.ts) leaves the story exactly as it was: the same honest empty state the
// writing side chose for items without human Chinese copy. The rule is still recorded (on the receipt, and
// on `stories.frame.digest`) so the admin can list the surfaces that are waiting for a signature.
import { z } from "zod";
import { modelFor } from "../editorial/models.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { machineRuleOf } from "../editorial/provenance.ts";
import { guardedStoryTitle, looksZh, type TranslateInput } from "../editorial/writing.ts";
import { storyReports, type StoryReport } from "./story-reports.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const DIGEST_PROMPT_VERSION = promptVersion("story-digest");

const SYSTEM = promptText("story-digest");

// `digest` may come back empty: that is the stub's honest "no human wrote this" answer, and the caller
// decides what to do with it (keep the previous digest). A too-short or non-Chinese answer is refused the
// same way, not sent through a retry that would only produce another unsigned sentence.
const Schema = z.object({
  title: z.string().max(120).catch(""),
  digest: z.string().max(2000).catch(""),
  latest: z.string().max(300).catch(""),
});

export function storyStatusFor(latestAt: Date | null, now = Date.now()): "active" | "watching" | "settled" {
  if (!latestAt) return "settled";
  const age = now - latestAt.getTime();
  if (age < 24 * 3600 * 1000) return "active";
  if (age < 72 * 3600 * 1000) return "watching";
  return "settled";
}

/**
 * The shortest digest a reader is served. The prompt asks 150–400 字 (`industry/prompts/story-digest.md`),
 * and this floor is deliberately far below that: it refuses *a sentence posing as a 综述*, not a short
 * but real one. Set from the signed pack rather than by feel — the 19 authored digests in
 * `tooling/fixtures/digest.jsonl` run 138–409 字 (measured 2026-10-05), so 60 rejects nothing anybody
 * wrote while the old `10` rejected nothing at all (it was reached only by an answer of nine characters).
 */
const MIN_DIGEST_CHARS = 60;

/**
 * Why these words cannot go on the event page, or null when they can. One test, asked in two places: the
 * writer uses it to keep the digest the story already has, and `chatJson` uses it to refuse the receipt, so
 * an answer we would not publish is not served to us again for free on every later attempt.
 */
function unusableCopy(data: { digest: string; latest: string }): string | null {
  const digest = data.digest.trim();
  const latest = data.latest.trim();
  if (digest.length < MIN_DIGEST_CHARS) return `综述只有 ${digest.length} 字，下限 ${MIN_DIGEST_CHARS}`;
  if (!looksZh(digest)) return "综述不是中文";
  if (latest && !looksZh(latest)) return "进展句不是中文";
  return null;
}

/** What the event's own reports say: the only evidence a digest title may name. */
function reportsIdentity(reports: StoryReport[]): TranslateInput {
  return {
    title: reports.map((r) => r.title).join("\n"),
    text: reports.map((r) => `${r.sourceName}｜${r.title}｜${r.summary ?? ""}`).join("\n"),
    sourceKind: "rss",
  };
}

/**
 * `afterCorrection`: an editor changed a report of this story; rewrite even when older versions lack inputs.
 * `force`: rewrite although the reports and their copy are unchanged — the case is a corrected *writing
 * fixture* (the digest is served by the local stub) or an operator who decided the current version must go.
 * Without it the inputs hash matches and this returns early, which looked exactly like "nothing to fix".
 *
 * `requestId`: which operator action this forced rewrite is. It goes into the paid call's attempt tag, so
 * two separate "重写综述" clicks are two separate questions. Without it the tag was
 * `force-digest:<story>:<version>`, and a *refused* rewrite does not bump the version — so the second click
 * replayed the first click's receipt and the rewrite could never happen at all (measured 2026-10-05 in the
 * test database: three different forced calls sharing `force-digest:764:2`, all answering with the first
 * one's discarded text). Double-click protection belongs on the queue's singleton key, not here.
 */
export async function composeStoryDigest(
  storyId: number,
  opts: { afterCorrection?: boolean; force?: boolean; requestId?: string } = {},
): Promise<{ updated: boolean; version?: number; reason?: string }> {
  const [story] = await sql<{ id: number; title: string; digest: string | null; version: number; origin: string; frame: unknown }[]>`
    SELECT id, title, digest, version, origin, frame FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false, reason: "no-story" };
  const reports = await storyReports(storyId);
  if (reports.length === 0) return { updated: false, reason: "no-reports" };
  const ids = reports.map((r) => r.id).sort();
  // What this version is written from: the reports and what they currently say (corrections included).
  const inputsHash = sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.title, r.summary ?? ""])));
  const [last] = await sql<{ article_ids: string[]; inputs_hash: string | null; machine_rule: string | null }[]>`
    SELECT d.article_ids, d.inputs_hash, d.machine_rule
    FROM story_digests d
    WHERE d.story_id = ${storyId} ORDER BY d.version DESC LIMIT 1`;
  const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
  // 在服务的那一版是谁写的，决定"要不要重算"。规则答的那一版**不算已经写过**：否则这一条永远
  // 在 `unchanged` 上早退，人写的中文稿再也进不去，而运营手动重跑看到的是"没什么要改"。
  // 2026-10-06 前这一句读的是那笔回执的 `usage.brain.rule`（迁移 0047 之前），也就把回执表钉成
  // 永远不能清理：行一删，读出来就是"不是机器写的"。现在标记就在行自己身上。
  const servedIsMachine = !!last?.machine_rule;
  // 上一轮为这批完全相同的输入试过并且被拒（机器答的）。不记这个 hash 的话，每次触发都重新付一次
  // 一笔明知会被拒的调用（本机实测 302 条 `rule:no-signed-copy(digest)`，一个故事一笔）。
  const refusal = (story.frame as { digest?: { refusedHash?: string } } | null | undefined)?.digest;
  const refusedForTheseInputs = !!refusal?.refusedHash && refusal.refusedHash === inputsHash;
  // Versions written before inputs were recorded compare by report set only.
  if (!opts.force && sameReports && !servedIsMachine && (last!.inputs_hash === inputsHash || (last!.inputs_hash === null && !opts.afterCorrection))) return { updated: false, reason: "unchanged" };
  if (!opts.force && refusedForTheseInputs) return { updated: false, reason: "unsigned-for-these-inputs" };
  // Same reports, different content: an editor corrected one. Rewrite from the reports as they are now,
  // without the previous digest, so a corrected fact does not survive as "earlier reports said".
  const corrected = sameReports;
  const known = new Set(last?.article_ids ?? []);

  const lines = reports.slice(-40).map((r) => `${corrected || known.has(r.id) ? "" : "【新】"}${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.sourceName}${r.firstParty ? "（一手）" : ""}｜${r.title}｜${(r.summary ?? "").slice(0, 220)}`);
  const user = corrected
    ? `事件当前标题：${story.title}\n\n报道内容经过编辑更正。请只依据下面这些报道的当前内容重写综述，不要沿用以前版本的说法。\n报道（按时间）：\n${lines.join("\n")}`
    : `事件当前标题：${story.title}\n${story.digest ? `上一版综述：${story.digest}\n` : ""}\n报道（按时间，标【新】的是上一版之后的新报道）：\n${lines.join("\n")}`;
  // One event keeps one voice: the shard key is the story id, not this revision of its digest, whose
  // subject carries the report count and would hand a growing event to a different writer each time.
  const workUnit = `story:${storyId}`;
  const res = await chatJson({
    model: await modelFor("digest", String(storyId)), purpose: "story_digest", subject: `${workUnit}@${ids.length}`, promptVersion: DIGEST_PROMPT_VERSION,
    system: SYSTEM, user, schema: Schema, temperature: 0.3, maxTokens: 1200,
    usable: unusableCopy,
    // A forced rewrite must be a *new* request: the same prompt and report set hash to the same receipt,
    // so without an attempt tag the provider hands back the very answer the operator is trying to replace
    // (measured 2026-10-02: the rewrite "succeeded" and the page still showed the corrected number).
    attemptTag: opts.force ? `force-digest:${storyId}:${opts.requestId ?? story.version}` : undefined,
  });

  // Whose words are these? A fixture answered (authored, signed) or a rule did (assembled from the request).
  const rule = machineRuleOf(res.usage);
  const digest = res.data.digest.trim();
  const latest = res.data.latest.trim();
  const unsigned = !!rule || !!unusableCopy(res.data);
  // The title is the event page heading and the hot-list entry: the identity guard built from this event's
  // reports decides it, Chinese or nothing, and a failure keeps the title the story already has.
  const nextTitle = rule ? null : guardedStoryTitle(res.data.title, reportsIdentity(reports));

  // Locked and computed inside the write: `story_digests` is keyed (story_id, version), the worker runs at
  // concurrency 3 and merges, corrections and the editor's rewrite enqueue under different singleton keys,
  // so reading `version` before the call let two runs pick the same one (a PK violation and burned retries).
  const written = await sql.begin(async (tx) => {
    const [now] = await tx<{ version: number; title: string; digest: string | null; origin: string }[]>`
      SELECT version, title, digest, origin FROM stories WHERE id = ${storyId} AND merged_into IS NULL FOR UPDATE`;
    // It stopped being a live story while the answer was in flight (merged away): nothing to update.
    if (!now) return { updated: false, reason: "merged" };
    await completeReceipt(tx, res.receiptId);
    if (unsigned) {
      // Keep the served digest. Record why there is no new one, where an operator can find it —
      // including the hash of the inputs this refusal was about, so the same question is not paid for
      // again on every trigger (only `force`, or changed inputs, asks the model again).
      await tx`UPDATE stories SET frame = coalesce(frame, '{}'::jsonb) || ${tx.json({
        digest: { at: new Date().toISOString(), rule: rule ?? "no-signed-copy", receiptId: res.receiptId, reports: ids.length, refusedHash: inputsHash },
      } as never)} WHERE id = ${storyId}`;
      return { updated: false, reason: rule ? `unsigned:${rule}` : "no-usable-copy" };
    }
    const [top] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM story_digests WHERE story_id = ${storyId}`;
    const version = Math.max(Number(now.version), Number(top?.v ?? 0)) + 1;
    // No accepted title means the story keeps the heading it has (read again under the lock).
    const title = nextTitle ?? now.title;
    // 走到这里 `rule` 一定是 null（unsigned 在上面早退），但仍然显式写进 `machine_rule`：
    // 这一列是"这一版是谁写的"的**唯一**记录（迁移 0047 之前它藏在回执的 usage 里），
    // 让写入点自己说清楚，日后闸门放松时这一列也自动跟着是真的。
    await tx`INSERT INTO story_digests (story_id, version, digest, latest, receipt_id, article_ids, inputs_hash, machine_rule)
             VALUES (${storyId}, ${version}, ${digest}, ${latest || null}, ${res.receiptId}, ${ids}, ${inputsHash}, ${rule})`;
    await tx`UPDATE stories SET digest = ${digest}, latest = ${latest || null}, digest_updated_at = now(),
               title = CASE WHEN origin = 'manual' THEN title ELSE ${title} END,
               frame = coalesce(frame, '{}'::jsonb) || ${tx.json({ digest: { at: new Date().toISOString(), rule: null, receiptId: res.receiptId } } as never)},
               version = ${version}, updated_at = now()
             WHERE id = ${storyId}`;
    return { updated: true, version };
  });
  return written;
}

/** Periodic: statuses follow activity (持续更新 / 观察中 / 历史事件). */
export async function refreshStoryStatuses(): Promise<{ updated: number }> {
  const res = await sql`
    UPDATE stories SET status = CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END
    WHERE merged_into IS NULL AND status <> CASE
      WHEN latest_at > now() - interval '24 hours' THEN 'active'
      WHEN latest_at > now() - interval '72 hours' THEN 'watching'
      ELSE 'settled' END`;
  return { updated: res.count };
}
