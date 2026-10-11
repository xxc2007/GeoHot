# 模型池回执恢复修复与隔离验证

2026-10-10，第 16 名 agent。对应第 13 名 agent 复现的健康池变化后重复购买已答步骤问题。修改局限于模型候选读取、真实请求身份构造和回执恢复，不改变模型名单、预算、评分门槛或生产回执。

## 行为

`chatJson()` 按 `CAPABILITIES.purposes` 登记找到该步骤当前配置的模型池，配置优先顺序继续采用后台设置、步骤环境变量、MODEL_POOL、代码默认。候选只来自这个当前配置池；显式请求不属于配置池时，只恢复该模型自己。候选名单保留不健康或缺少当前凭据的成员，因为已经收到的答案无需再次连接该供应商。

每个候选使用与实际 HTTP 请求共用的 `requestFor()` 计算其完整回执身份，包括服务、模型、purpose、promptVersion、system/user 哈希、temperature、实际 maxTokens、JSON 模式、extra 和 attemptTag。不同成员的 reasoning 余量、extra 和 JSON 能力分别计算。只查询这些准确 logical_key，未按文章 ID、subject 或 purpose 模糊查询。既有回执键算法未变，因此已存回执继续可用。

`paidRequest()` 在一个事务内按服务名排序获取候选涉及的预算 advisory locks，再按精确键读取并锁定候选回执。先复用 received/completed；如果不存在已收到答案，任意候选 pending/unknown 都会阻止跨服务新发。过期 pending 按既有十分钟规则转成 unknown，后续仍由原有自动恢复与管理员流程处理。明确 failed 才允许当前所选健康成员建立新 attempt，且其自己的预算检查继续生效。

同时有已收到和未知候选时，只返回已有答案，不增加 attempt，不声称未知那一次没有计费。返回的模型名称按真正命中的 logical_key 标注，避免把旧成员的判断标为新成员。不同成员同时请求同一组身份时，服务锁交集与 pending 占位会阻止两次同时购买；锁仅覆盖数据库事务，不覆盖外部 HTTP 等待。

## 验证

独立本机 `geohot_a16_test`（127.0.0.1:5433）应用 53 项迁移。模型 URL 全部指向测试文件创建的 localhost stub，没有读取 .env，没有向生产模型发请求，没有改生产数据库。

新增 `tests/receipt-pool-recovery.test.ts` 的 **9 项全部通过**，覆盖：

- 真实 modelFor 健康重映射场景：预筛已收到、评分明确失败，重试复用原预筛，未答评分可使用新健康服务；服务恢复后预筛仍复用。
- 候选 unknown 阻止跨服务购买；候选 stale pending 转为 unknown。
- 另一个候选 unknown 或缺少凭据时，可安全复用已有 received。
- 两个成员并发处理同请求，第二个被 pending guard 阻止，答案完成后可复用。
- 两次独立评分的 score-1/score-2 attemptTag 保持两个请求，分别恢复自己的答案。
- 各成员 extra、reasoning 余量和 token 上限按自己的实际参数计算；参数变更不能错误复用旧身份。
- 单模型配置切换不偷偷恢复配置外的旧成员。
- 输入、提示词版本、JSON 模式和显式 rerun 各自保持身份隔离。

联合运行既有 `default-model.test.ts`、`model-pool.test.ts`、`receipts.test.ts` 与新增文件：**27 tests、27 pass、0 fail、0 skip**，8.89 秒。backend 与 tests TypeScript 检查通过。联合测试先初始化 pg-boss schema；新增文件本身不需要队列表。

初次重复跑隔离测试库时，前次测试样本影响健康分母，并触发 agnes-cn 每分钟 9 次限制。这是测试 fixture 不充分，不是应用回归：已修正为动态构造失败样本、仅测试期间保存并提升 fixture 容量，after 恢复原预算/环境/后台配置并清理自身 receipts/attempts。修正后再次独立运行 9 项全部通过。生产预算未调整。隔离库在验收后删除。

## 范围与剩余边界

没有改历史回执数据，没有统计或声称追回生产账单。本轮证明精确同请求在当前配置池内的恢复行为；未做供应商真实计费验证。

管理员移除旧成员、修改模型名、请求参数或 attemptTag 都意味着不同的当前候选身份，旧答案不会被扩大范围地复用。当前版本只解决同配置池健康路由变化；不保证跨配置版本复用。既有 unknown 自动释放次数和时间、原有拒收答案规则、两次评分身份与预算熔断均保留。

排序的多服务锁仍会串行化短暂预算事务，以保证交叉成员并发安全；真实供应商 HTTP 请求仍并行执行。整站吞吐、最终生产部署及全量历史内容出刊由根任务和独立检查负责，不由本报告的局部测试推导完成。
