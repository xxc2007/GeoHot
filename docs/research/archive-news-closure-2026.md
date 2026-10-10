# 历史新闻列表观察闭环：2026-01-01 至 2026-10-10

2026-10-10 22:58 CST，生产脚本在共享 archive-cycle 锁内逐源执行，复用已有私有断点。每个 CLI 最多 200 页、1000 条 eligible、600 秒，上海三轮顺序执行。没有增开 worker、改变预算或评分标准；列表只提供真实原文 URL、标题和发布日期，仍交给正文抽取及既有分析流程。

9 个分页来源均实际读到非空、全条目有日期且早于 2026-01-01 的列表页。不是空列表、HTTP 200 或已导入数推断的完成。LOC 的 2026 年 1—10 月首页另行观察，保留月内分页适配限制。

| 来源 | 本次观察的旧日期边界 | 数据库范围内材料数 |
| --- | --- | ---: |
| WMO | `news?page=17` | 79 |
| 国家数据局 | `index_pc_11.html` | 83 |
| 上海市政府 | `nw4411/index_143.html` | 2822 |
| 广州市政府 | `zwlb/index_13.html` | 175 |
| 上海市统计局 | `sjxx/index_5.html` | 75 |
| UNFPA | `news?page=4` | 41 |
| IOM | `news?page=9` | 161 |
| ADB | `news/releases?page=12` | 117 |
| ECLAC | `list/cepal_pr?page=2` | 27 |
| LOC Worlds Revealed | 1—10 月档案首页，未声明更深分页 | 38 |

材料数来自生产数据库按 source_id 和北京时间 timeline_at 范围统计，包含此前已存在资料，不是本轮新建数。合计 3618 条，不能相加到其他批次的导入数而制造增量。这轮补足官方列表断点时仅新建 1 条 ECLAC 材料；其他记录通过 canonical 身份去重，已完成/拒绝的记录没有启动新分析。

观察时 checkpoint 为 221 个 completed、0 个 partial、9 个日期边界。completed 是列表传输确认，不能替代内容筛选。该十源中仍有大量 `new` 材料：仅上海还有 2704 条未判，另有 3 条 failed；不能称为全部正文、精选、日/周/月历史出刊完成。

为避免长程处理跨午夜后改变日期键、重复扫描整个年份，生产历史目标已明确固定为本次请求日期 `2026-01-01..2026-10-10`；常规实时采集继续运行。最终验收若跨到下一日期，应单独扩展目标并补做新增时间段及出刊检查，不能把这个快照冒称届时的“到现在”。期刊回溯与未适配来源的覆盖另有台账，此处不声称全站全部信源已完成历史回溯。

私有证据位于本轮过程目录的 `news-boundary-production.log`、`news-expanded-checkpoints.log`、`news-shanghai-completion.log`、`news-coverage-authoritative.json`；服务器保留 `.data/archive-cycle/news-coverage-20261010.json` 和逐来源日志。边界会在重跑时重新观察，防止新增文章挤动分页后漏掉范围内条目。
