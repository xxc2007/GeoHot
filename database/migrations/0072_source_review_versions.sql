-- Review identity is independent of timestamp precision, health noise and row recreation.
-- Deliberately not OWNED BY sources: TRUNCATE RESTART IDENTITY must not reuse review tokens.
CREATE SEQUENCE source_review_version_seq AS bigint NO CYCLE;
ALTER TABLE sources ADD COLUMN review_version bigint NOT NULL DEFAULT nextval('source_review_version_seq');
ALTER TABLE sources ADD CONSTRAINT source_review_version_positive CHECK (review_version > 0);

CREATE FUNCTION source_review_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Ignore caller-supplied versions; a recreated id is a different review, never an ABA token.
    NEW.review_version := nextval('source_review_version_seq');
  ELSIF ROW(NEW.id,NEW.name,NEW.kind,NEW.config,NEW.tags,NEW.first_party,NEW.owner_entity_id,
            NEW.tier,NEW.participation_mode,NEW.signal_group_id,NEW.interval_minutes,
            NEW.site_fulltext,NEW.syndicate_fulltext,NEW.enabled,NEW.default_category,NEW.imported_from)
        IS DISTINCT FROM
        ROW(OLD.id,OLD.name,OLD.kind,OLD.config,OLD.tags,OLD.first_party,OLD.owner_entity_id,
            OLD.tier,OLD.participation_mode,OLD.signal_group_id,OLD.interval_minutes,
            OLD.site_fulltext,OLD.syndicate_fulltext,OLD.enabled,OLD.default_category,OLD.imported_from) THEN
    NEW.review_version := nextval('source_review_version_seq');
  ELSE
    -- Cursors, health, scheduler timestamps and a forged version alone do not change the review.
    NEW.review_version := OLD.review_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_review_version_write BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION source_review_version();
