-- 2026-10-31 站长要求：后台反馈管理展示每条反馈的来源 IP 与所在地（此前只存不可还原的来源标识）。
-- 历史行没有原文 IP（ip/location 为 NULL，后台显示"未记录"）；新行在提交时写入 ip，
-- location 由提交后的异步查询补齐（内网/保留地址直接标注，不外查）。
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS location text;
