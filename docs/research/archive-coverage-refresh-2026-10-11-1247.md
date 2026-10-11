# 2026-10-11 12:47 档案覆盖、实际筛选与出刊闭合复核

观测为北京时间 12:47:43—12:48:19（UTC 04:47:43—04:48:19）。仅用既有 `.round11/remote.ps1` 读取生产安全元数据，查询在 READ ONLY 事务内；未读取原文/模型回答/凭据，未重排任务，未改生产配置、预算、worker 或 timer。按用户最新门禁，本轮仅产出本地报告，不上传、不部署、不 push、不生成备份或进行迁移演练。

原始计数为本轮私有目录 `.round11/archive-coverage-20261011-later.log` 与 `.round11/archive-pilots-20261011-later.log`，只读查询脚本为 `.round11/coverage-readonly-20261011-later.sh`。两组查询时间不同，不把它们当成同一事务快照。

## 入口扩充与终态吞吐分开计算

生产 registered 311、enabled 289，其中具有已登记历史入口的 enabled 来源 105，新闻适配器 11。仍有 **176 个 enabled/editorial 来源没有当前已支持的历史入口**。因此能证明当前已支持范围的持续采集，不能声称全部来源从 1 月起都已被历史检索。

这 176 是当前支持能力的覆盖边界，不据此承诺无限追加来源或覆盖全互联网；优先闭合已验证支持的 105 个入口，再把仍不支持的来源与原因如实列入交付边界。

档案统计固定 `articles.backfill_reason='archive'`，不追加日期限制或其它 backfill 条件；真正模型结论固定 origin=model、input_revision=文章当前 revision，按 article_id 取最新 analysis。

| 全档案状态 | 08:07 | 12:47 | 净差 |
|---|---:|---:|---:|
| 全部资料 | 7,338 | 7,667 | +329 |
| new | 6,939 | 7,116 | +177 |
| analyzed | 188 | 333 | +145 |
| blocked | 207 | 214 | +7 |
| failed | 4 | 4 | 0 |
| 真模型 pass | 160 | 271 | +111 |
| 真模型 block | 207 | 214 | +7 |
| 真模型 unknown | 28 | 62 | +34 |
| 真模型 selected | 26 | 48 | +22 |

资料输入增长仍超过明确 pass/block 的增长，new 增加不等于流水线停止。08:07 后新增档案主要来自 Frontiers Marine Science 73、Copernicus TC 59、BG 48、GMD/ACP 各 32，再是 Sustainable Cities/DHG 各 16 等；这是期刊来源持续扩采，不是新闻来源旧列表重复导入。

最近一小时产生的当前结论为 pass 22、block 0、unknown 7。创建时间 >=08:07 的当前结论分别为 pass 97、block 7、unknown 35；该创建窗口计数与两个快照净差不是同一种度量（期间有恢复、版本和状态变化），不能互相替换为真实执行事件数。unknown 不能加到 pass，也不能把 selected 直接计为已出版。

## 逐月采集切片和筛选

切片当前 done 655、pending 274、running 0，共 929，较 08:07 done 增加 62；之前旧 running 已消失。开放十月仍要继续观测，遗留 done 不表示十月已闭合。

| 月份 | 切片 done/pending | archive 材料 | new | failed | 真模型 pass/block/unknown |
|---|---|---:|---:|---:|---|
| 01 | 75 / 8 | 786 | 621 | 2 | 120 / 21 / 22 |
| 02 | 74 / 20 | 744 | 651 | 0 | 53 / 12 / 28 |
| 03 | 75 / 19 | 881 | 836 | 0 | 7 / 34 / 4 |
| 04 | 70 / 24 | 847 | 821 | 0 | 11 / 14 / 1 |
| 05 | 65 / 29 | 804 | 758 | 0 | 17 / 27 / 2 |
| 06 | 69 / 25 | 827 | 795 | 1 | 7 / 20 / 4 |
| 07 | 69 / 25 | 937 | 891 | 1 | 17 / 28 / 0 |
| 08 | 76 / 18 | 786 | 752 | 0 | 16 / 18 / 0 |
| 09 | 70 / 24 | 786 | 737 | 0 | 9 / 39 / 1 |
| 10 | 12 / 82 | 269 | 254 | 0 | 14 / 1 / 0 |

按既有 94 条期刊历史入口口径，1 月账本仍只有 83 条；11 个潜在切片无账本，不当作空月。1—9 月 done 共 643/846，尚有 203 个未闭合或无账本切片。切片 done 是列表/摘要资格处理的边界证据，摘要不足、日期不足被排除后仍需明确报告，不能用 done 代表完整论文语料覆盖。

## IJGIS 一月恢复结果

`rss-ijgis-toc` 2026-01 的原始 updated_at 明确为 `2026-10-11T04:24:16.738Z`，换算北京时间 UTC+8 为 12:24:16.738，更新为 done：seen 16、items 0、cursor NULL、note=`no-date=0 thin=16 dup=0`。这证明本次走到可关闭的读取边界，但 16 条摘要都不足以送入原筛选，不等于新增了 16 篇可判正文。

原数据库的四条一月资料仍保留，当前为 analyzed 2、new 2。本次没删记录、改时间轴或重跑它们；旧 running 不再是进度阻碍。摘要资格不足是另一层覆盖边界，不应通过随意填充摘要或伪造分数跨过。

## new、failed 和 unknown 的实际集中处

archive/new 最多的是上海市政府 2,674，占 archive/new 约 37.6%；随后 GRL 214、Frontiers Marine Science 209、广州市政府 160、地球信息科学 150、地理研究 149、地理学报 145、资源科学 144、IOM 143、Nature Communications 142、自然资源学报 140、Palgrave HSS 130、热带地理 125、Copernicus TC 123、Scientific Reports 112。各来源均有从一月或二月开始尚未判定的材料，不能只以近期新增资料为处理目标。

62 条 archive/current-model unknown 分布于 24 源，一月 22、二月 28、三月 4、四月 1、五月 2、六月 4、九月 1。数量较多的来源是 Frontiers Climate 7（01-05—02-12）、Copernicus GH 6（01-06—02-10）、AMT 5（01-05—02-09），自然资源学报、地球信息科学、Frontiers Earth Science 各 4，其余多数 1—3。该分布用于按已有分析/回执定位，不凭来源或分数猜测原回答拒收原因；详细原因由另一只读智能体独立审查。

failed 4 条所在源与日期为：上海市政府 06-27、07-17 各 1；Copernicus WES 01-07 一条；Frontiers Remote Sensing 01-06 一条。unknown 与 failed 的恢复要保留 receipt 未知结局边界，不能批量删回执、修改 revision 或 attemptTag 制造新付费身份。

## 五条 writing pilot 的独立核验

以下原任务指定 pilot 本次只读，没有重排。全部 current revision=1、最新 analysis input_revision=1、origin=model、relevance=pass、selected=false、processing_state=analyzed、processing_attempts=0、processing_retry_at=NULL。

| ID | 最新分析北京时间 |
|---|---|
| fq31u0c21se2ghpix1k9gftm9 | 12:43:02 |
| iagvywyl3x5qnvruxofd7o8gr | 12:36:04 |
| z25i0c5z37uiqbd2ccmsxjlix | 12:36:01 |
| ab9zo72g1tpwuflm9ixkgz0k7 | 12:42:29 |
| ai2u234gjuk6rp2n9larn1lx0 | 12:42:16 |

它们说明这五条经过正常既有流程已成为 pass，并未人工入选；nonselected 不等于公开精选。即便存在 all 素材投影也不能单独证明读者可读，本次未读取模型回答，也未完整检查正文真实性与读者投影，因此不能用五条 pilot 推广为全部 writing 故障解决。

## 三类报刊仍未最终完成的条件

2026-01-01—2026-10-10 全材料闸门仍有 new 9,395，较 08:09 的 9,756 减少 361；analyzed 无 publication 为 0，failed 44。283 个有材料日仍没有任何一天满足原 unsettled=0 条件。没有投影 repair 缺口；主要是 new 未判完，unknown/failed 是另需质量处理的终态边界。

reports 仍为日报 17（09-25 至 10-11）、周报 2（W39/W40）、月报 1（09 月）。这些持久刊期不能替代一月至今最终报刊覆盖。尚未关闭的十月和当前周不能提前作为最终整期出版；日报依实际 dailyWindow 在当日北京时间 08:00 截止，不能仅因“当天仍有新资料”就把已经截止的日报窗口当作未到出刊时间。各窗口仍须通过原 settled 闸门。

可继续的既有路径是：现有同锁限额采集逐步穷尽已登记来源切片；worker 按现有预算、回执、双评分完成 new，逐条验证 unknown/failed 的可恢复性；来源覆盖稳定且历史日期 settled 后，通过原 backfill-papers 正序计划和刷新流程分别完成日报、完整周报、完整月报。不能降低门槛、移动 timeline、伪造 pass、force 成刊或以零候选代替已检查。

用户当前门禁仍生效：以上是流程路径而非本次生产执行授权，本 agent 没有执行任何重新入队或采集写入。内容、刊物、移动端与最终 QA 全部完成前，不进行上传、部署、GitHub push、服务器配置调整、备份或迁移演练。最终工作必须分别证明入口检索、材料日期与正文资格、真实模型结论、公开投影、刊物版面和网站交互，任何一项未闭合都保持未完成。
