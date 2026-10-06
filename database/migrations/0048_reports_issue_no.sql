-- 「第 N 期」 becomes a real number stamped at publication, instead of being counted back from the
-- newest-400 index (`publication/reports.ts` INDEX_LIMIT) — past 400 issues the old count could not
-- see far enough and the masthead silently dropped the number (docs/known-issues.md, "站点已部署"
-- item 5). An issue consumes a number only if it carries at least one citation — the same shape the
-- reader gate reads (`citedItemIds`: daily sections[].items[].itemId, periodic themes[].storyRefs).
-- Blank issues (the 2026-10-01 backfill batch, the empty 10-04..06) never consume one, so the live
-- series stays 2026-10-02 → 第 1 期, 2026-10-03 → 第 2 期.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS issue_no integer;

-- Existing rows: number the citation-bearing issues per kind in key order. Re-runnable and replay-safe:
-- a kind is numbered only while it holds no numbers at all. Once any row in a kind carries a number the
-- file leaves that kind alone — re-running it on a partially numbered kind (an old writer's row landing
-- after the backfill) could only mint duplicates, which the unique index below would reject and abort
-- the whole migration with.
UPDATE reports r SET issue_no = s.n
FROM (
  SELECT id, row_number() OVER (PARTITION BY kind ORDER BY key) AS n
  FROM reports r2
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN kind = 'daily' THEN coalesce(content->'sections', '[]'::jsonb) ELSE coalesce(content->'themes', '[]'::jsonb) END) AS grp,
         jsonb_array_elements(CASE WHEN kind = 'daily' THEN coalesce(grp->'items', '[]'::jsonb) ELSE coalesce(grp->'storyRefs', '[]'::jsonb) END) AS it
  )
  AND NOT EXISTS (SELECT 1 FROM reports r3 WHERE r3.kind = r2.kind AND r3.issue_no IS NOT NULL)
) s
WHERE r.id = s.id AND r.issue_no IS NULL;

-- One number per kind, ever. A compose that would collide fails loudly and runs again (the queue
-- retries); silently printing 第 3 期 twice is the one outcome a newspaper cannot have.
CREATE UNIQUE INDEX IF NOT EXISTS reports_kind_issue_no_idx ON reports (kind, issue_no) WHERE issue_no IS NOT NULL;
