# 29ca24d 部署后短窗口吞吐观察

只读观察，未改频率、并发、排序、配置、预算或回执，未外发测试模型。使用既有 remote.ps1 与 READ ONLY / 20秒statement_timeout事务，不读取环境全文、原始回答或模型凭据。

生产 worker ActiveEnterTimestamp 是 **2026-10-11 07:47:54 CST**。下文新增尝试只统计 started_at 不早于此时，作业结果只统计 started_on 不早于此时。它是服务运行时观察边界；发布版本29ca24d由根任务的部署验收提供，不能用启动时刻替代版本验收。

## 每轮实际观测

| 观察时刻 | 新worker sweep | archive 作业结果累计 | 异常文章状态 |
|---|---|---|---|
| 07:48:39 | 无 | 无新结果/无新attempt | 文章new，processing_attempts1；写作receipt84995 attempts20，最后更新时间07:45:56，属于旧worker |
| 07:51:25 | 07:50:41—46，500条，4.97秒 | waiting97、retrying1、failed1、unknown1；无pass/block | processing_attempts2，错误已变Paid writing produced no usable Chinese；receipt attempts21，最后07:51:04；下一retry08:01:04 |
| 07:56:21 | 又一轮07:55:41—45，500条，3.91秒 | waiting192次/100篇、retrying1、failed1、unknown1；无pass/block | 仍processing_attempts2/receipt21，无新增写作购买，保持原08:01:04退避 |
| 08:01:13 | 第三轮08:00:41—52，500条，11.14秒 | waiting314次/119篇、retrying1、failed1、unknown2；无pass/block | 仍processing_attempts2/receipt21；retry08:01:04刚到期，08:00扫描尚未选择，第三次终态仍未观测 |

异常文章为 `teprj3rylduwi28c87bh1bvlo`。旧worker07:45已把历史receipt尝试数累积到20，不能把部署后21解释成21次新尝试。新worker第一次调用将不合格写作计入输出失败，并保持10分钟退避，符合补丁预期；短窗口没有证明第三次failed终态。

07:51:25 全部97次archive waiting的实际输出退避约1分钟；07:56:21累计192次archive waiting和600次stale-on-discovery waiting均为1分钟。**等待不是分析完成**；这里证明新worker产生了短预算等待，不逐次宣称这些工作原先一定会等待一小时。07:53仍有317篇旧Budget错误的retry_at超过未来10分钟，补丁没有改写这些旧行，符合控制范围。

07:56:21 新worker累计：Agnes25 received/2 pending，LLM25 received/2 pending，OpenCode8 received/1 pending，OR18 failed（首轮07:50）。当前archive active5；stale active4/created173。completed结果live pass1、waiting5；stale pass5、retrying14、unknown2、waiting588。pending与unknown都不能计入真实分析成功；业务unknown结果也不等同于receipt未知，需分别统计。

## 一分钟扫描的最小节奏评估

07:49左右用**部署当前完整eligible/reserved/ordinary/remainder CTE**执行只读 EXPLAIN ANALYZE：扫描articles24535行，eligible9936，archive reserve100、ordinary400、remainder0；执行32.684毫秒，shared hit4322/read127，规划0.213毫秒，排序无磁盘溢出。优化器选择顺序扫描；已有部分索引articles_processing_idx，当前单次选择耗时不支持为此新增索引。这个结果只测SELECT，不能替代500次queueProcessing完整开销。

两轮真实sweep500分别4.97和3.91秒；此前部署前5轮约6—18秒。当前 cron.content.sweep 采用singleton队列、默认单个worker消费者，不扩大扫描并发。一分钟节奏相对五分钟最多增加6倍扫描、入队及结果日志，粗略上限每小时30000条500配额作业，不能说数据库成本只有33毫秒。

07:53预算快照：Agnes minute0/hour159/540/day2311/12000；LLM minute0/hour136/420/day3971/6000；OpenCode minute0/hour59/300/day857/3000；dots day6000/6000；OR小时计费0但实际供应商拒绝，不能把其本地余额当可用容量。6848 due archive全部queued_at=NULL。json用途当前已健康服务分钟上限为Agnes9+LLM8，小时闸合计960；写作OpenCode另有300小时额度，但不是所有结构/评分可用的替代服务。提高扫描频率能减少空闲分钟，并不增加这些上限。

建议最小节奏改动仅把content.sweep cron改为每分钟，保留每轮500/档案100保留额/原优先级/原预算/原回执互斥/单扫描消费者，不加分析并发或更改模型权重。先观察一个完整小时：sweep耗时p95是否小于60秒、活跃扫描是否累积、数据库CPU和锁等待、作业日志增长、模型小时真实利用、完整pass与可公开成稿、live延迟；若数据库或live指标恶化，回滚到原五分钟。当前证据支持试验方向，不证明每分钟500是最终最佳参数。

审计口径补充：前一份报告的reserved100缓存查询使用15分钟queued_stale，而当前代码为30分钟；本轮同一时刻重放两种条件集合差为0，但不能把它当成此前历史时刻的完全证明。此次EXPLAIN和后续重放全部使用当前30分钟条件。

## 写作拒收与服务健康账本的差异

07:58:14 新worker OpenCode summarize共9次attempt received，关联当前逻辑回执：6个answer refused，3个received/completed。9个都是对应receipt的当前attempt，6个拒收都有usage；因此按attempt received的健康口径是9/9，实际仅3/9通过当前回执可用门。这里是回执可用情况，不等同于3篇已公开；未读取原回答，也没有猜测具体拒收理由。

当前rejectReceivedResponse只改逻辑receipt为failed，没有改变attempt received。最小修复可以只更新明确拒收的**当前received attempt**为failed并保存usage/cost/latency，避免改写更早历史、pending或unknown。service健康应反映答案可用性，计费预算仍保守保护已收到但不能使用的回答。

必须额外处理usage缺失：全库本次只读查到1个“当前received attempt + failed输出拒收receipt + usage NULL”。现unbilledAttempt等于`status='failed' AND usage IS NULL`，若仅改status，该已回答但无usage记录会被误当无计费的网络/429拒绝，释放不应释放的额度。应采用明确输出拒收标记并将其排除于unbilled条件，或者其它保持保守计费的独立字段；不能随意伪造usage，也不能把unknown改为failed。回归至少覆盖有usage和无usage两类已回答拒收、只改当前attempt、保留旧attempt、分钟统计不变、小时/日仍计费、unknown不重送，以及健康在6个终态里少于半数真正可用时正确隔离服务。根任务决定实现，本 agent 未改核心。

**最终采用的实施范围（替代上面的初步改attempt建议）：仅修sickServices只读健康查询的成功分子。** 使用receipt_attempts LEFT JOIN receipts，只在attempt为received、且对应同一当前attempt的receipt已经failed并有明确answer refused:/unusable output:错误时，不把它算作可用成功。分母、origin/live、十分钟窗、至少六个终态、半数阈值、60秒缓存和单模型fallback不变；receipt_attempts的status/usage/cost/error和全部计费预算完全不变。旧attempt不可追溯的不猜测；LEFT JOIN/null条件用coalesce保留原received计数。初步修改attempt/费用口径方案不实施。根任务授权本agent另写models.ts最小补丁及独立tests/model-output-health.test.ts，先本机回归，再由根任务审阅、单独提交部署。

三周期观察截至08:01:13结束，已通知根任务可以继续下一版本部署；这仅是协调结束读数窗口，不替代根任务的部署检查。此时全站新worker尝试Agnes30 received/6 pending、LLM29 received/7 pending、OpenCode10 received、OR18 failed；pending来自08:00当轮，不判失败。新业务unknown档案2/普通首导1/旧闻2，不能当pass/block或receipt未知。三周期没有档案pass/block，不能由一分钟等待已生效推导筛选吞吐已恢复。

本机实施验证：models.ts只有上述健康查询变化；新tests/model-output-health.test.ts 5/5通过，backend/tests类型检查通过。独立geohot_a13_output_health_test执行53迁移；finally清理后fixture receipts/attempts/budgets均0，数据库已DROP。真实paidRequest预算回归确认有usage和usage NULL的received即使输出已被拒收，健康读取前后仍被小时预算拒绝，callback未外发，整个receipt/attempt/budget行未变化；unknown仍阻止重送。未改核心收据逻辑、分析逻辑、并发或cron，未提交或部署，由根任务独立审阅。

## 限制

这是部署后短窗口，正文采集持续新增、其它生产任务共享服务、旧退避仍在生效、OR拒绝尚未恢复。无可靠完成日期；不把waiting、unknown或本机回归通过写成生产全部档案筛完。实际采集、筛选终态、报告出刊、站点公开与备份迁移仍由根任务独立验收。

## 根代理独立验收

根在新隔离库运行完整后台回归：448/448 pass、0 fail、0 skip，耗时126245毫秒；全部工作区typecheck通过。第18名检查agent独立静态审阅健康分子及usage NULL保守计费路径，无待修复问题。原始日志output-health-root-whole.log及output-health-root-typecheck.log保留在本轮私有证据目录。此段仅证明本地验证，线上部署和一分钟扫描另记。
