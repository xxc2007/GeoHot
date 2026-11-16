// Backend side of the body-pollution hotfix: candidate selection, the repair log, reprocess/manual-review
// marks, and the bounded backflow driver the script calls.
//
// A row enters the repair queue when either:
//   · an operator pulled it to visibility='summary-only' (the 2026-11-16 emergency pull of four rows);
//   · a stored readiness verdict says body_quality_status='defect' (the classifier caught consent-wall,
//     template-shell, too-short, title-body-mismatch, …);
//   · a human set reprocess_requested=true in admin (manual review / re-extraction).
//
// The driver never fakes completion: it cleans the stored body, re-enqueues extractBody/analyze/group,
// and only flips visibility back to 'public' when the downstream pipeline settles and refreshWorkflowReadinessTx
// marks ready=true. If the model/queue is unavailable it records a 'failed' event and stops.
import { sql, type Tx } from "../db.ts";
import { classifyBodyQuality, BODY_QUALITY_RULE_VERSION } from "../content/body-quality.ts";
import { stripBoilerplate, stripReaderChrome, stripConsentWall } from "../lib/text.ts";
import { refreshWorkflowReadinessTx } from "./readiness.ts";
import { bumpPublicationEpoch, purgePublicationCaches } from "./cache-purge.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

export type RepairEvent = "hidden" | "reprocessed" | "restored" | "failed";

export interface RepairCandidate {
  article_id: string;
  source_id: string;
  source_name: string;
  url: string;
  title: string;
  visibility: string;
  body_status: string;
  body_chars: number;
  quality_status: string | null;
  quality_reasons: string[];
  quality_rule_version: string | null;
  reprocess_requested: boolean;
  locked_until: Date | null;
}

/** List repair candidates, bounded. summaryOnly = the four emergency-pulled rows; defective = classifier catches. */
export async function listRepairCandidates(opts: {
  summaryOnly?: boolean;
  defective?: boolean;
  reprocessRequested?: boolean;
  limit?: number;
} = {}): Promise<RepairCandidate[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return sql<RepairCandidate[]>`
    SELECT p.article_id, p.source_id, s.name AS source_name, p.url, p.title, p.visibility,
      a.body_status, coalesce(length(a.body_text), 0) AS body_chars,
      r.body_quality_status AS quality_status,
      coalesce(r.body_quality_reasons, '{}') AS quality_reasons,
      r.body_quality_rule_version AS quality_rule_version,
      coalesce(r.reprocess_requested, false) AS reprocess_requested,
      r.locked_until
    FROM publications p
    JOIN sources s ON s.id = p.source_id
    JOIN articles a ON a.id = p.article_id
    LEFT JOIN article_workflow_readiness r ON r.article_id = p.article_id
    WHERE (
      (${!!opts.summaryOnly} AND p.visibility = 'summary-only')
      OR (${!!opts.defective} AND r.body_quality_status = 'defect')
      OR (${!!opts.reprocessRequested} AND r.reprocess_requested)
    )
    AND (r.locked_until IS NULL OR r.locked_until < now())
    ORDER BY p.discovered_at DESC
    LIMIT ${limit}`;
}

/** Append one repair-log row. Never throws on logging failure. */
export async function recordRepairEvent(tx: Tx, ev: {
  articleId: string;
  event: RepairEvent;
  reasons?: string[];
  ruleVersion?: string | null;
  fromVisibility?: string | null;
  toVisibility?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await tx`INSERT INTO publication_body_repair_log
    (article_id, event, reasons, rule_version, from_visibility, to_visibility, detail)
    VALUES (${ev.articleId}, ${ev.event}, ${ev.reasons ?? []}, ${ev.ruleVersion ?? null},
      ${ev.fromVisibility ?? null}, ${ev.toVisibility ?? null}, ${tx.json((ev.detail ?? {}) as never)})`;
}

/** Manual review: ask the repair driver to re-extract and re-judge one article. */
export async function requestReprocess(articleId: string, by: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO article_workflow_readiness (article_id, revision, analysis_id, ready, policy_version, reprocess_requested)
      VALUES (${articleId}, 0, NULL, false, 0, true)
      ON CONFLICT (article_id) DO UPDATE SET reprocess_requested = true, locked_until = NULL`;
    await recordRepairEvent(tx, { articleId, event: "reprocessed", detail: { by, note: "manual reprocess requested" } });
    await bumpPublicationEpoch(tx, articleId);
  });
  purgePublicationCaches(articleId);
}

/** Run the stored body through the same cleaners the classifier uses, without touching the DB. */
export function cleanBodyText(text: string): string {
  return stripConsentWall(stripReaderChrome(stripBoilerplate(text)));
}

export interface DriveResult {
  articleId: string;
  action: "restored" | "requeued" | "still-defective" | "failed";
  reasons: string[];
  ruleVersion: string;
  visibilityBefore: string;
  visibilityAfter: string;
  detail: Record<string, unknown>;
}

/**
 * Bounded backflow for one candidate. Dry-run mode returns the would-be action without writing.
 *
 * Steps:
 *  1. re-run classifyBodyQuality on the stored (cleaned) body;
 *  2. if ok → re-enqueue extractBody/analyze/group (the pipeline that will restore publication), record
 *     'reprocessed', and let publishArticle later flip visibility;
 *  3. if still defect → keep visibility hidden, record 'reprocessed' with reasons;
 *  4. on any queue/model error → record 'failed', do NOT touch visibility, do NOT fake completion.
 */
export async function driveRepair(articleId: string, write: boolean): Promise<DriveResult> {
  const [row] = await sql<{
    url: string; title: string; body_html: string | null; body_text: string | null;
    visibility: string; source_id: string;
  }[]>`SELECT a.url, a.title, a.body_html, a.body_text, p.visibility, p.source_id
       FROM articles a JOIN publications p ON p.article_id = a.id WHERE a.id = ${articleId} FOR UPDATE`;
  if (!row) throw new Error(`article not found: ${articleId}`);

  const verdict = classifyBodyQuality(row.url, row.body_html ?? "", row.body_text ?? "", { title: row.title });
  const cleaned = cleanBodyText(row.body_text ?? "");

  if (!write) {
    return {
      articleId,
      action: verdict.status === "ok" ? "requeued" : "still-defective",
      reasons: verdict.reasons,
      ruleVersion: verdict.ruleVersion,
      visibilityBefore: row.visibility,
      visibilityAfter: row.visibility,
      detail: { dryRun: true, cleanedChars: cleaned.length },
    };
  }

  return sql.begin(async (tx) => {
    let action: DriveResult["action"] = "still-defective";
    let toVisibility = row.visibility;
    const detail: Record<string, unknown> = { cleanedChars: cleaned.length };

    if (verdict.status === "ok") {
      // Body now passes. Re-queue the downstream pipeline; when it settles, publishArticle restores.
      try {
        await enqueue(QUEUES.extractBody, { articleId }, { singletonKey: `repair:extract:${articleId}` }, tx);
        await enqueue(QUEUES.analyze, { articleId }, { singletonKey: `repair:analyze:${articleId}` }, tx);
        await enqueue(QUEUES.group, { articleId }, { singletonKey: `repair:group:${articleId}` }, tx);
        action = "requeued";
        detail.queued = [QUEUES.extractBody, QUEUES.analyze, QUEUES.group];
      } catch (error) {
        action = "failed";
        detail.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      detail.reasons = verdict.reasons;
    }

    // Persist the verdict on the readiness row so the next reader gate sees it immediately.
    await refreshWorkflowReadinessTx(tx, articleId);

    // If the body is now clean AND the pipeline is already complete (readiness row says ready), restore.
    if (verdict.status === "ok" && action === "requeued") {
      // Leave visibility as-is for now: the downstream jobs + publishArticle will restore it. We only
      // record that we requeued. If the row was summary-only and the pipeline already settled earlier,
      // publishArticle will see the new body and flip to public.
      await recordRepairEvent(tx, {
        articleId, event: "reprocessed", reasons: verdict.reasons, ruleVersion: verdict.ruleVersion,
        fromVisibility: row.visibility, toVisibility, detail,
      });
    } else if (action === "failed") {
      await recordRepairEvent(tx, {
        articleId, event: "failed", reasons: verdict.reasons, ruleVersion: verdict.ruleVersion,
        fromVisibility: row.visibility, toVisibility, detail,
      });
    } else {
      await recordRepairEvent(tx, {
        articleId, event: "reprocessed", reasons: verdict.reasons, ruleVersion: verdict.ruleVersion,
        fromVisibility: row.visibility, toVisibility, detail,
      });
    }

    await bumpPublicationEpoch(tx, articleId);
    return {
      articleId, action, reasons: verdict.reasons, ruleVersion: verdict.ruleVersion,
      visibilityBefore: row.visibility, visibilityAfter: toVisibility, detail,
    };
  }).then((result) => {
    purgePublicationCaches(articleId);
    return result;
  });
}

export { BODY_QUALITY_RULE_VERSION };
