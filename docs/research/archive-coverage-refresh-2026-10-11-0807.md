# 2026-10-11 08:07 生产档案覆盖与闭合条件刷新

观测时间为北京时间 08:07:19—08:07:41，UTC 2026-10-11T00:07:19Z—00:07:41Z。使用既有 `.round11/remote.ps1`，数据库查询在 READ ONLY 事务内执行。没有改变生产、预算、回执、来源、队列或 timer，没有另起采集 CLI/worker，没有打印凭据或模型回答。原始无密钥计数保存在本轮私有目录 `.round11/archive-coverage-20261011-refresh.log` 与 `archive-coverage-20261011-boundaries.log`；只读查询脚本为 `.round11/coverage-readonly-20261011.sh`。

## 真正完成的分析与新到资料

档案 `backfill_reason='archive'` 当前共有 7,338 条：analyzed 188、blocked 207、failed 4、new 6,939。相对本任务 07:33 快照（185/207/2/6883），净变化分别为 +3、0、+2、+56，总资料 +61。这些是两个快照的净差，不是逐条新增执行事件计数；新增资料持续到达，不能仅以 new 增减评价处理速度。

单独匹配文章当前 revision、origin=model 的最新 analyses，以免把状态 analyzed 或历史回放误算成真正通过：

| 当前真实模型结论 | 文章数 | 其中 selected | 最近一小时产生的当前结论 | 自 07:33 产生的当前结论 |
|---|---:|---:|---:|---:|
| pass | 160 | 26 | 1 | 1 |
| block | 207 | 0 | 0 | 0 |
| unknown | 28 | 0 | 2 | 2 |

unknown 不等于通过、selected 不等于已入历史报刊。当前 new/archive 中 retry 已到期 6,859，未来退避 80。存在大量可尝试资料，但未读取 provider 账户状态，因此不把 due 数视为可立即付费调用容量，也不从一分钟/一小时样本推算完成日期。

## 月度资料与刊物闭合

下面 materials/unsettled/selected 包含全部 backfill 类型与实时资料，而 archive 一列仅为主动历史回填；这是刊物实际候选区间的完整闸门口径。

| 月份 | 全部资料 | archive | unsettled | failed | 公开 selected |
|---|---:|---:|---:|---:|---:|
| 2026-01 | 910 | 761 | 729 | 2 | 26 |
| 2026-02 | 898 | 708 | 790 | 1 | 1 |
| 2026-03 | 1,048 | 848 | 898 | 1 | 6 |
| 2026-04 | 986 | 788 | 846 | 0 | 4 |
| 2026-05 | 962 | 744 | 793 | 0 | 4 |
| 2026-06 | 1,146 | 805 | 956 | 1 | 7 |
| 2026-07 | 1,277 | 889 | 1,013 | 2 | 11 |
| 2026-08 | 1,349 | 782 | 993 | 2 | 28 |
| 2026-09 | 3,097 | 769 | 1,316 | 5 | 156 |
| 2026-10 | 12,039 | 244 | 1,543 | 17 | 313 |

2026-01-01—2026-10-10 共 283 个有材料日期，逐日查询没有任何一天满足 unsettled=0。故本次没有能作为最终历史出版闭合的日期、完整周或完整月。网站已有 reports 为日报 17 行（09-25 至 10-11）、周报 2 行（W39/W40）、月报 1 行（09 月）；这是持久刊期行数，不是本次重新验收过的最终报刊数。资料新增和补判仍会改变版面，最终需要 settled 后正序 refresh。

## 期刊 source/month 切片

当前账本 done 593、pending 335、running 1，共 929 行。相对 07:33 的 done 585 增加 8，说明后台采集继续推进。94 条具有期刊档案入口的 enabled 来源 × 10 个月应有 940 个潜在切片，其中 11 个 1 月切片尚无账本，不能当空月处理。

| 月份 | done | pending | running | 未建立账本 |
|---|---:|---:|---:|---:|
| 01 | 68 | 14 | 1 | 11 |
| 02 | 65 | 29 | 0 | 0 |
| 03 | 67 | 27 | 0 | 0 |
| 04 | 59 | 35 | 0 | 0 |
| 05 | 55 | 39 | 0 | 0 |
| 06 | 59 | 35 | 0 | 0 |
| 07 | 65 | 29 | 0 | 0 |
| 08 | 72 | 22 | 0 | 0 |
| 09 | 66 | 28 | 0 | 0 |
| 10 | 17 | 77 | 0 | 0 |

10 月仍是开放月份，selector 会重新纳入当月，包括旧版本遗留 done；这 17 行不能解释成 10 月已经闭合。仅已过去的 1—9 月为 576/846 个 done；仍有 270 个未完、旧 running 或尚未建立账本的切片。

缺失的 1 月来源：`rss-james-toc`、`rss-nature-food`、`rss-nature-geoscience`、`rss-pass-toc`、`rss-pensoft-bdj`、`rss-pensoft-natureconservation`、`rss-phg-toc`、`rss-plos-climate`、`rss-plos-ecosystems`、`rss-radio-science-toc`、`rss-sci-reports-geoscience`。

`rss-ijgis-toc` 的 2026-01 running 最后更新为 2026-10-09T17:52:23Z，已约 30.3 小时未更新，属于中断留下的状态标记，不能宣称它一直在工作。原工作流会把非 done 切片纳入后续轮转；本次没有修改它的状态或另起进程。

未完数最多的来源：GRL、Nature Communications、Humanities and Social Sciences Communications 各 10；Scientific Reports 9；Frontiers Marine Science 8；Frontiers Environmental Science 7；多个 Copernicus、Frontiers、Wiley 来源为 6。pending 中 265 行有 cursor、47 行 note 含 cut、74 行 note 记录非零 no-date；这些原因可重叠，不能相加为互斥故障总量。摘要不足和未知日期属于资料资格缺口，done 也不等于每篇论文均进入模型。

## 新闻分页边界和范围

长期批次继续固定 2026-01-01—2026-10-10，10 月 11 日单独增量观察，没有直接改变旧 checkpoint 的范围键。

| 来源 | 长期 completed 页 | 真实旧日期边界 |
|---|---:|---|
| WMO | 18 | page=17 |
| 国家数据局 | 11 | index_pc_11.html |
| 上海市政府 | 143 | index_143.html |
| 广州市政府 | 13 | index_13.html |
| 上海统计 | 5 | index_5.html |
| UNFPA | 5 | page=4 |
| IOM | 10 | page=9 |
| ADB | 13 | page=12 |
| ECLAC | 3 | page=2 |

九个分页来源都已有保存且重观测的 older-boundary，最新 ECLAC 边界为 08:01:24。ITDP 另以 1/1—10/11 键记录 feed paged=6 边界。LOC 为 9 个 closed 月 completed，开放 10 月保持可观察；此前月页/年页逐 URL 核验的 38 篇证据见原报告，本次仅复核 state，没有重新抓取其原文。

10 月 11 日增量键已有各分页来源当天的首次旧日期边界，表示该次观察时尚未发现窗口内新增或已走到边界；当天未结束，需要继续观察，不能标成当天最终完整。state.partial 为 0。没有发现某个已登记新闻分页来源仍缺长期 older-boundary；LOC 采用月首页资格证据，不伪装成分页 older-boundary。

## 夜间周期是否卡住与下一项工作

最近完成周期 `/opt/geohot/app/.data/archive-cycle/20261011T000042Z-986853` 于 08:01:25 完成，result exit=0，status/select、六个 collect、papers、news 与 status-after 全部退出 0。最近一小时至少 22 个切片有更新，涉及 Space Weather、Tectonics、Transactions in GIS、Water Resources Research、ScienceNews Earth、Terra Nova。采集没有整体卡死；单一旧 running 切片不能替代整条流水线的状态。

systemd 实查 api、web、worker、brain 四常驻服务 active/running，archive.timer active/waiting；archive.service inactive/dead 是最近 oneshot 完成后的正常形态。没有独立 geohot-mcp 单元，不能用该不存在的单元判断站点服务故障。

下一项最具体瓶颈是当前 revision 的完整模型成稿：最近一小时 archive 只有 1 个真实 pass，另 2 个 unknown，远低于资料到达速度。先评估本轮预算短退避与拒收传播修复上线后的完整一小时真 pass/block/unknown 和 due 数变化，结合原回执审计定位 unknown；保持既有预算、双评分和 live 优先，不能用加预算、再加 worker 或直接 force 出刊制造完成。

采集端下一项有限行动是让原 timer 同锁轮转继续覆盖上述 11 个缺失 1 月切片和 `rss-ijgis-toc` 旧 running；如需要人为定向，应由根任务在原 cycle 的来源过滤器中安排一次 bounded 批次，仍使用原状态与锁、原预算。无需对已到新闻旧日期边界的来源扩大并发。未来覆盖结论仍需区分：来源列表读取边界、日期/摘要资格、模型最终结论、公开投影和最终刊物各自的完成状态。
