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

/** The shortest digest a reader is served (the prompt asks 150–400 字; below this it is not a 综述). */
const MIN_DIGEST_CHARS = 10;

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
 */
export async function composeStoryDigest(
  storyId: number,
  opts: { afterCorrection?: boolean; force?: boolean } = {},
): Promise<{ updated: boolean; version?: number; reason?: string }> {
  const [story] = await sql<{ id: number; title: string; digest: string | null; version: number; origin: string }[]>`
    SELECT id, title, digest, version, origin FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false, reason: "no-story" };
  const reports = await storyReports(storyId);
  if (reports.length === 0) return { updated: false, reason: "no-reports" };
  const ids = reports.map((r) => r.id).sort();
  // What this version is written from: the reports and what they currently say (corrections included).
  const inputsHash = sha256(stableJson([...reports].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.title, r.summary ?? ""])));
  const [last] = await sql<{ article_ids: string[]; inputs_hash: string | null }[]>`
    SELECT article_ids, inputs_hash FROM story_digests WHERE story_id = ${storyId} ORDER BY version DESC LIMIT 1`;
  const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
  // Versions written before inputs were recorded compare by report set only.
  if (!opts.force && sameReports && (last!.inputs_hash === inputsHash || (last!.inputs_hash === null && !opts.afterCorrection))) return { updated: false, reason: "unchanged" };
  // Same reports, different content: an editor corrected one. Rewrite from the reports as they are now,
  // without the previous digest, so a corrected fact does not survive as "earlier reports said".
  const corrected = sameReports;
  const known = new Set(last?.article_ids ?? []);

  const lines = reports.slice(-40).map((r) => `${corrected || known.has(r.id) ? "" : "【新】"}${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.sourceName}${r.firstParty ? "（一手）" : ""}｜${r.title}｜${(r.summary ?? "").slice(0, 220)}`);
  const user = corrected
    ? `事件当前标题：${story.title}\n\n报道内容经过编辑更正。请只依据下面这些报道的当前内容重写综述，不要沿用以前版本的说法。\n报道（按时间）：\n${lines.join("\n")}`
    : `事件当前标题：${story.title}\n${story.digest ? `上一版综述：${story.digest}\n` : ""}\n报道（按时间，标【新】的是上一版之后的新报道）：\n${lines.join("\n")}`;
  const res = await chatJson({
    model: await modelFor("digest"), purpose: "story_digest", subject: `story:${storyId}@${ids.length}`, promptVersion: DIGEST_PROMPT_VERSION,
    system: SYSTEM, user, schema: Schema, temperature: 0.3, maxTokens: 1200,
    // A forced rewrite must be a *new* request: the same prompt and report set hash to the same receipt,
    // so without an attempt tag the provider hands back the very answer the operator is trying to replace
    // (measured 2026-10-02: the rewrite "succeeded" and the page still showed the corrected number).
    attemptTag: opts.force ? `force-digest:${storyId}:${story.version}` : undefined,
  });

  // Whose words are these? A fixture answered (authored, signed) or a rule did (assembled from the request).
  const rule = machineRuleOf(res.usage);
  const digest = res.data.digest.trim();
  const latest = res.data.latest.trim();
  const unsigned = !!rule || digest.length < MIN_DIGEST_CHARS || !looksZh(digest) || (!!latest && !looksZh(latest));
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
      // Keep the served digest. Record why there is no new one, where an operator can find it.
      await tx`UPDATE stories SET frame = coalesce(frame, '{}'::jsonb) || ${tx.json({
        digest: { at: new Date().toISOString(), rule: rule ?? "no-signed-copy", receiptId: res.receiptId, reports: ids.length },
      } as never)} WHERE id = ${storyId}`;
      return { updated: false, reason: rule ? `unsigned:${rule}` : "no-usable-copy" };
    }
    const [top] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM story_digests WHERE story_id = ${storyId}`;
    const version = Math.max(Number(now.version), Number(top?.v ?? 0)) + 1;
    // No accepted title means the story keeps the heading it has (read again under the lock).
    const title = nextTitle ?? now.title;
    await tx`INSERT INTO story_digests (story_id, version, digest, latest, receipt_id, article_ids, inputs_hash)
             VALUES (${storyId}, ${version}, ${digest}, ${latest || null}, ${res.receiptId}, ${ids}, ${inputsHash})`;
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
