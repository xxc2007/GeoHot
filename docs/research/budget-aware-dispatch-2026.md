# 同模型池的本地预算感知派发

第 16 名 agent 第二轮，2026-10-10。仅本地准备、隔离验证和生产只读观察；生产部署由根任务批准执行。

## 诊断与当前限制

源码检验显示，回执恢复不会把后续未答步骤锁回缓存所属模型。预筛返回的 model 是审计元数据；后续评分、结构和写作分别重新调用 modelFor。此前 modelFor 只检查终态健康率，稳定成员集合与相同文章 ID 仍产生同一选择。paidRequest 命中已有缓存之后免费返回，但遇到缺失步骤时，只检查当前所选服务的预算并抛出等待错误，未利用同池其他健康服务的剩余额度。

生产只读快照（北京时间 23:01:40，统计窗口与真实预算闸相同）：

| 服务 | 分钟使用/上限 | 小时可能计费/上限 | 滚动日可能计费/上限 |
|---|---:|---:|---:|
| llm | 8/8 | 291/420 | 2541/6000 |
| dots | 20/20 | 599/600 | 5042/6000 |
| agnes-cn | 0/9 | 5/540 | 4249/12000 |
| openrouter | 0/18 | 0/300 | 51/600 |

23:02:30 的十分钟 live 终态健康样本为：llm 75 次/72 received、dots 68/67；agnes-cn 9/1、openrouter 18/0，后两者按现有规则被排除。因此观察当刻**没有健康且闲置的替补服务**。修复不能凭空增加额度或立刻解决所有档案等待，只能防止未来所选服务受本地预算限制时，有额度的健康同池成员被闲置。不得把旧健康/缓存修复的进度归功于本轮尚未部署的代码。

23:02:30 重取当前已部署 reserved CTE 的最老 100 条 eligible archive：83 条存在同 subject 的 received/completed，关联过去一小时 live attempts 为 35。此为动态集合，与第 13 名 agent 较早固定批次不可直接作增量比较。同 subject 不是完整请求身份验证，不能据此断言 83 条全部缓存都适用于当前步骤。

## 最小修复

保留原 modelFor 选择作为首选。chatJson 从相同当前 capability 配置池构造备用 dispatch；只接受凭据与模型已配置、输出能力满足该 capability、未被现有健康规则排除的成员。含 image_url 时，备用必须明确支持 vision，不能悄悄删除图像发给文本模型。

paidRequest 增加可选的 `{request, call}` 备用 dispatch。其执行顺序保持：

1. 按候选服务排序获取原预算 advisory locks。
2. 精确 logical_key 查缓存，received/completed 优先免费恢复。
3. 没有已收到答案时，任意匹配 pending/unknown 阻止新发；stale pending 仍转 unknown。
4. 在相同事务锁内依次检查首选与备用的原预算。只对本地 BudgetExceeded 跳过服务，所有窗口仍使用原数值、原 live/可能计费口径。同服务多个模型共享预算，一旦 blocked 不重复尝试它的其它别名。
5. 只有预算通过的真实 request 可以写 pending 与 attempt；事务外只运行其对应 HTTP 闭包。全部 blocked 不生成 receipt/attempt。

HTTP 503、429、内容过滤或 transport unknown 不在这次调用中自动换家，避免把已经外发的请求重新购买。旧调用方不提供 alternatives 时维持原行为。实际响应模型由选中 logical_key 标注。

评分仍为原两次独立 score-1/score-2、原权重与门槛。runScores 的 model 元数据记录实际回答成员：一名保留原名，多名为去重的逗号列表；receiptIds 保持每次评分的身份。ProviderRejectedError 仅新增可选 registry modelKey，LLM 明确 HTTP 拒绝时填写真实派发成员；content-filter refused 记录已答和实际拒绝成员，不从错误文本猜模型，不额外查库。旧 provider 未填 modelKey 时兼容原行为。

## 隔离验证

再次创建本机 geohot_a16_test 并迁移 53 项。仅 localhost stub，采集关闭，未加载 .env，未改生产数据库和预算。最终 receipt-pool-recovery.test.ts **22/22 通过**，backend/tests 类型检查通过。

在原 9 项缓存恢复上，新增验证覆盖：分钟满且健康备用可用；已答预筛/score-1 在全部预算满时仍 replay，只有缺失 score-2 使用备用；全部预算满零新记录；unknown 先于备用选择；HTTP 失败不即时换家；不同请求争一余量不超预算；同 logical step 并发备用只购买一次；vision 文本成员禁止派发；小时/日窗；真实 runAnalysis 的两评分模型/回执元数据；不健康备用禁止；transport timeout 不换家；首评分/后评分备用内容过滤时 refused 元数据正确，三成员池第三个 stub 始终零请求。

测试的预算提升与环境/后台设置临时变动只发生在 *_test fixture，并在 after 恢复；自身 receipts/attempts 清理。拒绝测试初版沿用另一 fixture 的完全相同评分输入，因此正确命中既有回执而未调用拒绝 stub；修正为内容含独立 fixture ID 后通过，未改缓存身份算法。

联合既有 default-model、model-pool、receipts 与新增文件：**40 tests、40 pass、0 fail、0 skip**，9.27 秒。第 18 名独立 agent 继续复核最终 22 项。独立 geohot_a16_test 在完成后删除并查询确认 remaining=0。

整站持续吞吐、已购链完成度、未知结果数量、完整成稿数和生产表现仍需根任务部署后观察，局部绿灯不能证明全量历史筛选完成。

## 全套后 X shard 失败排查

根任务正确清除继承阀门后的全套记录为 436 tests、428 pass、3 fail、5 skip；三个失败都来自 x-shards，首轮 failed 引发 partial 与后续 query 缺失。第 16 名 agent 创建另一轮 geohot_a16_test（53 迁移及 pg-boss 初始化），正确测试环境下单文件 **6/6 通过**，随后再次运行仍 **6/6 通过**。未调整期望、跳过测试或更改生产代码，仅给原 status 断言补真实 res 诊断信息。

对 shared geohot_test 仅只读查询，发现全套失败关联的四个 socialdata 回执是 unknown，error 为 TypeError: fetch failed，时间为 23:16:00；不是预算错误。23:18:47 根任务复跑的另一组同库 x-shard 回执出现 received 及预期的 socialdata HTTP 500，说明这次网络链能正常连接。fetch_runs 已被正常测试 cleanup 带走，未删除任何回执或改 shared 库。

这些证据未复现新的 generic paidRequest 退化，指向首次 localhost transport 失败；原始底层 cause 未被回执保存，具体系统原因仍未确认，不能把它报告为已经找到根因或擅改请求保护。新未知结果仍按原安全规则停止重送。独立库在重复验证后删除并确认 remaining=0。

根任务随后创建新的 `geohot_root_budget_final_test`，显式设置测试数据库、清除继承的采集/模型阀门与 MODEL_POOL，不加载 .env；应用 53 项迁移后运行完整 `npm test`。最终 **436 tests、431 pass、0 fail、5 skip**，203.30 秒；X shard 六项也全部通过。此前两份失败日志仍保留，不用重跑成功倒写失败事实。最终 `npm run typecheck` 全部工作区通过，新增回执逻辑另由第 18 名 agent 在独立库复验 22/22。
