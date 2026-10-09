-- 档案回填的账本：一个（信源，月份）一片，跑完记 done，中途死掉下次接着跑。
--
-- 为什么要有这张表而不是"跑一次就完"：2026-01-01 至今按期刊×月份切是几百个片，每片要翻页到底，
-- 整轮要几十小时；Crossref 会超时、模型熔断会让下游排队、机器会重启。没有可续跑的账，任何一次中断
-- 都只能从头再来，而"从头再来"在 2.3 万条材料上等于把已入库的东西再判一遍。
-- 一行一个片：cursor 存 Crossref 的深翻页游标（offset 超过 10000 就取不到下一页），seen/items 用来
-- 区分"这条源这个月真的没有"和"我们只取到一半"。
CREATE TABLE IF NOT EXISTS archive_ingest (
  source_id  text        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  month      text        NOT NULL,
  cursor     text,
  seen       integer     NOT NULL DEFAULT 0,
  items      integer     NOT NULL DEFAULT 0,
  status     text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, month)
);

COMMENT ON TABLE archive_ingest IS '档案回填（Crossref 按 ISSN + 月份切片）的续跑账本';
