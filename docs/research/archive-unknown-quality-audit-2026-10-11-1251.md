# 档案 unknown 的只读质量处置核验

观测时间：2026-10-11 12:50:54—12:51:25（Asia/Shanghai）。通过既有 remote.ps1 执行 SELECT，查询处于 `SET TRANSACTION READ ONLY` 事务，finally 关闭连接。本次没有排队、付费探测、修改数据库、删除回执、部署、上传配置或备份，也没有读取或输出原文及完整模型响应。仅新增本地报告，未提交。

## 口径与最新分类

按文章取最新分析（`id DESC`），同时要求分析 revision 与文章当前 revision 一致，`backfill_reason='archive'`、timeline_at 自北京时间 2026-01-01 零点至查询时刻、`origin=model`、`relevance=unknown`。该口径本次为 **62 条**。

| 检查项 | 实查结果 |
| --- | --- |
| 写作类型 | 62 条全部 summarize |
| 关联写作回执 | 62 条全部 failed |
| 明确错误前缀 | 62 条全部 `answer refused: answer has no Chinese copy` |
| 写作模型 | space-bunny-free 57、dots3-note-prev 4、default 1 |
| 身份守卫 fallback 记录 | 0 |
| 没有写作回执 | 0 |
| 其他关联步骤 | 每条预筛、两次评分、结构四条回执全部 completed |
| 当前文章 processing_attempts | 全部 0；这些是旧 analyzed/unknown 成果 |
| 同 revision 全部写作回执中的 received/completed | 0（总计 65 条写作回执，不只检查最新分析关联的 62 条） |

这些 unknown 是已经收到但被本地中文可用性检查明确拒收的写作回答，**不是**供应商 HTTP 拒绝，也不是回执 outcome unknown、身份误判或结构步骤失败。错误前缀“answer refused”属于本地编辑判断，不能把它写成供应商内容审查拒绝。

关联写作回执 attempts 分布为：60 条为 1，1 条为 2，1 条为 6。两个例外分别为：

- `wvsm3o2i6nn60sum90i8siv8q`：回执 80070，attempts 2。
- `ou7gm35irvyez9zq50196jqep`：回执 80191，attempts 6。

因此 processing_attempts=0 不表示这些回答历史上从未重新请求；回执与文章恢复计数不能混用，也不能为了适配新上限而抹去历史计数。

## 可复用缓存候选

本次查找同 article/revision 的所有 summarize/understand 回执，而非只检查最新分析关联的回执。没有任何 received/completed 写作回执，因此“有效回答已到、仅旧 unknown 没有投影修复，可零新增写作请求回放”的精确候选是 **0 条**。

四个非写作步骤已有 completed 回执，只能证明既有步骤账本有回答，不证明它们的当前模型规格、提示词版本或逻辑键全部不变。不能从这一事实承诺重新走整条工作流零新增请求。失败的写作回执不能伪装为好缓存，也不能通过直接修正文案、分数或 selected 绕过正常流程。

本次 62 条没有识别到身份守卫或无写作请求的真实短材料 none 类 unknown；此结论仅限这 62 条，不等于证明全库 unknown 都能重试恢复，也没有审读材料充分性。真正的身份守卫 fallback、文本过短、缺日期或缺摘要证据仍需按自己的原因处理，不能统一视为 provider 可重试故障。

## 公开投影边界

这 62 条 publications 均为 `eligible=false`、`selected=false`，摘要均为空；没有非空英文摘要。49 条投影标题仍为英文原文标题，13 条投影关联分析/版本没有指向当前最新分析；这些旧投影仍不可进入候选池或精选。

代码核验：`publication/rules.ts` 的 isPoolEligible 要求 pass、标题与摘要齐全；pool、timeline、v1 all、普通 feed 等列表额外使用 eligible，精选用 selected 和中文标题/公开时间闸门。因此不能将这 62 条视为已公开的中文成稿。

`publication/detail.ts` 与 itemHasPage 的代码允许部分非入选、尚无中文稿的条目保留直接详情入口；前端 item.tsx 有非中文标题时提示“还没有中文稿”的分支，无摘要时不绘制摘要段落。这是代码行为核对，不能据此声称这 62 条的直接详情均已实测可读，也不能宣称每个直接详情页都隐藏英文标题。本文没有抓取逐条详情 HTTP，也没有验证全部站点页面、所有历史版本或人工覆盖字段。

## 有界处置建议

1. 以根已核验的写作明确拒收传播修复为前提，旧拒收不能再次落为成功 analyzed/unknown；应进入现有 ModelOutputError 与原三次恢复上限。无需扩大预算、修改精选门槛或清空回执。
2. 用户最新门禁要求全部目标完成后才统一同步。本文不建议现在部署、排队或上传任何配置；本报告只是最终处置前的只读依据。
3. 当前没有可精确复用的好写作回答，不建议批量 normal requeue 再次消耗相同空答。这 62 条应作为尚未修复的写作缺口保留，不能计入 pass。未来仅在已验证对应写作能力或请求契约修复、且最终门禁允许时，再对有根据的少量样本通过正常队列做有界恢复；保留 revision、原回执与历史计数，不强制 attemptTag。三次上限达到后，应留下明确失败及原因，而不是不断重置计数。
4. 既有五个正常 queue pilots 已由根/a01独立确认 pass、nonselected；不要再次入队。旧 unknown 的修复也不保证入选，只能恢复正常质量判定。
5. 13 个未指向最新分析的投影可在合法恢复完成后由原发布工作流同步；当前 eligible/selected 均为 false，不需要直接写 selected 或把空稿提前展示。

## 08:11 早期只读观察的保留证据

同一 archive 口径当时为 unknown 28：全部写作回执 failed、本地原因均为无中文、其他四步 completed；模型为 space-bunny-free 24 与 dots3-note-prev 4，全部 processing_attempts=0。这一旧计数已被本次 62 条刷新，不能当作当前值。

当时 archive failed 为 4：上海新闻的 `demtshefel76nu67qjjkx6f4w`、`geymfy2r7e9pfmwzijynqnbvs` 为预筛 HTTP 403，各 processing_attempts 1；`i2atpn3gr76rsxn9ygzy04ayq` 为明确写作输出错误，processing_attempts 4；`teprj3rylduwi28c87bh1bvlo` 为明确写作输出错误，processing_attempts 3，写作回执 84995 的历史 attempts 已到 22。它们当时不属于 unknown28。本次未重新读取 failed4 的最新回执，不把该早期故障计数作为现时恢复资格。
