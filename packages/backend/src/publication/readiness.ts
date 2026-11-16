import { bodyMediaReadyCondition } from "./media-readiness.ts";
// Read-time workflow gate. Keep the stored publication public so background workers can finish it.
// Only indexed facts are read here; no model calls or mutable queue-state guesses on reader requests.
import { sql, type Tx } from "../db.ts";
import { classifyBodyQuality, BODY_QUALITY_RULE_VERSION } from "../content/body-quality.ts";
import { CJK_COPY_PATTERN, hasChineseCopy } from "@aihot/contracts/copy";

// Bumped 3 -> 4 with the body-quality ledger (0122): every stored verdict now carries the full reason
// list and the rule version that produced it. Rows stamped policy_version < 4 are treated as not-yet-checked
// by recoverWorkflowReadiness, which recomputes them in bounded background work.
export const READER_POLICY_VERSION = 4;

/** Correlated against publications p; valid even when callers do not join articles/sources. */
export function rawWorkflowReadyCondition(includeMedia = true) {
  return sql`EXISTS (
    SELECT 1 FROM articles ready_a JOIN sources ready_s ON ready_s.id = ready_a.source_id
    JOIN analyses ready_an ON ready_an.article_id = ready_a.id
      AND ready_an.input_revision = ready_a.revision
    WHERE ready_a.id = p.article_id AND ready_an.id = p.analysis_id AND ready_an.relevance = 'pass'
      AND nullif(btrim(p.title), '') IS NOT NULL AND nullif(btrim(p.summary), '') IS NOT NULL
      AND (
        p.visibility = 'public' AND ready_s.site_fulltext AND p.body_mode = 'full'
        AND (
          ready_a.body_status = 'ok'
          AND CASE WHEN (
            ready_a.language = 'zh'
            OR (coalesce(ready_a.language, '') <> 'en' AND left(ready_a.body_text, 400) ~ ${CJK_COPY_PATTERN})
            OR (p.channel = 'x' AND length(btrim(regexp_replace(coalesce(ready_a.x_post->>'text', ready_a.body_text), 'https?://[^[:space:]]+', '', 'g'))) < 60)
            OR EXISTS (SELECT 1 FROM translations ready_tr
              WHERE ready_tr.article_id = ready_a.id AND ready_tr.lang = 'zh'
                AND ready_tr.revision = ready_a.revision AND ready_tr.complete
                AND nullif(btrim(ready_tr.body_html), '') IS NOT NULL
                AND nullif(btrim(ready_tr.body_text), '') IS NOT NULL
                AND ready_tr.body_text ~ ${CJK_COPY_PATTERN})
          ) THEN (nullif(btrim(ready_a.body_text), '') IS NOT NULL
            AND ${includeMedia ? bodyMediaReadyCondition() : sql`true`}) ELSE false END
        )
      )
  )`;
}


/** Background admission must not depend on media evidence it is about to create. */
export function textWorkflowReadyCondition() { return rawWorkflowReadyCondition(false); }

/**
 * The unified public condition: one place every public exit reads. A row is public only when a
 * transactionally invalidated fact says the whole workflow settled AND the stored body passed the
 * current body-quality rule (body_quality_status='ok').
 *
 * Deliberately NOT tied to policy_version: the pre-backfill script stamps body_quality_status on every
 * existing public row while leaving policy_version=3 in place, so the new API can roll out before the
 * worker backfills policy=4 rows and old-policy rows with quality=ok stay public. New writes stamp
 * policy_version=4; a row at policy=3 with quality=ok is still public here.
 */
export function workflowReadyCondition() {
  return sql`p.visibility = 'public' AND p.body_mode = 'full'
    AND EXISTS (SELECT 1 FROM sources policy_source WHERE policy_source.id=p.source_id AND policy_source.site_fulltext)
    AND EXISTS (SELECT 1 FROM article_workflow_readiness ready_workflow
    WHERE ready_workflow.article_id=p.article_id AND ready_workflow.revision=p.revision
      AND ready_workflow.analysis_id=p.analysis_id AND ready_workflow.ready
      AND ready_workflow.body_quality_status='ok')`;
}

/**
 * Reader-side probe: does this row's not-ready verdict come from a body-quality defect (the pipeline
 * settled, but the stored body is consent-wall / template-shell / too-short / …)? Detail pages use it
 * to open the safe-lead restricted page (title + summary + source + original link, no body) instead of
 * 404. A missing row or a row whose failure is upstream (analysis/translation pending) stays 404.
 */
export function bodyQualityDefectCondition() {
  return sql`EXISTS (SELECT 1 FROM article_workflow_readiness d
    WHERE d.article_id=p.article_id AND d.body_quality_status='defect' AND d.ready=false)`;
}

/** Compute only in background/write transactions, after every publication/media write has settled. */
export async function refreshWorkflowReadinessTx(tx: Tx, articleId: string): Promise<boolean> {
  const [article] = await tx<{source_id:string;url:string;body_html:string|null;body_text:string|null;title:string}[]>`SELECT source_id,url,body_html,body_text,title FROM articles WHERE id=${articleId} FOR UPDATE`;
  if (!article) return false;
  // Serialise policy changes with recomputation; the source trigger invalidates every affected fact.
  await tx`SELECT id FROM sources WHERE id=${article.source_id} FOR SHARE`;
  const [row] = await tx<{revision:number;analysis_id:number|null;ready:boolean}[]>`
    SELECT p.revision,p.analysis_id,${rawWorkflowReadyCondition()} AS ready
    FROM publications p WHERE p.article_id=${articleId}`;
  if (!row) return false;

  // Body quality verdict: one call to the stored classifier, persisted with reasons + rule version.
  // This runs in the write transaction only — never on a reader request.
  const verdict = classifyBodyQuality(article.url, article.body_html ?? "", article.body_text ?? "", { title: article.title });
  let qualityError: string | null = verdict.reasons[0] ?? null;
  if (qualityError) row.ready = false;
  {
    const [translation] = await tx<{body_html:string;body_text:string;complete:boolean}[]>`SELECT coalesce(tr.body_html,'') AS body_html,coalesce(tr.body_text,'') AS body_text,tr.complete FROM translations tr
      JOIN articles a ON a.id=tr.article_id WHERE a.id=${articleId} AND tr.lang='zh' AND tr.revision=a.revision
      AND NOT (coalesce(a.language,'')='zh' OR (coalesce(a.language,'')<>'en' AND left(a.body_text,400) ~ ${CJK_COPY_PATTERN}))`;
    if (translation?.complete) {
      const trVerdictHtml = classifyBodyQuality(article.url, translation.body_html, translation.body_text, { title: article.title });
      const trVerdictText = classifyBodyQuality(article.url, "", translation.body_text, { title: article.title });
      const trReasons = [...new Set([...trVerdictHtml.reasons, ...trVerdictText.reasons])];
      if (trReasons.length) {
        qualityError = qualityError ?? trReasons[0];
        row.ready = false;
      }
      if (!hasChineseCopy(translation.body_text)) {
        qualityError = qualityError ?? "missing-chinese-translation";
        row.ready = false;
      }
    }
  }

  await tx`INSERT INTO article_workflow_readiness(article_id,revision,analysis_id,ready,checked_at,policy_version,quality_error,
      body_quality_status,body_quality_reasons,body_quality_rule_version)
    VALUES(${articleId},${row.revision},${row.analysis_id},${row.ready},now(),${READER_POLICY_VERSION},${qualityError},
      ${verdict.status},${verdict.reasons},${BODY_QUALITY_RULE_VERSION})
    ON CONFLICT(article_id) DO UPDATE SET revision=EXCLUDED.revision,analysis_id=EXCLUDED.analysis_id,
      ready=EXCLUDED.ready,checked_at=EXCLUDED.checked_at,policy_version=EXCLUDED.policy_version,quality_error=EXCLUDED.quality_error,
      body_quality_status=EXCLUDED.body_quality_status,body_quality_reasons=EXCLUDED.body_quality_reasons,
      body_quality_rule_version=EXCLUDED.body_quality_rule_version`;
  return row.ready;
}
