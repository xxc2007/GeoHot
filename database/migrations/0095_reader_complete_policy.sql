-- Old readiness facts predate the complete-reader rule and must be revalidated in bounded background work.
ALTER TABLE article_workflow_readiness ADD COLUMN policy_version integer NOT NULL DEFAULT 1;
ALTER TABLE article_workflow_readiness ADD COLUMN quality_error text;
