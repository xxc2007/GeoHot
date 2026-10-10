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

## 最终部署后仍须执行

1. 只读确认运行中的 worker 已加载本次 `content.ts`，观察至少一个真实安全网周期。核对 archive 新增创建/活跃作业、近期 `processing_queued_at` 与成熟候选数量，不能只根据单元 active 或磁盘文件一致判定生效。
2. 观察 archive 正文抽取成功、正文状态与后续分析回执，分开统计缺失原文、预算等待、永久失败与精选结果；公平配额不解决缺失抽取凭据或超时。
3. 再运行上述线上冒烟，确认所有公开出口与三种刊物内容一致；历史未完成时不能把空刊或跳过刊当作已出刊。
4. 用最终部署版本浏览器验证分类、搜索、归档年月、条目与主题详情、收藏、反馈及移动端导航；HTTP 200 不证明这些交互正常。
5. 对最终 GitHub 树、部署源文件和运行时版本做一致性核验。这里的编译、队列功能测试与当前线上冒烟不构成全仓代码审计或最终同步证明。
