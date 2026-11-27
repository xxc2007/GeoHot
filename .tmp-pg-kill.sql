\set ON_ERROR_STOP 1
\echo '--- 将被终止的后端（只匹配两种形状：超过 120s 的 unknown 回执扫描、超过 120s 的空闲事务）---'
SELECT pid, round(extract(epoch FROM now()-query_start)) AS secs, state,
       left(regexp_replace(coalesce(query,''),'\s+',' ','g'), 70) AS q
  FROM pg_stat_activity
 WHERE backend_type='client backend'
   AND ( (state='active' AND now()-query_start > interval '120 seconds' AND query ILIKE '%receipts r%' AND query ILIKE '%unknown%')
      OR (state='idle in transaction' AND now()-state_change > interval '120 seconds') );
SELECT count(pg_terminate_backend(pid)) AS killed
  FROM pg_stat_activity
 WHERE backend_type='client backend'
   AND ( (state='active' AND now()-query_start > interval '120 seconds' AND query ILIKE '%receipts r%' AND query ILIKE '%unknown%')
      OR (state='idle in transaction' AND now()-state_change > interval '120 seconds') );
