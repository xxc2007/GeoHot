-- Source URL determines publisher-specific extraction evidence; invalidate in the same transaction.
DROP TRIGGER invalidate_workflow_article ON articles;
CREATE TRIGGER invalidate_workflow_article AFTER UPDATE OF revision,body_html,body_text,language,body_status,media,x_post,source_id,url ON articles
 FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();
-- Recovery reads only flagged headers, never scans the stored full bodies to pick work.
CREATE INDEX article_workflow_body_repair_idx ON article_workflow_readiness(checked_at,article_id)
 WHERE quality_error LIKE 'source:%';
