-- 英文任务的记账与扫描索引。
--
-- 0013_translation_attempts.sql 的主键只有 article_id：正文英文也写这张表会与 zh 行撞键，
-- 而且 outcome 词表里没有 written/stale。旧表不改，英文另立一张按 (kind, subject, source_revision)
-- 记账。
--
-- stale 是 CAS 失败时唯一正确的记账：读取时源版本与写回时不一致，什么都没写，等 sweep 重排；
-- 不要并进 failed，否则会被当成真失败、消耗重试上限。
--
-- 索引单独一个文件、放在 wait_for_quiet 门槛后的低流量窗口：普通 CREATE INDEX 在迁移事务内
-- 构建期间锁写（CONCURRENTLY 在 scripts/migrate.ts 的单事务里不可用）。
SET LOCAL lock_timeout='5000ms';
SET LOCAL statement_timeout='600000ms';

CREATE TABLE IF NOT EXISTS english_attempts (
  kind             text CHECK (kind IN ('copy', 'body', 'story', 'fact', 'report', 'quote')),
  subject          text,
  source_revision  text,
  attempts         integer NOT NULL DEFAULT 0,
  outcome          text CHECK (outcome IN ('written', 'translated', 'skipped', 'failed', 'stale')),
  reason           text,
  updated_at       timestamptz DEFAULT now(),
  PRIMARY KEY (kind, subject, source_revision)
);

-- 英文搜索：与 0001_core.sql 的 publications_search_trgm_idx 同构，只扫英文列。
CREATE INDEX IF NOT EXISTS publications_search_en_trgm_idx
  ON publications USING gin (search_text_en gin_trgm_ops);

-- 待译条目：条件就是采用条件（两值不相等，含 english_source_revision IS NULL 的老行）。
-- 按 timeline_at 倒序，sweep 与读者列表同序，从最新内容开始补英文。
CREATE INDEX IF NOT EXISTS publications_english_pending_idx
  ON publications (timeline_at DESC, article_id)
  WHERE visibility = 'public' AND english_source_revision IS DISTINCT FROM revision;

-- 待译事件：已并入其他事件的不排英文。按 id 键集分页，sweep 可以从上次位置接着扫。
CREATE INDEX IF NOT EXISTS stories_english_pending_idx
  ON stories (id)
  WHERE merged_into IS NULL AND english_source_version IS DISTINCT FROM version;

-- 待译进展：只补事件下的 fact，孤立 fact 不生成英文；条件即「还没有英文标题」。
CREATE INDEX IF NOT EXISTS facts_english_pending_idx
  ON facts (story_id)
  WHERE story_id IS NOT NULL AND title_en IS NULL;

-- sweep 的重排查询：按 kind + outcome 找 failed/stale，再按 updated_at 做退避。
CREATE INDEX IF NOT EXISTS english_attempts_sweep_idx
  ON english_attempts (kind, outcome, updated_at);