-- 心跳键改成 heartbeat.<role>@<host>。
--
-- 原来只按 role 存：武汉和杭州的 role 都是 content-executor，两台机器每分钟各写一次同一行，
-- 后写的那台把先写的覆盖掉，后台「协同节点」表里永远只看得见一台。
-- 旧键留着会以「角色没有主机名」的形式继续出现在面板上，且时间戳停更新时显示成离线节点，
-- 所以这里直接清掉；下一次心跳会用新键重写。
DELETE FROM settings WHERE key LIKE 'heartbeat.%' AND key NOT LIKE '%@%';
