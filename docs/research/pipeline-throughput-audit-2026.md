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

## 第二轮：已部署修复后的生产只读观察（22:46—22:51）

父任务确认前述健康样本、跨池回执、入队 helper 及安全网 archive 配额修复已由 `f6f0230` 部署；本轮不重复把已关问题列成现存缺陷。阅读本机当前 `jobs/content.ts`，安全网实际为 archive reserved 最多 100 + ordinary 取得其余名额 + archive remainder，总计最多 500。后端完整测试已有 423 项、418 通过、5 跳过（此数来自父任务通知，本 agent 本轮未重跑全集）。

使用父任务授权的 `.round11/remote.ps1`，通过服务器本地 PostgreSQL 执行 `BEGIN READ ONLY` 与 20 秒 statement timeout 下的聚合查询。没有打印 `.env`、进程命令行或 API key；供应商 error 只输出 HTTP 状态及预先限定的类别/关键词，未打印完整响应正文。所有数字为观察窗口快照，会继续变化。没有修改生产数据。

### 实际服务、预算与未知结果

2026-10-10 22:46:10，北京时间：

| 服务 | 分钟上限/已发 | 小时上限/花费口径已用 | 滚动 24 小时上限/已用/剩余 | 最近一小时结果 |
|---|---:|---:|---:|---|
| dots | 20 / 19 | 600 / 511 | 6000 / 4859 / 1141 | 502 received、1 failed（HTTP 403）、1 unknown、8 pending |
| llm | 8 / 8 | 420 / 237 | 6000 / 2443 / 3557 | 228 received、9 failed（HTTP 429）、1 unknown、8 pending |
| agnes-cn | 9 / 9 | 540 / 7 | 12000 / 4248 / 7752 | 7 received、45 failed（HTTP 429） |
| opencode | 10 / 3 | 300 / 28 | 3000 / 204 / 2796 | 27 received、1 pending |
| openrouter | 18 / 0 | 300 / 0 | 600 / 51 / 549 | 89 failed（HTTP 429）、0 received |

“剩余”是本站 `budgets` 熔断器按 `origin=live` 且排除 failed/no usage 的滚动账本计算；**不是供应商账户实际剩余额度**。不要把 agnes 的 7752 或 openrouter 的 549 称作可用供应商容量。Agnes 的失败文本只检测到 rate 关键词，没有 daily；OpenRouter 检测到 daily、rate、credits 关键词。这个窗口能确认 HTTP 429，不能在没有更直接证据时把 Agnes 判成供应商日额度耗尽。

最近十分钟按部署后的终态健康规则：agnes-cn 9 次完成尝试中 1 次 received，判 sick；dots 184 中 183 received，健康；llm 72 中 65 received，健康；opencode 17/17，健康。OpenRouter 在这个十分钟窗口没有足够终态样本，不应据此把它说成已经恢复。

22:46:41 左右数据库共有 **8 条 unknown 逻辑回执**，包括历史保留记录：agnes understand 1；dots understand 1；llm prefilter 1、score 1、summarize 2、understand 2。最近一小时新出现 dots unknown 1（约 180 秒）、llm unknown 1（约 240 秒）。这些仍是“结果未知、可能计费”，没有计入成功。当前 pending 记录都来自最近几分钟，没有查到长期 pending 堵死服务的证据。

档案唯一 failed 条目的回执明确是 dots HTTP 403，不是 unknown。这是明确拒绝，不能通过反复立即重跑绕过它；应按已有失败恢复规则处理。

### 档案推进速度与排队分布

22:46:10 的 archive 状态：141 analyzed、90 blocked、1 failed、3967 new/ok、2322 new/pending，总计 6521。22:48:15：143 analyzed、94 blocked、1 failed、4182 new/ok、2101 new/pending，仍总计 6521。两分钟正文 pending 减少 221，而 analyzed + blocked 增加 6，说明抽取正在推进，但抽取成功远快于实际筛选完成。不能把 pending 转 ok 报成模型筛选完成。

22:46 时 new 档案的 retry 时间分布为：3888 已到期、2201 无 retry、200 未来十分钟内到期；没有超过一小时的延期记录。稍后 new/ok 有 4028 条，其中 3739 已到 retry 时间，但仅 9 条存在 active/created/retry 的对应工作；new/pending 有 2260 条，其中 2098 有抽取/分析工作。后者说明正文抽取作业大多已排队，前者需检查组内公平性而不是单纯等待正文。

按 model origin 的 analyses.created_at 分小时统计如下。它是“这一小时写入的分析行”，不是整点时状态差分；14 点截取窗口只含约 14:48 之后，且同文章有重分析可能，不能把分析行累计当作新增材料数。

| 小时（北京时间） | block 行 | pass 行 | unknown（文稿不完整）行 | selected 行 |
|---|---:|---:|---:|---:|
| 14 点（部分窗口） | 0 | 26 | 3 | 0 |
| 15 点 | 3 | 25 | 0 | 7 |
| 17 点 | 1 | 0 | 0 | 0 |
| 18 点 | 10 | 0 | 0 | 0 |
| 19 点 | 2 | 0 | 0 | 0 |
| 21 点 | 0 | 1 | 0 | 0 |
| 22 点截至 22:48 | 58 | 4 | 3 | 1 |

22 点 65 行中只有 62 行明确 pass/block；3 行 unknown 不计作真实成功筛选。大多数结束于预筛 BLOCK，通常只需一次模型请求；未来文章可能需要预筛、两次评分、写作、结构，所以上述 62/48 分钟不能直接外推整个余下队列的固定速度。

同时观察到全站模型 received 在 20、21 点分别约 dots 472/477、llm 234/230，22 点截至观察时 dots 470、llm 204。模型服务在产出答案，但这些包含 live/history/reports 等用途，不能全部归因于 archive。

### 当前有依据的组内吞吐阻碍

按**部署当前完整 CTE**重放选择条件，观察到 reserved=100、ordinary=400、remainder=0，archive 配额已生效。最早 100 条 eligible archive 全部正文 ok，上一次错误全部为 Budget 等待：agnes minute 41、llm minute 30、dots minute 27、dots hour 2。其 discovered_at 都在当天 01:50—01:52。同一批 100 条中，94 条最近一小时被 content.analyze 启动至少两次，平均启动 2.85 次，最多 3 次。

这证明“archive 组内最老条目反复预算等待”存在，未证明这些条目此刻仍一定路由到错误所写服务，因为 processing_error 是上一次结果、健康集合已发生变化。不能直接把它认定为排序 bug，下面的已购步骤观测表明完成度与公平性有实质取舍。本 agent 没有改变排序。

后续按同一个 reserved 规则重新取 100 条，用精确 `subject='article:'+id+'@'+revision` 聚合 received/completed 回执：48 条没有缓存；31 条有 1 个；8 条有 2 个；8 条有 3 个；4 条有 4 个；1 条有 5 个。共 **52 条已有部分缓存**。用途合计 prefilter 58、score 16、structure 18；这些是回执数，跨服务历史重复可能存在，不能把 5 个回执直接等同于已经完成五个独立步骤。没有写作用途的已收回执。

同一批 100 条的 received_at 在过去一小时增量为 0，关联 live receipt_attempts 在过去一小时也为 0；结合此前重复启动统计，这批工作最近启动主要碰本地预算闸就退回，没有本轮已测到的外部新调用或 partial advance。预算闸未放行不会生成 attempt，这是正确的预算防护，不能为了制造“有进度”绕过它。

**公平与完整成稿的取舍：**直接把这 100 条换成后面 6000 条从未尝试资料，可能消耗所有容量用于预筛、增加 BLOCK 数，却延迟已经买了预筛/评分/结构的 52 条完成写作。若要改善公平性，应先识别缺失步骤与它需要的当前可用服务容量，保留部分完成链的优先机会，仅用小且明确的份额给新样本轮转。需要同时测完整 pass/可公开成稿数、已购步骤复用、unknown 禁止重送与未尝试条目最长等待，不能只以 prefilter BLOCK 或开始次数作为效率指标。任何方案仍通过 queueProcessing，保持 priority、总预算与回执身份；当前观察不足以证明哪种排序策略能提高完整成稿率。

**审查纠正：**本 agent 中途曾执行旧版单一 `ORDER BY discovered_at LIMIT 500` 查询，得到首 500 没有 archive；那不是已部署 CTE，不能证明 archive 保留配额未生效。该结论已向父任务撤回。此处只采用当前 reserved/ordinary/remainder 的重放结果。

其他无需加预算的机会：

* 协调分钟预算的发起时机，而不是把大量同时就绪工作反复送到预算闸后退出。保持服务 advisory lock 和回执，避免粗暴扩并发。当前 llm 与 dots 分钟窗已接近满，增加分析并发不等于增加模型吞吐。
* 在明确服务暂时不可用时减少无产出的恢复探针。OpenRouter 一小时 89 个 429、0 received；Agnes 45 个 429、7 received，恢复探测可更有界，但保留小比例探针以发现恢复。不要根据失败文本推测的日额度随意放宽本站预算。
* dots 滚动 24 小时剩余 1141 次，而未来两小时没有该服务旧计费尝试到期释放（本次查询结果）。按当前约 500 次 received/小时，粗算约 2.2 小时后可能碰本站 day 闸；真实时间受失败、unknown、live 抢占和其它用途变化影响。llm 未来两小时预计仅 117 次旧尝试离开滚动窗，Agnes 20 次。供应商额度恢复时刻未验证。

### 完成时间的条件性估算

截至 22:48 仍有 6283 条 new 档案。若后续稳定取得 50—150 条**明确 pass/block**档案判断每小时，单纯处理这批现有资料需约 42—126 小时（约 1.7—5.2 天）；不包含新增采集、正文抽取失败、unknown 人工处理、报告完整刷新和部署验收。这个区间仅是容量场景，**不是承诺的完成日期**。

目前此前数小时档案推进有断档、reserved 旧组预算重试、dots 将接近日闸、供应商 429 等因素，尚不能给可靠上界。最关键下一步是先消除组内轮转阻碍，连续观察至少一个完整小时、最好跨预算滚动窗，按明确 pass/block 增量与 new 总量净减建立预测；遇新增采集需单独报告到达率。没有这些稳定测量时，不能承诺今晚全部筛完、全部报告可按完整历史最终出刊。
