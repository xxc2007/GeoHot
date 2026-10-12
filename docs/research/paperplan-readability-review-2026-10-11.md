# 2026-10-11 报刊计划真实状态复核

本轮只读访问生产并修改本地报刊计划与其隔离测试；没有部署、上传、push、生产 apply、修改服务器配置或执行备份迁移。

生产观测 UTC 2026-10-11T04:48:17Z（北京时间 12:48）：数据库有日报 17、周报 2、月报 1，共 20 条记录；其中有引注的日报 7、周报 1、月报 0。12:49:59 实际 publication 读取层进一步确认公开可读数量为 7/1/0，9 月月报 readable=false、sections=0。记录存在不代表真实出刊。

01-01 至 10-11 全天范围内，截至 12:48 观测有未完成 9,642、failed 44。a01 的 9,395 个 new 使用截至 10-11 零点的窗口，截止范围与状态口径都不同，不据此宣称队列增长。学术档案切片 done 655、pending 274，不代表全来源检索完成。

本地 backfill-papers 复用 publication.loadReport 的实际 readable，每期结构化输出 waiting/exists/readable/entries。已有记录仍先检查 pending；不可读记录不再标为已出刊；实际 apply 后再次检查真实可读性。保留原窗口、正序、期号、回执、预算及双评分。

本 agent 执行的状态回归四项通过：零候选 pending；既有空刊 pending 与 settled；禁模型造成 compose 失败且 exit 1；既有可读刊期 pending 与 settled。使用的是本轮开始前即已存在的共享 geohot_test，只清理自有夹具和临时摘要，没有创建或删除数据库。后续合并测试由根 agent 使用独立库执行。

archive-cycle 的次序为学术采集、papers、新闻采集；即使 FINAL_REFRESH=1，刷新之后仍可能新增新闻。因此最终认证必须先冻结本轮采集、确认素材判定与投影及来源边界，随后同锁独立执行全区间正序 refresh，再做只读刊物验证。FINAL_REFRESH 的单次循环、reports 行数或补刊 exit 0 均不能代替最终门禁。
