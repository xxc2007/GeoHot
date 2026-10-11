# 2026-10-11 12:55 期刊 pending、缺失一月切片与轮转诊断

生产 READ ONLY 观测北京时间 12:55:24—12:57:13（UTC 04:55:24Z—04:57:13Z）。仅查询切片/信源安全元数据和读取私有周期账本，从日志中提取 HTTP 数字、错误类别与退出码，不打印原始错误、正文、模型回答或凭据。未改变服务器、切片、回执、预算、来源、锁或队列，未采集 apply、付费 probe、重排、上传、部署、push、备份或迁移演练；仅写本文档。

私有证据为 `.round11/pending-diagnostic-20261011.log`、`.round11/missing-slice-ordinal-20261011.log`；查询脚本为 `.round11/pending-diagnostic-readonly-20261011.sh`。本报告不取代 12:47 的筛选吞吐和出版闸门报告。

## 274 个 pending 不能全部算故障

| 条件 | 个数 | 本次能确认的含义 |
|---|---:|---|
| 2026-10 开放月份 | 82 | 正常保留可重扫，月份还未结束 |
| 2026-01—09 closed 月份 | 192 | 尚未证明取到完整读取边界 |
| closed 且有 cursor | 191 | 有可续读位置，不能仅凭 cursor 判正常或错误 |
| closed 且无 cursor | 1 | 热带地理 06 月站点门，见下文 |
| closed note 含 cut | 49 | 已有本轮上限/页数限制证据，按旧 workflow 续跑 |
| closed note 非零 no-date | 53 | 有未知整日期材料，但不是唯一 pending 原因 |
| closed note 非零 thin | 90 | 有摘要资格不足材料，仍需区分分页是否结束 |
| closed thin>0 且 items=0 | 27 | 本轮零可入库摘要，不等于空期刊或 HTTP 失败 |
| closed updated_at 已超过 24 小时 | 143 | 长时间未重观测，不能称一直运行 |

后五项互相重叠，不能加起来成为互斥分类。全部月份 note 含 cut 为 51、非零 no-date 为 61、非零 thin 为 107、thin 且 items=0 为 40；其中部分是开放十月。所有 pending 当前仍为 274，done 655，无 running。

最老 pending 是 `rss-copernicus-bg` 2026-01，updated_at=2026-10-09T17:50:37.309Z，距快照约 35 小时；接着 HESS 一月、ESS 一月等。它们有 cursor。采集 ledger 的 seen/items 是本次页级值、note 记录该轮跳过数，不能用 thin/seen 当最终月度资格比例；旧 note 和 cursor 年龄也不能单独证明 cursor 已失效。

Nature Communications、Palgrave HSS、GRL 各有九个过去月份 pending，Scientific Reports 八个；不少含 cut，符合大刊按限额分批续读，不能在无终页证据时强制关闭。摘要不足本身也不会令 Crossref 切片永远 pending：例如 IJGIS 一月 16 条 thin，正常读到尾页后已经 done。若条目无日期/摘要则不会送入原分析，done 的覆盖结论必须保留这一资格边界。

## 站点门唯一过去月份 pending

`web-rddl-toc` 2026-06：cursor=NULL、seen=0、items=0、note=`issues=1 dup=0 fixed=0 no-date=0`，最后更新 2026-10-10T04:37:35.100Z。按现有控制逻辑，在 closed/no-date0/no-cut/no-ahead 时仍 pending，意味着当轮读索引或期次发生 failed 标志；但 note 没有持久保留失败类别。

有限扫描 2026-10-10/11 的 78 个周期目录，没有找到这个来源月份对应的 slices.json/collect phase。因此本次不能定位其当时是 HTTP、空匹配、网络还是页面选择器问题，不能称已复现 source adapter 缺陷；需要该片下一次原工作流重观测的私有日志或原有采集证据。开放十月另外七个站点门 pending 是正常当前月，地球信息科学与自然资源学报还明确记 ahead，刊期未到不能提前入库。

## 缺 11 个一月切片仍符合 selector

这 11 源全部当前 enabled=true、participation_mode=editorial、kind=rss，具有非空 ISSN，不是因为被禁用或没有档案入口而消失。它们在其它月份有账本；无一月账本只表示尚未建立该片观察，不能据此断言一月无论文或源失效。

| 来源 | ISSN | 12:57 当前 eligible 中一月序号（从 0 起） |
|---|---|---:|
| rss-james-toc | 1942-2466 | 133 |
| rss-nature-food | 2662-1355 | 164 |
| rss-nature-geoscience | 1752-0894 | 169 |
| rss-pass-toc | 2637-6989 | 218 |
| rss-pensoft-bdj | 1314-2836 | 220 |
| rss-pensoft-natureconservation | 1314-6947 | 225 |
| rss-phg-toc | 0309-1325 | 230 |
| rss-plos-climate | 2767-3200 | 233 |
| rss-plos-ecosystems | 3070-8141 | 238 |
| rss-radio-science-toc | 0048-6604 | 248 |
| rss-sci-reports-geoscience | 2045-2322 | 254 |

当前 eligible 共 297：274 pending +11 missing +12 个开放十月遗留 done。next-slice=105，以上 11 月片都在该次指针后方，没有证据表明正常选择器把它们排除；不能据此保证未来几轮的固定到达时刻，因为已完成切片会改变数组长度与位置。

## 近期轮转和共享锁

读取最近 12 个完成周期，UTC 02:00:15—04:46:42（北京时间 10:00—12:46），共 72 个 collect phase。各周期 result exit=0，collect 日志未匹配 Crossref HTTP 错误、transport failure、invalid JSON 或站点读不到类别。这证明这个有限窗口内这些被选片没有记录上述失败，不证明所有 274 个 pending 都未遇过错误。

eligible 从 344 逐轮降到 302，start/next 从 33/39 推到 99/105；本轮随后快照为 297。来源依次从 Copernicus、Frontiers 前进到 GBC/GCB，正常有限轮转正在执行。archive.timer active、archive.service inactive 是完成后正常等待形态；lslocks 快照没有活跃 cycle.lock，不能把未持锁的空闲时段误判锁失效。现有周期代码明确在任何写入阶段之前用固定 `.data/archive-cycle/cycle.lock` 的 flock -n，未创建第二个锁或独立工作流。

## 已有证据支持的本地缺陷风险与 owner 边界

本轮仅提出草案，不修改代码，避免与 root 正在执行的全套测试冲突。

1. **数值索引对应会持续缩水的 eligible 数组，没有严格公平保证。** Owner 为 `deploy/geohot/archive-cycle.sh` 的 selector。代码每轮过滤 done 后按旧数字 cursor 模运算，示例 `[A,B,C,D,E,F]` 选 A/B 后 cursor=2；若 A/B 完成移除，下一轮 `[C,D,E,F]` 的 index=2 指到 E/F，C/D 被跳过直到后续回绕。实际窗口既有数组缩水又有指针递增，证明这种条件存在；本次未证明某片会永久饥饿。最小草案是持久化最后选中的 source/month 稳定键，按字典顺序找严格后继、末尾回绕，或将 oldest_updated/missing 作为有限补位；需覆盖 done 消失、新源加入、失败片和当月重开，不提高轮次/配额、不新增 worker。现阶段按原 timer 继续观察或将缺片列入根任务计划，不执行定向 apply。
2. **错误原因不入 ledger，正常进程 exit=0 不能证明每片成功。** Owner 为 `scripts/backfill-archive.ts` 的 page/siteSlice 收尾，影响诊断而不是 false done：HTTP/解析失败保持 pending，但最终 note 只写 no-date/thin/dup，site 也未记 failed。最小草案是仅记录脱敏的 `last_error_kind`/HTTP 数字/观测时间到 note 或增量列，保留 cursor/status，不存 URL 参数、原始错误、连接字符串或响应正文；之后 status 检查能独立识别失败。待根任务确定 owner 再编码，不能根据缺少错误 note 自动重置 cursor。

目前没有实际证据支持修改某刊的 CSS/date selector；尤其热带地理六月须先取得当前错误类别。不能凭 thin/no-date 非零就放宽日期精度或摘要资格。也不能按旧“cursor 五分钟过期”口径批量清游标：[Crossref 2026 年 8 月升级说明](https://community.crossref.org/t/changes-to-cursors-filtering-and-sorting-in-the-rest-api/16246)称新 cursor 不再过期，而 [Swagger 首页](https://api.crossref.org/)仍保留旧五分钟说明。官方材料有更新差异，本轮最近日志没有 HTTP cursor 拒绝证据，因此年龄不是有效恢复依据；须对实际错误作判定，不能把所有非 200 当失效游标重扫。

数字指针风险不是必须现在重写或中途部署的理由；当前来源/月范围固定，开放月份继续参与回绕，永久 starvation 尚未证实。143 个旧 updated_at 仅是观测时间边界，不作为 143 个 error。缺失一月切片已证符合 selector、位于当前推进位置之后；热带地理六月等待下一次既有轮转重观测，本 agent 不自行 apply。

剩余工作仍应优先闭合已有支持入口、完成真实筛选和出版质量，再遵守用户最终内容/刊物/移动端/QA 门禁统一发布。以上分类是当前有限证据的诊断，不能用 pending=0 作为全互联网覆盖或所有材料真模型通过的替代标准。
