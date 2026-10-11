# 报刊计划与最终刷新门禁

第 02 名检查 agent 于北京时间 2026-10-11 12:48—12:49 只读核验生产，数据库存储 20 条刊期：日报 17、周报 2、月报 1。实际 publication 读取层可读日报 7、周报 1、月报 0；九月月报存在但 readable=false、sections=0。存储行数、命令退出成功均不能替代实际公开刊数。

该次查询覆盖 01-01 至 10-11 全天，截至观测未完成资料 9,642、failed 44。第 01 名 agent 的 9,395 条 new 使用截止 10-11 零点的范围，不能把两次计数差当作积压逆增长。两次均确认所有历史日期仍有待处理资料，切片 done 655、pending 274、running 0。

本地 backfill-papers 计划复用 publication.loadReport 的真实 readable，逐期输出 waiting、exists、readable、entries。先检查 pending，即使已有刊期也不隐瞒后到的未判材料；settled 已有可读期标记未重排，已有不可读期提示 refresh。apply 成功后重新读取实际公开可读性，空或未到放行时间的刊期不会被写作已出刊。原 --force、正序去重、期号保留及预算逻辑不变。

第 02 名 agent 在隔离测试库实际运行四项状态回归通过：零候选 pending、既有空期 pending/settled、compose 失败 exit 1、已有可读期 pending/settled。相关 CLI 回归此前五项通过；scripts 类型检查通过。并发新增 dots 测试的导入问题曾阻断 tests 类型检查，随后由其文件 owner 纠正；统一工作区和完整测试由根协调器另行执行，不把局部通过宣称全套通过。

第 18 名 agent 独立补充了真实 apply 回查用例：真实候选数为 1，经前一日报的 fact 去重后实际 entries=0，模型阀关闭下 compose 成功；计划明确 exists=true、readable=false、空刊备注，库中 sections 为空且 repeatsSuppressed=1。该文件在独立测试库五项全部通过、无跳过，唯一测试库随后删除。没有用模拟 loadReport 返回值替代成刊与读取行为。

archive-cycle 会持续尝试 missing 且后来 settled 的期次，等待不等于永远停止；但默认不会重排既有期。最终刷新不能只设置 FINAL_REFRESH=1：周期顺序为期刊采集、papers、新闻采集，最后仍可能给旧期新增材料。应核实冻结采集截点、完成目标材料判定与异常处置，再在同一 cycle.lock 下单独全区间 --refresh，先日报旧到新，再完整周、完整月，最后逐期检查读取层内容与引用。

计划 exit 0 表示执行没有抛失败，pending 或不可读计划仍可能存在；最终门禁必须读取结构化 waiting/readable 及来源覆盖、failed/unknown 原因，不能用 exit 0 一项判全任务完成。unknown/failed 分域审查，不批量算作待判，也不批量算作合格成稿。未关闭的当前周/月保留正常出刊边界，不提前 force。

本轮代码、报告和验证仅在本地；没有执行生产 apply、上传、部署、push、配置同步、备份或迁移演练。全部目标内容、刊物、移动端和多个最终检查完成之后，根任务才统一发布和收尾。
