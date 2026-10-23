-- A real NHC prose bulletin was previously classified as code because it uses <pre>.
-- Retain attempt counts and all paid receipts; only reopen that exact non-dispatch skip.
UPDATE translation_attempts t
SET outcome = 'failed', reason = 'NHC preformatted prose is now supported; prior no-text skip reopened', updated_at = now()
FROM articles a JOIN publications p ON p.article_id = a.id
WHERE t.article_id = a.id AND t.revision = a.revision
  AND t.outcome = 'skipped' AND t.reason = 'no translatable text' AND t.attempts < 3
  AND a.url ~ '^https://(www\.)?nhc\.noaa\.gov/'
  AND a.body_html ~* '<pre[^>]*>.*NWS National Hurricane Center'
  AND p.selected AND p.visibility = 'public' AND p.body_mode = 'full';
