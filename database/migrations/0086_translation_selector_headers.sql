-- Identify missing translations from narrow headers before loading any article body.
CREATE INDEX IF NOT EXISTS articles_translation_header_idx ON articles(id) INCLUDE(revision)
  WHERE coalesce(language,'') <> 'zh';
CREATE INDEX IF NOT EXISTS publications_translation_header_idx ON publications(article_id) INCLUDE(discovered_at)
  WHERE selected AND visibility='public' AND body_mode='full';
CREATE INDEX IF NOT EXISTS translations_zh_header_idx ON translations(article_id) INCLUDE(revision,origin,complete)
  WHERE lang='zh';
