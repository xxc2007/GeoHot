# 非论文历史新闻适配扩充与覆盖审计

核验于 2026-10-10。新增 **7 个真实 HTML 历史分页适配**，`industry/news-archives.json` 由 3 条增至 10 条；正式来源仍在 `industry/sources.json` 登记。新增规则仅保留标题、原文 URL 和真实发布日期，列表简介不作为正文投递。未访问生产数据库，未调用模型、付费抓取或写入接口。

本轮完整只读抓取新增七源 **192 页**，解析 3,585 条列表记录，其中 **3,417 条在 2026-01-01—2026-10-10 的来源内唯一候选**。192 页均实际 HTTP 200，记录均解析出日期，没有相邻重复页；每个来源都读到整页在窗口之前的停止边界。这说明这些列表入口可以跨越请求窗口，不等于网站全内容、全国地方政务或最终入选内容完全覆盖。本文数量是列表解析结果，不能称作已入库、已提取正文或已出刊数量。

## 实际分页证据

| 已登记来源 | 实读页数 | 窗口内唯一候选 | 最早窗口内发布日期 | 实读停止页与最晚日期 |
| --- | ---: | ---: | --- | --- |
| [上海市政府 上海要闻](https://www.shanghai.gov.cn/nw4411/index.html) `cn-web-shanghai-news` | 143 | 2,822 | 2026-01-01 | `index_143.html`，2025-12-30 |
| [广州市政府 政务联播](https://www.gz.gov.cn/xw/zwlb/) `cn-web-guangzhou-government` | 13 | 175 | 2026-01-04 | `index_13.html`，2025-12-19 |
| [上海市统计局 数据信息](https://tjj.sh.gov.cn/sjxx/index.html) `cn-web-shanghai-statistics` | 5 | 75 | 2026-01-13 | `index_5.html`，2025-12-16 |
| [UNFPA 新闻](https://www.unfpa.org/news) `web-unfpa-news` | 5 | 41 | 2026-01-09 | `?page=4`，2025-11-21 |
| [IOM 新闻](https://www.iom.int/news) `web-iom-news` | 10 | 161 | 2026-01-08 | `?page=9`，2025-12-18 |
| [ADB 发布](https://www.adb.org/news/releases) `web-adb-news` | 13 | 117 | 2026-01-06 | `?page=12`，2025-12-10 |
| [ECLAC 发布](https://www.cepal.org/en/list/cepal_pr) `web-eclac-news` | 3 | 26 | 2026-02-18 | `?page=2`，2025-10-29 |

三个中文入口的 `index_1.html` 本轮实际均返回 **404**，不能从该模板开始。新增 `firstPageUrl` 使用官方实际首页，后续从 `index_2.html` 起；分页行为测试对此提供回归检查。四个国际 HTML 来源从 `page=0` 起，完全沿用正式来源的 HTML 解析配置，没有新增不受支持的 source config 键。

广州页面声明 20 条/页，项目既有选择器每页实际提取 15 条正式文章路径。本轮候选数量严格按已解析记录计数，不把页面声明数当抓取数，也没有把其它栏目/导航链接混入本栏目；整站及附件覆盖仍须另行审计。

## 月度覆盖与确实存在的空窗

| 来源 | 1月 | 2月 | 3月 | 4月 | 5月 | 6月 | 7月 | 8月 | 9月 | 10月截至10日 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 上海要闻 | 283 | 268 | 342 | 283 | 301 | 301 | 362 | 293 | 303 | 86 |
| 广州政务 | 9 | 11 | 7 | 8 | 9 | 34 | 41 | 23 | 30 | 3 |
| 上海统计 | 9 | 4 | 9 | 9 | 9 | 9 | 8 | 9 | 9 | 0 |
| UNFPA | 3 | 4 | 5 | 8 | 6 | 3 | 4 | 3 | 3 | 2 |
| IOM | 15 | 16 | 24 | 20 | 15 | 17 | 19 | 9 | 21 | 5 |
| ADB | 11 | 10 | 12 | 13 | 19 | 9 | 16 | 9 | 13 | 5 |
| ECLAC | 0 | 1 | 1 | 7 | 4 | 3 | 1 | 5 | 2 | 2 |

ECLAC 一月没有解析到该新闻发布栏目记录；上海数据信息十月截至本次抓取没有新记录。它们是实际列表空窗，不能补造文章或以采集日期填空。观察统计的月份/年份可能早于文章发布日期，回填窗口按文章真实发布日期筛选。

## LOC 和 ITDP 的单独验证

Library of Congress Worlds Revealed 的 2026 年 1—10 月档案首页全部实际读取，分别解析 **4、3、4、5、4、4、3、5、4、2 条**，共 **38 条**，全部有日期；最早为 2026-01-08。十个月首页均未发现指向该月 `/page/` 的 next 或分页导航。本次窗口的小月档案未发现必须再翻页的证据，因此保留已有 months 规则；该结论不是长期保证，将来月内容增多时仍需复查，而不能假称适配器已支持任意月分页。当前输出包含比先前人工挑选的 31 条更多的栏目记录，候选与精选范围须分开。

ITDP 的 [RSS 第一页](https://www.itdp.org/feed/?paged=1) 至 [第五页](https://www.itdp.org/feed/?paged=5) 使用项目 `fetchRss` 实读，各解析 9 条并有原始带时区时间，共 45 条，窗口内 38 条。第 4 页到 2026-01-15，第 5 页含 2026-01-13 至 2025-11-20，已越过一月边界。**未将 RSS 模板直接加入现有 HTML 回填规则**：当前 `backfill-news.ts` 将历史页面交给 web_list 解析器，需要先增加受控 RSS 分派及测试，才能把这 38 条纳入持续新闻回填，不能以空 HTML 解析结果宣称已接通。

北京部门动态先前只验证到约 4 月 23 日，未在本轮增加完整年入口；上海统计公报正式来源停用，也没有借扩充适配器绕开停用状态。一般政务和机构新闻仍须通过网站原有地理预筛、评分、摘要和归组流程。

## 日期精度与复验

中文三个入口及 IOM/ADB/ECLAC 列表日期只有日精度；项目共享日期解析器将纯 ISO 日期存为 UTC 零点，这是归档表示，不能解释成实际零点发稿。中文规则虽声明 +08:00，纯 ISO 日期分支仍按现有共享解析规则；日级窗口换算到北京时间保持同一日期。UNFPA `<time>` 具有原始时区，项目保留其时间；ITDP RSS 同样保留带时区的原始时间。正文事实、附件表格及转载来源没有在本轮全部审读。

```powershell
node scripts/verify-news-archive-expansion.ts --output=../.round11/archive-expanded-full.json
node scripts/verify-news-archive-expansion.ts --quick
node scripts/verify-news-archive-niche.ts
node --test scripts/news-archive-expanded.test.ts
node scripts/backfill-news.ts --sources=cn-web-shanghai-news,cn-web-guangzhou-government,cn-web-shanghai-statistics,web-unfpa-news,web-iom-news,web-adb-news,web-eclac-news --from=2026-01-01 --to=2026-10-10 --max-pages=250 --max-items=5000 --sleep-ms=100
```

两个核验脚本只下载公开原站、调用项目解析器，不加载 `.env`，不连接数据库，也不提供正文。首个脚本允许将完整逐页 HTTP 状态、日期边界、候选数和标题样本写至指定本地证据文件；niche 脚本默认将本次证据写至仓库外本轮私有目录。适配测试 2/2 通过，与主历史采集测试合跑 11/11 通过。主 CLI 上述真实 dry-run 退出码 0，报告 `pages=192, candidates=3585, eligible=3417, undated=0, created=0, revised=0, queued=0, errors=0, limited=false`，与独立逐页核验一致。实际 production 网络、写入、队列、模型筛选及公开网站验证由主工作流另外验收，不能从本机只读核验推出上线完成。
