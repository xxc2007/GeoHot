-- stored_files 是孤儿表：全库唯一的代码引用是 retention 的 DELETE+unlink（无任何写入者），
-- 且 unlink 直接拼 key、无包含性校验（遗留或被污染的 key 含 "../" 即穿越删除）。删表与该清理块。
-- 表里若有历史行也一并清空（无写入者即无业务数据可保）。
DROP TABLE IF EXISTS stored_files;
