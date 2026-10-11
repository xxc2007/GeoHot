# Archive 安全网与功能核验（2026-10-10，agent 19）

## 已确认问题与最小修复

主 agent 提供的生产只读快照显示：3,001 条显式 archive 中 2,842 条仍为 `new`，安全网中的更早普通历史导入反复等待预算；已创建的分析作业均为 `first-import` / `stale-on-discovery`。这一组计数来自主 agent 当次采样，本文没有另行查询生产数据库，也不把它当作最终计数。

原 `sweepUnprocessed()` 按 `discovered_at ASC LIMIT 500` 取成熟候选。只要更早的普通导入反复达到重试时间，它们便可占满 500 个名额，archive 在入队之前已经饥饿；提高 archive 的队列优先级无法修复候选未被选中的问题。

本次仅调整这一段候选 SQL：

- 成熟条件仍为 `new`、创建至少 3 分钟、到达重试时间、没有近期入队记录。
- 从显式 `backfill_reason = 'archive'` 的候选中保留最多 100 个名额。
- 普通候选获得 `500 - archive保留数` 个名额。
- 普通候选不足时，剩余名额再由 archive 补足。
- 每组均按发现时间与 ID 排序，最终最多 500 条，无重复候选。

无 archive 时普通工作仍可取满 500；普通工作不足时 archive 可以取满剩余配额。队列优先级、预算、评分门槛、并发数、worker 数、抽取消费者以及后半段发布投影补偿均保持原值。它改善 archive 的入队机会，并不承诺预算内的分析完成时刻；一般旧闻之间仍沿用原有最早发现排序。

## 已执行验证

独立本机数据库 `geohot_a19_test`（PostgreSQL 17，localhost:5433）从空库应用 53 个迁移文件，最高现有文件编号 0056。测试不读取 `.env`，不启用分析 worker、不访问付费模型，队列路由检查虽临时打开采集标志，也没有启动采集消费者或发出原文网络请求。

命令：

```text
node --test --test-concurrency=1 --test-timeout=120000 tests/archive-sweep-fairness.test.ts tests/signals.test.ts tests/test-db-hygiene.test.ts
npx tsc -p packages/backend
npx tsc -p tests
node scripts/smoke.ts --base https://xxc2007.me/geohot
```

结果：11 项相关数据库测试全部通过，两个 TypeScript 检查通过。新增 5 项测试覆盖以下实际行为：

| 输入与条件 | 已验证结果 |
| --- | --- |
| 更早普通历史导入 700 条，archive 120 条 | 原旧排序会选到 0 条 archive；新选择实际入队普通 400、archive 100，总量 500 |
| 普通 600、archive 0 | 普通实际入队 500 |
| 普通 20、archive 600 | 普通 20、archive 480，总量 500 |
| 普通 600、archive 20 | 普通 480、archive 20，总量 500 |
| 未到重试时间、近期已入队、刚创建、已失败等候选 | 均不进入安全网；唯一成熟 archive 先进入正文抽取队列；第二次安全网不重复选择；直接重复提交被 singleton 去重；正文确认后进入分析队列 |

既有 signals 回归还验证实时条目仍使用优先级 0，archive 使用 -1，迟到旧闻使用 -2；没有提高历史任务到实时任务之上。测试夹具清理后孤儿等待作业也被清理，独立库在完成后删除。

当前生产只读冒烟全部通过：网站 17 个页面入口、公开 API、五类 feed、sitemap、manifest、OpenAPI、图标、MCP initialize、`/geohot` 路径前缀以及出口一致性。采样当时 sitemap、日报 feed、site 日报索引与 v1 一致返回 6 期；首页 40 条、v1 精选 100 条、v1 全部 100 条、精选 RSS 50 条、主题页 20 条、日报版面 20 条均有中文标题。健康接口报告数据库正常，但 release 仍为 `dev`。这些是部署修复前的线上基线，不是最终版本验收。

## 部署后真实周期验证（release f6f0230）

主 agent 通知部署完成后，本 agent 通过受信任 SSH helper 只读观察了 22:38:54—22:43 左右（Asia/Shanghai）的有界窗口，未触发手动 sweep、未重启服务、未写生产数据库。

两次真实 `content.sweep` 运行记录均成功：

| job_runs ID | 起止时间 | 实际结果 |
| --- | --- | --- |
| 27120 | 22:35:43.004—22:35:50.454 | `ok`，`enqueued:500, published:0` |
| 27128 | 22:40:43.014—22:40:46.677 | `ok`，`enqueued:500, published:0` |

22:38:54 的 archive 原文抽取队列为 created 2,956 / active 2；22:41:21 为 created 2,696 / active 1。archive 分析队列从 active 15，变为 created 58 / active 18；所有这些 archive 作业的优先级都是 -1。22:40:43—22:40:47 的作业创建窗口还实际包含普通历史分析 400 条（-2）和 archive 分析 111 条（-1）；后者同时包含原文抽取完成后续接的分析作业，因此不能把这个重叠窗口的 511 条作业误读为 sweep 超过 500 个候选。

22:41:21 时，76 条 archive 的 `processing_queued_at` 晚于观察基线；archive 整体为 analyzed 137、blocked 66、new 6,318。本窗口新增完整分析通过数仍为 0，但后续只读查询确认基线之后已经生成 archive 分析记录：block 15、unknown 3。预筛拒绝和未确认结果必须分别记账，不能作为新精选或刊物材料。本窗口足以确认安全网能入队、抽取消费者确实领取、分析有实际回执链进展，并不证明六千多条积压已完成。

worker 单元 active，MainPID 962637，cgroup 只包含一个进程（`/proc/PID/comm` 为 `MainThread`，未读取进程参数）。MemoryMax 240 MiB。预算只读值仍为 llm 8/420/6000、agnes-cn 9/540/12000（分钟/小时/天）；本修复没有增加实例或预算。active 作业数是数据库状态计数，不等同于 worker 实例数，也不单独证明所有 active 作业正在发请求。

本观察后再次执行线上 `scripts/smoke.ts`，所有检查通过，日报出口仍一致为 6 期。该检查覆盖页面响应与机器出口，不替代移动端交互审片或历史刊物完成度验收。

## 最终验收仍须执行

1. 已观察一个部署后的真实安全网周期及 archive 队列进展；继续跟踪完整预算窗口的完成量与未决回执，避免把短窗活动误认为历史回填闭环。
2. 观察 archive 正文抽取成功、正文状态与后续分析回执，分开统计缺失原文、预算等待、永久失败与精选结果；公平配额不解决缺失抽取凭据或超时。
3. 再运行上述线上冒烟，确认所有公开出口与三种刊物内容一致；历史未完成时不能把空刊或跳过刊当作已出刊。
4. 用最终部署版本浏览器验证分类、搜索、归档年月、条目与主题详情、收藏、反馈及移动端导航；HTTP 200 不证明这些交互正常。
5. 对最终 GitHub 树、部署源文件和运行时版本做一致性核验。这里的编译、队列功能测试与当前线上冒烟不构成全仓代码审计或最终同步证明。
