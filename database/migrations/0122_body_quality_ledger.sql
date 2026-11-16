-- Hotfix: a persistent, versioned body-quality verdict on the workflow-readiness fact.
--
-- article_workflow_readiness.ready already folds body quality in (refreshWorkflowReadinessTx sets
-- ready=false when originalBodyDefect fires), but it only stored the first reason as text. The public
-- gate needs:
--   · the full reasons list (machine-readable, for the repair queue and admin review);
--   · the body-quality rule version that produced the verdict, so a rules change invalidates old rows;
--   · a manual "reprocess this" flag and a bounded lock so the backfill script and a human reviewer
--     never double-touch the same article.
--
-- Reader reads stay header-only: nothing here makes a list scan stored bodies. The expensive
-- classifyBodyQuality run happens in the write transaction (refreshWorkflowReadinessTx), never per request.

ALTER TABLE article_workflow_readiness
  ADD COLUMN IF NOT EXISTS body_quality_status text
    CHECK (body_quality_status IN ('ok', 'defect')),
  ADD COLUMN IF NOT EXISTS body_quality_reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS body_quality_rule_version text,
  ADD COLUMN IF NOT EXISTS reprocess_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Recovery picks defective rows without scanning stored bodies; the 0096 index already covers the
-- legacy 'source:%' quality_error subset. This one covers the new verdict column.
CREATE INDEX IF NOT EXISTS article_workflow_body_defect_idx
  ON article_workflow_readiness (checked_at, article_id)
  WHERE body_quality_status = 'defect';

-- Manual-review / backfill work queue: rows a human or the repair script asked to reprocess.
CREATE INDEX IF NOT EXISTS article_workflow_reprocess_idx
  ON article_workflow_readiness (checked_at, article_id)
  WHERE reprocess_requested;
