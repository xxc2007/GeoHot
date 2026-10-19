-- The whole historical selected set supplies exact reading-group anchors/day counts.
-- Cover its narrow fields, not unbounded titles/bodies. The Chinese predicate is the
-- frozen migration equivalent of contracts/copy.CJK_COPY_PATTERN; custom planning in
-- queryGroupedAnchors lets the parameterized read imply this partial predicate.
CREATE INDEX publications_selected_zh_anchor_idx
  ON publications (visible_after)
  INCLUDE (sort_at, story_id, fact_id, article_id)
  WHERE visibility = 'public' AND selected AND title ~ '[一-鿿]';
