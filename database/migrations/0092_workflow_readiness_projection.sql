-- A transactionally invalidated fact, never a time-based cache. Reader aggregates read headers only.
CREATE TABLE article_workflow_readiness (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  analysis_id bigint,
  ready boolean NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION invalidate_article_workflow_readiness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; prior text;
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='article_media_readiness' AND TG_OP='UPDATE' THEN
    IF (OLD.article_id,OLD.revision,OLD.fingerprint,OLD.ready) IS NOT DISTINCT FROM
       (NEW.article_id,NEW.revision,NEW.fingerprint,NEW.ready) THEN RETURN NULL; END IF;
  END IF;
  IF TG_TABLE_NAME='articles' THEN
    target := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    IF TG_TABLE_NAME='translations' THEN
      IF TG_OP='INSERT' AND NEW.lang<>'zh' THEN RETURN NULL; END IF;
      IF TG_OP='DELETE' AND OLD.lang<>'zh' THEN RETURN NULL; END IF;
      IF TG_OP='UPDATE' AND OLD.lang<>'zh' AND NEW.lang<>'zh' THEN RETURN NULL; END IF;
    END IF;
    target := CASE WHEN TG_OP='DELETE' THEN OLD.article_id ELSE NEW.article_id END;
    -- Serialize against recomputation even when a translation/analysis is changed outside the app.
    PERFORM id FROM articles WHERE id=target FOR UPDATE;
    IF TG_OP='UPDATE' AND OLD.article_id IS DISTINCT FROM NEW.article_id THEN
      prior := OLD.article_id;
      PERFORM id FROM articles WHERE id=prior FOR UPDATE;
      DELETE FROM article_workflow_readiness WHERE article_id=prior;
    END IF;
  END IF;
  DELETE FROM article_workflow_readiness WHERE article_id=target;
  RETURN NULL;
END $$;

CREATE TRIGGER invalidate_workflow_article AFTER UPDATE OF revision,body_html,body_text,language,body_status,media,x_post,source_id ON articles
  FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();
CREATE TRIGGER invalidate_workflow_translation AFTER INSERT OR DELETE OR UPDATE OF article_id,lang,revision,complete,body_html,body_text ON translations
  FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();
CREATE TRIGGER invalidate_workflow_analysis AFTER INSERT OR DELETE OR UPDATE OF article_id,input_revision,relevance ON analyses
  FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();
CREATE TRIGGER invalidate_workflow_publication AFTER INSERT OR DELETE OR UPDATE OF article_id,revision,analysis_id,title,summary,visibility,source_id,body_mode,channel ON publications
  FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();
CREATE TRIGGER invalidate_workflow_media AFTER INSERT OR DELETE OR UPDATE ON article_media_readiness
  FOR EACH ROW EXECUTE FUNCTION invalidate_article_workflow_readiness();

CREATE FUNCTION invalidate_source_workflow_readiness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.site_fulltext IS DISTINCT FROM NEW.site_fulltext
     OR OLD.participation_mode IS DISTINCT FROM NEW.participation_mode THEN
    DELETE FROM article_workflow_readiness w USING articles a WHERE w.article_id=a.id AND a.source_id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER invalidate_workflow_source AFTER UPDATE OF site_fulltext,participation_mode ON sources
  FOR EACH ROW EXECUTE FUNCTION invalidate_source_workflow_readiness();
