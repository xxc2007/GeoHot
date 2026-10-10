# LOC Worlds Revealed：2026 档案分页独立核验

核验日期：2026-10-10（Asia/Shanghai）。范围为 2026-01-01 至本次核验时的官方公开归档。本次只读本地规则和官方 HTML，没有修改代码、生产数据库或队列，没有启动模型，没有把列表摘要作为正文导入。

## 结论

**没有发现本次 38 条存在月内分页遗漏。** 官方 2026 年 1—10 月各月归档首页分别列出 4、3、4、5、4、4、3、5、4、2 篇，页面实际 article 数均与官方 Archive 报头的 Posts 数一致，每月未找到下一页/编号分页入口；唯一文章 URL 合计 38。

官方**年度**归档确实分页。进一步独立读取年度五页，实际文章数为 9、9、9、9、2，去重同为 38，按月份分布与月页一致，逐条 URL 与月页结果相符。最早日期为 2026-01-08，最新为 2026-10-06。月页和年度全分页两个独立入口的数量、日期、URL 对照支持“本次官方公开列表内的 38 篇已全部枚举”；不是基于 HTTP 200 或空第二页认定完成。

该结论只证明官方当前可见归档的枚举覆盖，不能证明 GEOHOT 已成功抽取这 38 篇正文、完成筛选或已公开发布；也不证明未来月内出现更多文章时当前 adapter 仍完整。

## 本地规则及边界

`industry/news-archives.json` 中 `intl-loc-worlds-revealed` 使用 `mode: months` 与 `https://blogs.loc.gov/maps/{month}/`，article selector 为 `article:has(h2 a[rel='bookmark'])`，标题链接 selector 为 `h2 a[rel='bookmark']`，日期取 `time`。URL 前缀允许 maps，排除 category/author 路径。`industry/sources.json` 的常规采集仍为官方 RSS，archive rule 在历史回补时转换为 web_list。

`scripts/backfill-news.ts:50-59` 的 `pages()` 对 months 只为每月生成一个 URL，没有月内 pagination 发现/跟随。`run()` 的停止、边界证据及重复页保护主要针对 pages 模式，months 模式没有比较官方 advertised total 与实际解析数量。因此实现存在未来覆盖验证能力的边界，但当前月份各有 2—5 篇，低于官网当前年度每页 9 条的页面容量；本次没有实证遗漏，也没有依据立即把 months rule 改成年分页以重复采集同样的 38 篇。

## 实际月页证据

使用与 adapter 完全一致的 article/link selector，逐月读取官方原站 HTML，检查报头、文章 URL、time datetime 和所有月路径的 pagination 链接。

| 月份与官方归档 URL | 官方 Posts | selector 实际条数 | 实际发表日期（日） | 月内分页入口 |
|---|---:|---:|---|---|
| [2026-01](https://blogs.loc.gov/maps/2026/01/) | 4 | 4 | 08、16、22、27 | 未发现 |
| [2026-02](https://blogs.loc.gov/maps/2026/02/) | 3 | 3 | 03、13、20 | 未发现 |
| [2026-03](https://blogs.loc.gov/maps/2026/03/) | 4 | 4 | 02、13、19、27 | 未发现 |
| [2026-04](https://blogs.loc.gov/maps/2026/04/) | 5 | 5 | 03、09、17、24、29 | 未发现 |
| [2026-05](https://blogs.loc.gov/maps/2026/05/) | 4 | 4 | 08、12、21、29 | 未发现 |
| [2026-06](https://blogs.loc.gov/maps/2026/06/) | 4 | 4 | 02、12、18、30 | 未发现 |
| [2026-07](https://blogs.loc.gov/maps/2026/07/) | 3 | 3 | 10、17、23 | 未发现 |
| [2026-08](https://blogs.loc.gov/maps/2026/08/) | 5 | 5 | 04、06、13、20、26 | 未发现 |
| [2026-09](https://blogs.loc.gov/maps/2026/09/) | 4 | 4 | 08、10、17、24 | 未发现 |
| [2026-10](https://blogs.loc.gov/maps/2026/10/) | 2 | 2 | 01、06 | 未发现 |

十个月均有有效日期，均在指定范围内，全部 URL 去重为 38。当前十月仍是开放月份，应依现有 openListing 机制重新观察，不能因为这次只有两篇就永久封存。

## 年度分页交叉证据

年度首页的官方真实链接提供 page/2、page/3、page/5 等页码；从第二页获得 page/4 链接。五页均有有效正文列表，最后一页只列两篇且没有下一页链接。

| 官方年度 URL | 实际条数 | 本页日期范围 |
|---|---:|---|
| [年度首页](https://blogs.loc.gov/maps/2026/) | 9 | 2026-08-13—2026-10-06 |
| [年度第 2 页](https://blogs.loc.gov/maps/2026/page/2/) | 9 | 2026-06-02—2026-08-06 |
| [年度第 3 页](https://blogs.loc.gov/maps/2026/page/3/) | 9 | 2026-04-03—2026-05-29 |
| [年度第 4 页](https://blogs.loc.gov/maps/2026/page/4/) | 9 | 2026-01-22—2026-03-27 |
| [年度第 5 页](https://blogs.loc.gov/maps/2026/page/5/) | 2 | 2026-01-08—2026-01-16 |

终页两篇的实际原文地址分别为 [2026-01-16 的道路测绘文章](https://blogs.loc.gov/maps/2026/01/an-18th-century-survey-of-the-roads-of-the-united-states-of-america/) 与 [2026-01-08 的年度扫描地图回顾](https://blogs.loc.gov/maps/2026/01/a-year-in-review-newly-scanned-maps-of-2025/)。两者均已出现在一月月页中，不能把年度深页误判为月模式漏收的新候选。

辅助请求 `https://blogs.loc.gov/maps/2026/04/page/2/` 和 `https://blogs.loc.gov/maps/2026/04/?paged=2` 均返回 404，页面标题是 Page Not Found。这仅说明这两个猜测入口不是有效的本次第二页，**不作为完整覆盖的证据**。

Web 阅读工具访问年度首页曾遇 403；直接原站公开 HTML fetch 随后能够正常读取。该工具单次失败不等于原站不存在，最终结论依据实际 HTML 的报头、分页、日期与 URL 内容，而非状态码。

## 有依据的最小改进建议

本次无需为了所谓“38 条月内漏页”增加采集、模型请求或修改生产状态。若下一轮需要让适配器显式证明枚举完整，可以最小增加：

1. 对 LOC 月页提取官方 Archive 报头总量，记录 actual parsed unique count 与 advertised count；二者不等时标记 limited/coverage unknown，不让完成 checkpoint 掩盖范围缺口。
2. 发现同一个官方月路径的下一页时，用 allowlisted same-origin、same-month 链接按既有 max-pages/max-items 限制跟随；保留重复内容页检测、日期范围过滤和逐条 checkpoint。不要从年度/导航页链接误跨到其它月份。
3. 加入两页月份夹具、advertised total 不匹配、next 链接重复、next 404、跨月 next 被拒、未定日期继续待查的测试。404/空页只有在已有有效的总量/终页证据配合时才允许判终结，否则保持 unknown。

这是防止未来网站变化的覆盖验证增强，不是本次已有内容遗漏的修复。当前 2026 官方列表枚举与 38 条回补数量一致；各条是否入库/筛选/出刊应由独立 pipeline ledger 验证。
