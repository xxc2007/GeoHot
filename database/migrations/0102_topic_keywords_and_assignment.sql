-- 主题归类从"标签恰好撞上"改成"显式分配"。
--
-- 现场（2026-11-05 生产）：近 7 天 1,490 条公开条目里 **844 条（57%）一个主题都没挂上**——
-- 因为这些条目的标签是「非地理/通用」「评论/解读」「机构/动态」或者干脆为空，
-- 而 43 个主题只认识 52 个具体标签（高原、地震、中国科学院…）。读者在主题页看到的是
-- "这一块最近没动静"，真相是"我们没有把它们归进来"。
--
-- 做法：一条主题一行的分配表 + 关键词列。分配由代码算（标签撞上 / 分类撞上 / 关键词出现），
-- 落库之后主题页、主题计数、新鲜度审计都读同一份结果，不再各写一套 SQL 判据。
ALTER TABLE topics ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS publication_topics (
  article_id text NOT NULL REFERENCES publications(article_id) ON DELETE CASCADE,
  slug       text NOT NULL,
  source     text NOT NULL,           -- tags | category | keyword | manual
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, slug)
);

CREATE INDEX IF NOT EXISTS publication_topics_slug_idx ON publication_topics (slug, article_id);