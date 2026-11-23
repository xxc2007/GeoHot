-- 英文内容层：只加列与只增表，不改 publications/stories/reports 的既有列、约束与索引。
-- 语言是读取层投影，不是成员列：不建 publications.lang、stories.lang、reports.lang。
--
-- 新鲜度语义（读取层唯一的采用条件）：
--   publications.english_source_revision = publications.revision
--   stories.english_source_version      = stories.version
--   reports.revision_en                 = reports.revision
--   english_at 只审计，不参与判断；facts 没有可用的版本列，写回时按 (id, title) 快照 CAS。
-- 英文写入绝不把 revision/version 加一：publication/readiness.ts:60 用
-- article_workflow_readiness.revision = p.revision 关联；revision 一动，条目会从所有中文列表
-- 消失，直到 content.readiness 重算。
--
-- 红线：0128/0129 全部只增、可空、IF NOT EXISTS；旧代码不认识新列但会忽略，回滚代码不回滚列。
-- search_text_en 的 NOT NULL DEFAULT '' 是常量默认（PG 11+ 只改目录、不重写旧行），旧行内容不变。
-- 结构变更与索引分开：本文件只动列/表（短锁），0129 建索引（长锁）放在低流量窗口执行。
SET LOCAL lock_timeout='5000ms';
SET LOCAL statement_timeout='600000ms';

-- ---------------------------------------------------------------------------
-- 条目（publications）
-- ---------------------------------------------------------------------------

ALTER TABLE publications ADD COLUMN IF NOT EXISTS title_en text;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS summary_en text;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS reason_en text;
-- 英文搜索列单列一份，不与 search_text 混写：中英文召回互不污染。
ALTER TABLE publications ADD COLUMN IF NOT EXISTS search_text_en text NOT NULL DEFAULT '';
ALTER TABLE publications ADD COLUMN IF NOT EXISTS english_source_revision integer;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS english_at timestamptz;

-- ---------------------------------------------------------------------------
-- 读者文本：来源 / 主题 / 事实
-- ---------------------------------------------------------------------------

ALTER TABLE sources ADD COLUMN IF NOT EXISTS name_en text;

ALTER TABLE topics ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS definition_en text;

-- 事件页「进展」标题来自 facts（content 里的 storyRefs 只是引用）；没有这一列，
-- 英文事件页仍会夹中文进展标题。
ALTER TABLE facts ADD COLUMN IF NOT EXISTS title_en text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS english_at timestamptz;

-- ---------------------------------------------------------------------------
-- 事件（stories）与事件英文版本
-- ---------------------------------------------------------------------------

ALTER TABLE stories ADD COLUMN IF NOT EXISTS title_en text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS summary_en text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS digest_en text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS latest_en text;
-- english_version 是当前采用的英文稿版本；english_source_version 是生成时对应的 stories.version，
-- 只服务事件标题/综述，facts 不用它。
ALTER TABLE stories ADD COLUMN IF NOT EXISTS english_version integer;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS english_source_version integer;

-- 与 0002_events_reports.sql 的 story_digests 平行：一个英文版本一行，供英文事件页回溯。
-- ON DELETE CASCADE 必须写：清理 story 时没有它，外键会直接让删除报错。
CREATE TABLE IF NOT EXISTS story_digests_en (
  story_id        bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  version         integer NOT NULL,
  source_version  integer,
  digest          text NOT NULL,
  latest          text,
  receipt_id      bigint,
  inputs_hash     text,
  machine_rule    text,
  created_at      timestamptz DEFAULT now(),
  PRIMARY KEY (story_id, version)
);

-- ---------------------------------------------------------------------------
-- 报刊（reports）
-- ---------------------------------------------------------------------------

-- content_en 存两类东西：
--   ① 散文覆盖层：daily 的 lead/sections 标签与 summary；weekly/monthly 的 headline/overview/themes 的
--      heading+summary；
--   ② 写时引用快照 citations: [{itemId,title,summary,sourceName,role}]。
-- 成员（items/storyRefs/itemId）仍从 content 读；引用文字只读 content_en.citations，
-- 不在读时按 publications.title_en 投影——旧刊不能因为条目后来改名而被改写。
ALTER TABLE reports ADD COLUMN IF NOT EXISTS content_en jsonb;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS model_en text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS revision_en integer;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS english_at timestamptz;

-- ---------------------------------------------------------------------------
-- 引用帖英文译文（对应 0038_quote_translations.sql 的 zh 表，供 translate_post_en 写入）
-- ---------------------------------------------------------------------------

-- text_hash 是翻译时引用的原文哈希：同一条推文读到更完整的 note tweet 时要重新翻译。
CREATE TABLE IF NOT EXISTS quote_translations_en (
  tweet_id    text PRIMARY KEY,
  text_hash   text NOT NULL,
  text_en     text NOT NULL,
  origin      text NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'reused')),
  created_at  timestamptz NOT NULL DEFAULT now()
);