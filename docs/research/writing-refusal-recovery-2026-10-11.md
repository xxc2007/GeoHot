# 写作明确拒收的有限恢复

根在 12:26:51 北京时间只读生产审计，限定 backfill_reason=archive、2026-01-01 起、当前 revision 最新分析、origin=model、relevance=unknown。找到 67 篇；对应写作回执全部为 failed/answer refused，62 条 space-bunny-free、4 条 dots3-note-prev、1 条 Agnes。其它预筛、双评分和结构回执均 completed，没有 identityGuard。它们是已收到但不可用的写作，不是 outcome-unknown 回执，也不是机构主体守卫拒绝。08:07 检查 agent 曾观察 28 条，同一缺口在后续工作中继续增加；主任务取得新的直接证据，没有把旧计数当成当前状态。

chatJson 的 usable 回调会把明确拒收的回答标为 failed，仍将解析后的数据交给业务调用者。此前结构步骤成功时，业务仅将空中文文案规范化为 unknown、落 analyzed，并生成投影；安全扫描不再重试 analyzed。因此已付费拒收绕过了现有三次输出失败上限，未完成中文写作也不再恢复。仅修复“结构预算等待掩盖坏稿”的路径不足以覆盖此情况。

最小修复只在 writing 内部结果携带同一 noChineseAnswer 的明确拒收理由。runAnalysis 先等待并检查并行结构结果；未知回执、关闭、供应商或传输异常仍保留原恢复优先级。结构成功但写作明确拒收时抛 ModelOutputError，经正常 callback 进入原三次上限，不落新的 unknown 分析或投影。机构身份守卫导致的 unknown、资料过短的 none、中文短帖 verbatim 不冒充明确的供应商写作拒收，评分、日期、预算和所有计费账本不变。

新增真实 pg-boss callback 回归：结构成功、三次坏稿达到 failed、结构仅调用一次并复用、没有分析或出版行。保留结构预算不足时的失败计数、好稿预算等待、不确定付费结构回执不重送的回归。首次全套暴露测试夹具仍把全文件结构调用数断言为零，新增成功结构案例使该旧聚合断言不再成立；改为在“结构预算不足”案例内比较前后计数，继续严格证明该案例没有外发结构调用。没有放宽生产预期或删除测试。

根完整 typecheck 通过；完整后台回归和部署实际证据在完成后另记。初始文档不声称已上线或全部 67 条恢复。生产有界恢复须确认当前 revision 和最新同类拒收后经正常 queueProcessing 入队，不添加 attemptTag、不清回执、不写 selected/score，不重置已耗尽的 failed 计数。已有四条 archive failed 保留终态与诊断，不能批量当成成功。上海来源的 403 另属正文访问边界。

## 根完整验收

新的隔离库完成449/449后台测试，0 fail、0 skip，耗时224970毫秒；全部工作区typecheck通过。结构成功时的三次终态和结构回执复用真实callback回归通过，结构预算等待与unknown回执优先级回归也实际运行通过。首次全套的夹具聚合断言失败日志保留；最终日志writing-refusal-final-whole.log和writing-refusal-final-typecheck.log位于本轮私有证据目录。此时尚未宣称线上部署完成。
