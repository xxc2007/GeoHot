-- 2026-10-04：补 0040 / 0041 漏掉的一处派生拷贝——selected_ledger.payload。
--
-- 为什么必须补：v1 的同步接口（/api/v1/selected/snapshot 与 selected/changes）不是从 publications 现算的，
-- 它读的是 selected_ledger 里**写入时物化下来的那份 payload 快照**（packages/backend/src/publication/publish.ts
-- 的 v1Payload + appendLedger）。0040 只改了 publications / analyses / editorial_overrides / sources，
-- 0041 同样只改了那四处，于是库里出现这个形状：publications.category = 'physical'，
-- 而 selected_ledger.payload->>'category' 还是 'fieldwork'。
-- 2026-10-04 线上实测：57 条在集合里的条目中有 8 条的载荷带已删 key（comment 6 / fieldwork 2），
-- 接口原样吐给客户端（`GET /api/v1/selected/snapshot` 的响应体里能 grep 到 "category":"fieldwork"）。
-- 站内页面读的是 publications，所以网页一直是对的——坏的只有机器可读出口，这也正是它藏了两天的原因。
--
-- 第二层后果：selected_state.payload_hash 记的是旧载荷的哈希。它不参与读取，但决定"下次要不要追加新条目"
-- （publish.ts 的 `state.payload_hash !== payloadHash` 分支）。历史载荷被改写之后这份哈希就陈旧了，
-- 所以一并置空——NULL 的语义在代码里就是"不知道，下次重写"，比留一个对不上的哈希诚实。
--
-- 第三层后果：selectedChanges 只回 seq 大于游标的行。改的是历史行的内容、不动 seq，
-- 已经同步过的客户端**永远学不到这次修正**。按 v1.ts 里对 epoch 的定义（"ledger 被重建时换 epoch，
-- 作废旧水位"），这就该换 epoch：客户端拿到 409 snapshot_required，重新拉一次快照。
--
-- 刻意不动的层：selectbench_results（评测存档，category 记的是当时模型的答案）·
-- analyses.reason_zh 与历史成刊里的散文（那是写下的编辑判断与历史快照，不是词表字段；
-- 0041 已经改过 analyses.category，但正文里的"按野外与考察收录"这类话属于记录，不改写）·
-- tooling/corpus 里 corpus-fieldwork-* 之类的表名（语料文件名）。
--
-- 规则留给下一个改词表的人：**动 CATEGORIES 的 key，五处一起看** ——
-- publications.category、analyses.category、editorial_overrides.fields->>'category'、
-- sources.default_category，以及 selected_ledger.payload->>'category'。少最后一处，
-- 网页是对的、公开 API 是错的，而自检脚本只 curl 网页时看不出来。
CREATE TEMP TABLE geohot_v1_categories (key text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO geohot_v1_categories (key) VALUES
  ('physical'), ('human'), ('regional'), ('geopolitics'), ('histgeo'), ('geotech'), ('geoedu');

-- 受影响的 article_id（后面清 payload_hash 要用）。判据只看载荷本身：带一个当前词表里没有的非空 key。
CREATE TEMP TABLE geohot_ledger_fixups (article_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO geohot_ledger_fixups (article_id)
SELECT DISTINCT l.article_id FROM selected_ledger l
WHERE l.payload IS NOT NULL
  AND l.payload ? 'category'
  AND l.payload->>'category' IS NOT NULL
  AND l.payload->>'category' NOT IN (SELECT key FROM geohot_v1_categories);

-- 只改这些行：新值取该条在 publications 里的分类，且必须也是词表里的 key；取不到就落 null。
-- 用 publications 而不是自己猜，是因为 0040/0041 之后那一列才是权威值。
UPDATE selected_ledger l
SET payload = jsonb_set(l.payload, '{category}', coalesce((
      SELECT to_jsonb(p.category) FROM publications p
      WHERE p.article_id = l.article_id
        AND p.category IN (SELECT key FROM geohot_v1_categories)
    ), 'null'::jsonb), true)
WHERE l.article_id IN (SELECT article_id FROM geohot_ledger_fixups);

-- 陈旧哈希置空，让下一次 publish 重新写一份载荷（NULL 不等于任何哈希，走的就是重写分支）。
UPDATE selected_state SET payload_hash = NULL
WHERE article_id IN (SELECT article_id FROM geohot_ledger_fixups);

-- 换 epoch：历史被改写，旧水位必须作废，否则已同步的客户端不会重新拉。
-- 值只要与旧的不同即可，用随机串；settings.value 是 jsonb，形状仍是 {"epoch": "…"}。
UPDATE settings
SET value = jsonb_set(value, '{epoch}', to_jsonb(substr(md5(random()::text || clock_timestamp()::text), 1, 12)))
WHERE key = 'selected_ledger_epoch';
