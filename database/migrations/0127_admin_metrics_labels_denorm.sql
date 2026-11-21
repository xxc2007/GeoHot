-- Denormalize receipt_model_labels' service/purpose onto admin_model_attempt_metrics (read model only).
-- 用量读侧（usage.ts）此前对每条派生行 LEFT JOIN 整张标签表：日期读整表 Seq Scan 38.9 万行实测 1.9 秒、
-- 总览全量聚合 10.1 秒。反规范化后读侧只碰这张窄派生表。红线：只动派生读模型，不回写回执、不改账单/价卡。
--
-- ② receipt_id 索引是 ③④ 的前提：③ 的主键查找、④ 的传播 UPDATE、读侧按 receipt_id 的过滤都靠它。
--    该表此前唯一的索引是 0085 的 started_at 部分索引（WHERE origin='live'），对按 receipt_id 的
--    定位无用——没有 ②，④ 会对 47.4 万行同步 Seq Scan（盘点实测 38.9 万行约 1.9 秒），每次模型调用
--    的回执写入都会被拖慢秒级并持行锁。
-- 索引用普通 CREATE INDEX（scripts/migrate.ts 每个迁移独立事务，CONCURRENTLY 在事务内不可用）：
-- 构建期间锁写该表（慢盘上分钟级，receipt_attempts 的指标触发器写入会被阻塞），放在 wait_for_quiet
-- 门槛后的低流量窗口执行；迁移失败时 deploy 脚本安全中止、不重启。
SET LOCAL lock_timeout='5000ms';
SET LOCAL statement_timeout='600000ms';

ALTER TABLE admin_model_attempt_metrics ADD COLUMN IF NOT EXISTS service text;
ALTER TABLE admin_model_attempt_metrics ADD COLUMN IF NOT EXISTS purpose text;
CREATE INDEX IF NOT EXISTS admin_model_metrics_receipt_idx ON admin_model_attempt_metrics(receipt_id);

-- ③ 扩展 0085/0089/0125 的派生触发函数：写入派生行时按 receipt_id 主键从标签表带出 service/purpose
--    （有则填、无则 NULL；缺口由 ④ 在标签落库时补齐）。0081 的标签 upsert 走 receipt_id 主键，无新增全扫面。
CREATE OR REPLACE FUNCTION maintain_admin_model_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  labels record;
BEGIN
  SELECT service,purpose INTO labels FROM receipt_model_labels WHERE receipt_id=NEW.receipt_id;
  INSERT INTO admin_model_attempt_metrics(id,receipt_id,started_at,origin,model,status,latency_ms,tokens_in,tokens_out,cost,cost_basis,currency,tokens_cached,cache_checked,tokens_reasoning,service,purpose)
  VALUES(NEW.id,NEW.receipt_id,NEW.started_at,NEW.origin,NEW.model,NEW.status,NEW.latency_ms,
    admin_metric_token_count(NEW.usage->'prompt_tokens'),admin_metric_token_count(NEW.usage->'completion_tokens'),NEW.cost,NEW.cost_basis,NEW.currency,
    admin_metric_cached_tokens(NEW.usage),true,admin_metric_reasoning_tokens(NEW.usage),labels.service,labels.purpose)
  ON CONFLICT(id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,started_at=EXCLUDED.started_at,origin=EXCLUDED.origin,
    model=EXCLUDED.model,status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,tokens_in=EXCLUDED.tokens_in,
    tokens_out=EXCLUDED.tokens_out,cost=EXCLUDED.cost,cost_basis=EXCLUDED.cost_basis,currency=EXCLUDED.currency,
    tokens_cached=EXCLUDED.tokens_cached,cache_checked=true,tokens_reasoning=EXCLUDED.tokens_reasoning,
    service=EXCLUDED.service,purpose=EXCLUDED.purpose;
  RETURN NEW;
END;
$$;

-- ④ 单一传播触发器：receipt_model_labels 的每一条 INSERT/UPDATE 都把 service/purpose 补到既有派生行上。
--    两条写路径全部收口于此——0081 对 receipts 的 upsert（INSERT 新行 / ON CONFLICT DO UPDATE 都触发行事件）
--    与回填脚本对标签表的直插。0081 的 ON CONFLICT DO UPDATE 即使值未变也计为行更新，带 ② 的索引后
--    是幂等空转（同值 UPDATE），无害。
CREATE OR REPLACE FUNCTION propagate_receipt_model_labels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE admin_model_attempt_metrics SET service=NEW.service,purpose=NEW.purpose WHERE receipt_id=NEW.receipt_id;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER receipt_model_labels_propagate_metrics
AFTER INSERT OR UPDATE ON receipt_model_labels FOR EACH ROW EXECUTE FUNCTION propagate_receipt_model_labels();

-- 历史缺口不在迁移里回填（48.8 万行单 UPDATE 会持锁数分钟 IO）：scripts/backfill-admin-metrics-labels.ts
-- 分批补齐后置 true。就绪口径 = 「有标签行的派生行都已带出 service/purpose」；连标签行都没有的回执
-- 属于标签回填（admin.modelLabelsReady）的业务，由传播触发器在标签落库时顺带补上。
INSERT INTO settings(key,value,updated_by)
SELECT 'admin.modelMetricsLabelsReady',to_jsonb(NOT EXISTS(
  SELECT 1 FROM admin_model_attempt_metrics m
  JOIN receipt_model_labels l ON l.receipt_id=m.receipt_id
  WHERE m.service IS NULL)),'migration:0127'
ON CONFLICT(key) DO NOTHING;
