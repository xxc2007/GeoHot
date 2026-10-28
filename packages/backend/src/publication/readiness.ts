import { bodyMediaReadyCondition } from "./media-readiness.ts";
// Read-time workflow gate. Keep the stored publication public so background workers can finish it.
// Only indexed facts are read here; no model calls or mutable queue-state guesses on reader requests.
import { sql, type Tx } from "../db.ts";
import { translationTextDefect, originalBodyDefect } from "../content/body-quality.ts";
import { CJK_COPY_PATTERN, hasChineseCopy } from "@aihot/contracts/copy";

export const READER_POLICY_VERSION = 3;

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

/** Public aggregate reads touch only headers. Triggers delete this fact in the mutating transaction. */
export function workflowReadyCondition() {
  return sql`p.visibility = 'public' AND p.body_mode = 'full'
    AND EXISTS (SELECT 1 FROM sources policy_source WHERE policy_source.id=p.source_id AND policy_source.site_fulltext)
    AND EXISTS (SELECT 1 FROM article_workflow_readiness ready_workflow
    WHERE ready_workflow.article_id=p.article_id AND ready_workflow.revision=p.revision
      AND ready_workflow.analysis_id=p.analysis_id AND ready_workflow.ready AND ready_workflow.policy_version=${READER_POLICY_VERSION})`;
}

/** Compute only in background/write transactions, after every publication/media write has settled. */
export async function refreshWorkflowReadinessTx(tx: Tx, articleId: string): Promise<boolean> {
  const [article] = await tx<{source_id:string;url:string;body_html:string|null;body_text:string|null}[]>`SELECT source_id,url,body_html,body_text FROM articles WHERE id=${articleId} FOR UPDATE`;
  if (!article) return false;
  // Serialise policy changes with recomputation; the source trigger invalidates every affected fact.
  await tx`SELECT id FROM sources WHERE id=${article.source_id} FOR SHARE`;
  const [row] = await tx<{revision:number;analysis_id:number|null;ready:boolean}[]>`
    SELECT p.revision,p.analysis_id,${rawWorkflowReadyCondition()} AS ready
    FROM publications p WHERE p.article_id=${articleId}`;
  if (!row) return false;
  let qualityError:string|null=originalBodyDefect(article.url,article.body_html??'',article.body_text??'');
  if(qualityError)row.ready=false;
  {
    const [translation] = await tx<{body_html:string;body_text:string;complete:boolean}[]>`SELECT coalesce(tr.body_html,'') AS body_html,coalesce(tr.body_text,'') AS body_text,tr.complete FROM translations tr
      JOIN articles a ON a.id=tr.article_id WHERE a.id=${articleId} AND tr.lang='zh' AND tr.revision=a.revision
      AND NOT (coalesce(a.language,'')='zh' OR (coalesce(a.language,'')<>'en' AND left(a.body_text,400) ~ ${CJK_COPY_PATTERN}))`;
    if(translation?.complete) {
      qualityError=qualityError||translationTextDefect(translation.body_html)||translationTextDefect(translation.body_text)||(!hasChineseCopy(translation.body_text)?'missing-chinese-translation':null);
      if(qualityError)row.ready=false;
    }
  }
  await tx`INSERT INTO article_workflow_readiness(article_id,revision,analysis_id,ready,checked_at,policy_version,quality_error)
    VALUES(${articleId},${row.revision},${row.analysis_id},${row.ready},now(),${READER_POLICY_VERSION},${qualityError})
    ON CONFLICT(article_id) DO UPDATE SET revision=EXCLUDED.revision,analysis_id=EXCLUDED.analysis_id,
      ready=EXCLUDED.ready,checked_at=EXCLUDED.checked_at,policy_version=EXCLUDED.policy_version,quality_error=EXCLUDED.quality_error`;
  return row.ready;
}
