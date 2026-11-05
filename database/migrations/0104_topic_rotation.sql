-- 主题轮换：让「长期没有新条目」的主题退到归档位，把新出现的聚簇记成候选。
-- 目的：主题栏不该长期挂着一年没动静的条目，也不该只认识 2026-10 那一批标签。
ALTER TABLE topics ADD COLUMN IF NOT EXISTS dormant_at timestamptz;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS rotation_note text;

COMMENT ON COLUMN topics.dormant_at IS '归档时间：近 30 天零新条目时置位，出现新条目后清空；归档主题不再出现在主题列表与导航里，页面仍可访问。';

CREATE TABLE IF NOT EXISTS topic_proposals (
  tag text PRIMARY KEY,
  articles int NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE topic_proposals IS '近 30 天出现、但还没有任何主题认领的高频标签；供人工决定是否升成正式主题。';