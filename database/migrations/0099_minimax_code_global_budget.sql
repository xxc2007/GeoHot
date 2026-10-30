-- 2026-10-30 MiniMax 六账号接入：把 minimax-code-global 的预算从 0098 的起步口径（2/30/200）
-- 抬到与 0089 minimax-code（单账号订阅限免）同款的 60/3600/12000。
--
-- 依据：站长当天在本机 magpie 登录了 6 个 MiniMax Code (Global) 账号（MiniMax031852、
-- MiniMax817680、理想与现实、Xin Chen Xiong ×3），凭据同步到服务器 magpie（3426）后该门
-- 1-token 探针 200。网关在 6 个账号间轮询（providers.json 的 routing group），GEOHOT 侧
-- 仍是一扇门、一个 service；6 个 Free 账号的聚合额度不低于单个订阅限免账号，所以预算
-- 沿用 0089 那一档而不是另造一档。跑出真实吞吐后按 sickServices() 的读数再校正。
--
-- 池成员（minimax-code-global-m31-flash）由 .env 的 12 条池行尾部追加写入，不在此迁移里；
-- 两个改动必须同轮生效：没有预算行 checkBudget() 落 BudgetExceededError("missing")，
-- 没有池成员预算行只是闲置。
UPDATE budgets
SET per_minute = 60, per_hour = 3600, per_day = 12000,
    note = '模型调用熔断（服务器 magpie:3426 MiniMax Code Global，M3.1-Flash；6 账号网关轮询，2026-10-30 六账号接入抬额）'
WHERE service = 'minimax-code-global';
