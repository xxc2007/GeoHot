# 2026 年档案处理吞吐与模型恢复审计

日期：2026-10-10（Asia/Shanghai）。第 13 名检查 agent 的只读审查结果。没有改应用代码、门槛、预算、生产回执或生产队列，没有读取生产密钥，没有运行外部采集。

## 范围与证据

阅读 `AGENTS.md`、`README.md`、`docs/manual.md`，重点检查 `editorial/models.ts`、`providers/receipts.ts`、`providers/llm.ts`、`jobs/content.ts`、队列辅助 CLI，以及 `deploy/geohot/archive-cycle.sh` 和对应 systemd timer/service。以下代码路径均相对仓库根；行号对应审查时版本，会随后续改动漂移。

在独立本机数据库 `geohot_a13_test`（127.0.0.1:5433）应用全部 53 项迁移并初始化 pg-boss schema。运行模型池、回执、档案控制三个测试文件：**22 tests、22 pass、0 fail、0 skip**，7.42 秒。所有测试模型请求都指向各文件自己的 localhost stub，采集阀关闭。测试结束后已 DROP 独立数据库。

核对父任务已有日志 `D:\地理热点网站\.round11\tests-ci.log`：407 tests、402 pass、0 fail、5 skip；`web-tests-built.log`：48 tests、48 pass、0 fail。该全集并未覆盖下面的跨健康状态重试、pending 健康判定和持续 live 负载公平性，不能用全集绿灯推导这几个行为已正确。

初次独立命令显式传入 `MODEL_CALLS_ENABLED=false`，造成 config 导入快照关闭模型测试入口；另一次新库未初始化 pg-boss，测试清理查询 `pgboss.job` 失败并留下未关闭句柄。修正测试前置条件后最终 22 项全部通过。这两次运行不是生产缺陷复现；新库单独跑该测试文件时应先初始化 pg-boss，不能依赖先前测试文件的副作用。

## 1. [P1] 未完成请求被当作失败，可能错误排除健康服务

位置：`packages/backend/src/editorial/models.ts:138-146`。

`sickServices()` 分母是十分钟内全部 `receipt_attempts`，分子只计 `received`。六条在飞的 `pending` 会满足“至少六次且成功不到半数”，尽管没有一次已知失败。查询也没有 `origin='live'` 条件，而预算统计明确区分 live 与 replay/imported。

独立库直接插入一条探针回执及六条 pending attempt，全部尚无 finished_at，然后调用真实 `sickServices()`，输出：

```text
SIX_PENDING_SICK [ 'llm' ]
```

这是 SQL 和函数层实证，不是对生产失败频率的测量。实际风险成立条件是某服务同时有六次在飞请求且近十分钟已完成成功样本不足；默认分析并发为 6，结构抽取与评分又可并行，因此不能假定 pending 数永远低于六。错误排除最多缓存一分钟，还会触发下一节的模型重映射。

最小修复：健康采样只计 live、已完成且具有可解释结果的尝试；至少排除 pending。明确 unknown 是否计入失败率，保持 unknown 的可能计费口径不变。补测六 pending 不排除、六完成失败排除、四成功两失败恢复、replay/imported 不影响 live、未知结果的明确策略。不要因健康判断调整预算或删除账本。

## 2. [P1] 健康集变化使重试绕过已经收到的回执，再付一次同样的步骤

位置：`editorial/models.ts:167-174`；`providers/receipts.ts:71-73`；`providers/llm.ts:275-288`。

成员选择取 `hash(shardKey) % healthy.length`。文章 ID 稳定只能保证**成员列表稳定时**的稳定路由；排除任一服务会改变列表长度与索引。回执的逻辑键又包含 service 和 model，因此切换服务后的同样输入不会命中旧服务已经收到的答案。

独立库按真实 `modelFor()` 与 `paidRequest()` 复现：选出正常池中落到 default 的工作 ID，调用一次 paidRequest 并落 received；给 llm 补入六条完成失败探针，清空健康缓存；同一 ID、purpose、identity 再执行一次。付费调用回调用本地函数模拟，没有 HTTP 外发。结果：

```json
{"original":"default","secondModel":"agnes-3.0-flash-cn","firstReceipt":5,"secondReceipt":7,"secondReused":false,"callbackCalls":2}
```

回执 ID 是该隔离库的临时值，不是生产回执。该复现证明路由与回执组合存在重复购买路径；没有声称生产具体重复了多少账单。部分分析已经收到预筛/评分答案、后续步骤失败后整条重试，是可能触发的业务场景。

最小修复方向：先为请求的实际身份查找和复用池内已经 received/completed 的合法答案，只有该步骤没有可复用答案时才走健康选择。必须匹配 prompt/config/input/attemptTag 等完整请求身份，不能仅凭文章 ID 或 purpose 拼凑旧判断。未知回执继续保留未知结果恢复规则，不能因为换服务就立即重送。另一可行方案是记录每一步的已选模型与回执绑定，只允许明确未接受、没有已收答案的步骤改路由；不要把整篇永久锁死在耗尽额度的服务。

必要新增测试：预筛收到、评分失败后服务掉线的整链重试；其中已答步骤不新增 attempt，未答步骤可切健康服务；恢复健康后再次重试仍不重复购买；unknown 不跨服务偷偷重送；两个独立评分请求的身份仍分开。

## 3. [P2] 档案优先级改进了排序，但尚不能保证长期任务取得处理份额

位置：`packages/backend/src/jobs/content.ts:65-98`；`scripts/rebalance-archive-queue.ts:51-89`。

live 为 0，archive 为 -1，普通 late history 为 -2。若可领取的 live 工作持续多于吞吐能力，严格 priority 排序仍会一直先取 live；archive 自动定时器只负责采集和出刊，并没有预留分析份额。把 archive 从 -2 改到 -1 能解决被 late news 压住的问题，却不能保证本次“从一月开始全部按工作流判断”的目标最终完成。代码注释中的历史测量支持这个设计动机，但本次没有读取生产队列，不能把旧测量称作当前值。

最小建议：先观察真实 live 排队时长、成功调用量、archive 队列最老年龄和每天 settled 数，再在总预算与当前并发不变的前提下制定有界份额。可以按时间窗限定少量最老 archive 提升到 live、设 live 延迟阈值暂停提升；如采用独立消费队列，必须与 live 共用相同 budget/receipt 闸门且不叠加额外并发。当前人工 `--promote=N` 应视为容量分配操作，不视为清理。

验收不能只有“队列条数下降”：需证明在持续 live 负载下 archive 至少取得预设最小份额，同时 live 的延迟仍达标。这属于功能/运营验收，没有可用的本轮生产测量，不建议直接凭感觉增加额度。

## 4. [P2] enqueue-analysis 辅助脚本绕过统一路由，把档案工作放入默认 live 档位

位置：`scripts/enqueue-analysis.ts:19-20`；统一入口 `jobs/content.ts:85-98`。

脚本直接 `enqueue(QUEUES.analyze, ...)`，没有调用 `queueProcessing()`，也不传 priority；pg-boss send 默认 priority 为 0。当未分析资料里包含刚导入的 archive，运行此 helper 就会把它们与 live 工作排在一起，还跳过 pending 正文的抽取路由和 `processing_queued_at` 记录。该结论来自代码路径审查，本次没有对生产执行此 CLI。

最小修复：改用统一 `queueProcessing(articleId)`，必要时为维护目的显式选择 analyze 步骤，但仍复用统一历史优先级。保持 limit、singleton 去重和回执机制。补测普通 live 为 0、archive 为 -1、late history 为 -2、需要正文的档案按正常 extract 路由进入，且记录 queued timestamp。

## 其他边界及定时器审查

* 已有回执机制保留了服务 advisory lock、received/completed 复用、pending/unknown 禁止即时重送、明确拒绝记 failed、failed 无 usage 不消耗小时/天花费额度但仍消耗分钟速率。现有 7 项回执测试全部通过，不建议通过删除回执改善吞吐。
* `rebalance-archive-queue.ts:53` 的 promote 使用 `Math.max(0, Number(value) || 0)`，没有安全整数和上限验证。Infinity、分数和巨大数字不会像其他新 CLI 一样在 DB 写操作前拒绝；有 apply 时前面的档位更新可已执行，之后 LIMIT 才报错。建议先验证有限正整数和明确上限，并保留数据库目标校验。此项为静态维护入口风险，没有生产执行。
* archive cycle 有非阻塞 flock、采集上限、分阶段 timeout、总 deadline、最终观测快照、私有日志、失败 exit ledger、systemd MemoryMax/CPUQuota、默认 apply=0、默认不刷新已存刊期。源码支持这些防护；本次没有在服务器实际启动服务，不把静态审查等同于 systemd 上线验收。
* 15 分钟 timer 的 oneshot 若运行超过间隔，不代表并发跑多轮；service 在执行时不会再起同一个单元。真实推进速度受周期运行时间和 worker 模型能力制约。新循环不启动额外 worker，符合容量控制。
* 数字 round-robin cursor 是对动态 eligible 数组的索引。done slice 被移出后索引位移，部分 slice 可短期重访或跳过；这不直接证明永久饥饿，但不能声称严格 source/month 公平。需要动态删除已完成 slice、坏 slice、多信源扩容的测试，或改为稳定 source/month 键与最近访问时间。
* 服务检测全部成员不健康时退回整个列表，可继续获得恢复样本，但会在日额度持续 429 时周期性探测；失败退避仍由文章重试阶梯约束。现有实现没有供应商 reset 时间或 Retry-After 感知。改进应保留小比例恢复探针，避免“全坏就永久停机”或“每条内容都高频探测”。

## 推荐下一轮验证次序

1. 修正 pending/live 健康样本口径，并验证健康变化后的已有回执复用。
2. 统一维护入队入口，保留 live/archive/history 分档；验证 promote 的非法参数在任何 DB 写前失败。
3. 给持续 live 负载下档案推进设可测量的有限份额与 live 延迟阈值；不能通过调低筛选门槛换吞吐。
4. 对定时器做服务器上的单轮受控验证：flock、阶段 timeout、cursor、exit ledger、状态快照、已存刊期不重写、资源限制。只有这轮实测后才判定已部署并正常迭代。

本报告的 22 项通过是现有局部行为的验证，额外两项隔离复现是新增缺陷证据；尚未实现修复，也没有证明生产历史处理已全覆盖或最终报告已全部出刊。
