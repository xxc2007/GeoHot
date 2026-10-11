# 2026 历史候选独立完整性审计

核验日：2026-10-10。审计员：第 12 组内容核验 agent。只读取候选、信源登记、研究报告及入库/分析代码，只写本报告；未改候选、评分夹具、生产数据库或站点内容。

结论：三个文件共 91 条，结构与日期范围校验通过，18 篇官方原文独立抽查未发现实质事实误述。不能据此声明全部 91 篇正文都经过本组核验，也不能声明全年信息完整覆盖。生产双评分前仍应解决部分候选材料不足，以及月份口径区别。

## 全量结构结果

| 文件 | 行数/唯一 URL | bodyText 字符数 最小/平均/最大 | 登记来源 |
| --- | ---: | ---: | --- |
| archive-news-natural-2026.jsonl | 30/30 | 113/124/134 | web-wmo-news |
| archive-news-human-2026.jsonl | 31/31 | 106/283/730 | intl-loc-worlds-revealed |
| archive-news-geotech-2026.jsonl | 30/30 | 82/100/130 | rss-qgis-blog、rss-osm-blog、atom-gdal-releases |

91 行逐行 JSON.parse 成功；kind/sourceId/title/url/publishedAt/bodyText 均非空；所有 sourceId 均存在于当场读取的 industry/sources.json；URL 均为 HTTPS，全文件集合没有 URL 重复。全部日期可解析且处于 2026-01-01 至 2026-10-10。未发现顶层 score/scores/analysis/selected/decision/fixture 强制判断字段。natural 的 raw.archive.fixture=false 表明候选用途，不是人工评分夹具。三个研究报告的候选计数与文件一致。

| 月份（原始 publishedAt 字符串月份） | 自然 | 历史人文 | 地信 |
| --- | ---: | ---: | ---: |
| 01 | 3 | 3 | 1 |
| 02 | 3 | 2 | 3 |
| 03 | 3 | 4 | 6 |
| 04 | 3 | 4 | 3 |
| 05 | 3 | 3 | 4 |
| 06 | 3 | 3 | 3 |
| 07 | 3 | 3 | 3 |
| 08 | 3 | 4 | 3 |
| 09 | 4 | 4 | 1 |
| 10 | 2 | 1 | 3 |

初次审计输入 SHA256（根 agent 同轮后续修改 provenance 与 GDAL id，故以下标识为整改前快照）：

- natural：16a7059fe76261db785f04471b7c3d98cb3548e448e3bfcc76339fb674f5238f
- human：f78b10537f3881f0c53a616d86a56452bb22b6b3747bdaf7244c07f0a48cf3a7
- geotech：552a2bf14c1991e01dddcf06da12f3efe68149d555a6591d5b3af641db678048

## 18 篇官方原文抽查

下表均实际读取详情正文，非仅搜索结果；GDAL 3.12.4 另读取固定标签 NEWS.md。LOC SYMAP 首次 web 工具访问错误，随后重试成功，不能把首次失败解释成原站不可用。日期列为原站显示的发布日，区别于更新时间及北京时间。

| 类别 | 原文与原站发布日期 | 对照事实及结论 |
| --- | --- | --- |
| 自然 | [Gezani](https://wmo.int/media/news/tropical-cyclone-gezani-hits-madagascar-and-threatens-mozambique)，02-13 | 02-10 马达加斯加东部登陆、Toamasina 严重损毁、搜救安置均吻合。原文给当时受影响约 27 万、死亡至少 40 等阶段数字；候选未抄数字，未把阶段值冒充最终值，但丢失规模证据。 |
| 自然 | [尼泊尔洪灾](https://wmo.int/media/news/flood-tragedy-nepal-highlights-cross-border-and-cascading-risks)，08-27 | 08-26 灾害，冰岩崩塌为正在调查的初步假设；候选保留可能性，未断言最终触发机制。原文载 08-27 当地 18:20 阶段通报，及河流水位快速增长，候选未保留这些可评分证据。 |
| 自然 | [南亚季风展望](https://wmo.int/media/news/south-asia-expected-receive-below-average-monsoon-rainfall)，04-30 | 06–09 月大部偏少、西北/东北/南部部分地区正常或偏多、日夜温度偏高均吻合，且保留预测性质。原文一处写 May–September、一处写 June–September；候选采用导语主季节范围，未构成误述。 |
| 自然 | [未来五年温度展望](https://wmo.int/media/news/new-report-suggests-more-global-temperature-records-ahead)，05-28 | 2026–2030、北极异常大于全球、预测而非观测均吻合。原文同时给 86%、91%、75% 三种不同事件概率；候选没有混淆概率，但完全省略概率、基准期及阈值，妨碍评估信息增量。页面 Last updated=05-27 不可取代 05-28 发布日。 |
| 自然 | [全球气候状况 2025](https://wmo.int/media/news/earths-climate-swings-increasingly-out-of-balance)，03-23 | 报告年度 2025、发布年度 2026、全球温度/海洋/冰川均吻合。页面 Last updated=03-20 不可替换发布日。 |
| 自然 | [沙尘公报](https://wmo.int/media/news/AirborneDustBulletinJuly25)，07-10 | URL 带 July25，但正文明确为 2026 年第十期公报、评估 2025；候选年份正确。AI/卫星、自然与土地水管理成因概述忠实。更新时间 08-06 不等于发布日。 |
| 地信 | [QGIS 4.0](https://blog.qgis.org/2026/03/09/qgis-4-0-norrkoping-is-released/)，03-09 | 正式主版、三平台安装程序、超过 100 个功能、Qt6 指南均吻合。候选 API 显式时区时间为北京时间 03-10，是同一时刻的不同显示日期，不应改为更新日 03-18。 |
| 地信 | [下一版 QGIS LTR 计划](https://blog.qgis.org/2026/10/03/release-schedule-changes-for-next-qgis-ltr/)，10-03 | 4.2 不再 LTR，4.4 付费修复延至六周，4.4.4 预计 2027-03-05 均吻合，正确写成计划。 |
| 地信 | [插件站 4.0.0 预告](https://blog.qgis.org/2026/07/06/coming-soon-qgis-plugins-website-v4-0-0/)，07-06 | 计划 07-13、权限与自动批准调整、Qt6 检查均吻合，候选未将预告冒充已部署。 |
| 地信 | [GDAL 3.12.4](https://github.com/OSGeo/gdal/releases/tag/v3.12.4)，04-24 | 官方发行页为 bugfix；[固定标签说明](https://raw.githubusercontent.com/OSGeo/gdal/v3.12.4/NEWS.md)本版段落支持错误处理 use-after-free、线程池 warp 死锁、NaN 和 HDF4 恶意数据崩溃修复。只对照本版段落，避免跨版本 NEWS.md 搜索串版。 |
| 地信 | [GDAL 3.13.0](https://github.com/OSGeo/gdal/releases/tag/v3.13.0)，05-08 | 新功能版本、vector combine/hull/dissolve、COG/GPKG 校验、Zarr/EOPF、E57/CPHD 和海洋驱动写支持均吻合。 |
| 地信 | [OSM 小额资助](https://blog.openstreetmap.org/2026/10/05/2026-community-microgrants-call-for-applications/)，10-05 | 总额 €5000、每项上限 €500、10-05 至 10-25、11 月首周拟公布均吻合，无将未来结果作为完成事实。 |
| 历史人文 | [Colles 道路测绘](https://blogs.loc.gov/maps/2026/01/an-18th-century-survey-of-the-roads-of-the-united-states-of-america/)，01-16 | 1789 年图集、其自制测距轮、未完成图集与东北部景观均支持 meta 摘要；未将古代事件写成 2026 发生。 |
| 历史人文 | [新生国家地图](https://blogs.loc.gov/maps/2026/02/mapping-a-nascent-nation/)，02-13 | 2026 为建国 250 年纪念，研究对象包括殖民/独立时期地图和华盛顿测绘；候选明确纪念性质，无历史年份错置。 |
| 历史人文 | [盘古大陆地图](https://blogs.loc.gov/maps/2026/04/a-drifting-world-the-supercontinent-of-pangaea/)，04-03 | 约两亿年前大陆、通过馆藏地图回顾大陆漂移理论史；候选概述吻合，属于科普/历史解读而非新发现报道。 |
| 历史人文 | [SYMAP/SYMVU](https://blogs.loc.gov/maps/2026/04/symapping-the-puget-sound-exploring-early-techniques-in-computer-cartography/)，04-24 | 1970 普查机器可读数据、1974 图集、SYMAP 与 SYMVU 应用均支持候选，未冒充 2026 新软件发布。 |
| 历史人文 | [共管领土地图](https://blogs.loc.gov/maps/2026/06/condominiums-exploring-jointly-ruled-territories-through-maps/)，06-12 | 元描述与正文主题一致；但候选仅说探索今昔共管领土，完全省略英埃苏丹、波黑等地区和时期，不能充分判别空间意义或新认知。 |
| 历史人文 | [勒拿河三角洲/北极探险](https://blogs.loc.gov/maps/2026/10/lena-river-delta/)，10-01 | 对北极通航和探险制图史的导语概述吻合，2026 为介绍文章发布年，无虚构当年探险。 |

## 需在生产筛选前处理的材料限制

1. **独立双评分无法弥补输入缺失。** `scripts/seed-curated.ts` 把非空 bodyText 的 bodyStatus 设为 ok；`packages/backend/src/editorial/analyze.ts` 的 waitsForPage 只在 pending 且没有 bodyText 时等待全文抓取。这里人工中文摘要/官方 meta description 一旦作为 bodyText 导入，评分所见就是摘要，通常不会自动补正文。现有评分提示要求地点、动作、阶段和核心事实，且禁止替材料补缺失数字。因此短文并非自动不合格，但共管领土等一行主题简介不足以支持高质量评分。建议由研究 agent 补事实性材料摘述（具体地区、时间、对象、证据、可核验数据），或建立合法的内部全文评分输入；公开出口仍只摘要加原文链接。不要为了增加入选数量改评分/门槛。
2. WMO 预测候选宜补预测有效期、概率对应事件、温度基准期；灾害候选宜保留带官方出处及截至时点的关键规模数据。安全的省略比编造好，但完全省略会削弱 evidence 与 significance 评分。若不补，必须将结果标为“基于候选摘述评分”，不能称“读原文后的模型评分”。
3. human 的 31 条无顶层 language；5 条 bodyText 残留 `&amp;`。建议后续导入/材料整理显式记录 en 并解码 HTML 实体。实体残留不改变事实，但不应流入读者文案。language 缺失是否被自动检测，本组未做生产回归，不能断言会错误翻译。

## 日期精度与出刊归属

- natural 30 条为 YYYY-MM-DD，raw.provenance 全部标记 datePrecision=day 和 dateClockUnknown=true。human 31 条为 UTC 零点归一化，raw.dateEvidence 说明时钟未知，但未采用统一 datePrecision 字段。不能把 human 的 00:00:00Z 作为真实发布时刻来决定某日 08:00 之前已发布。
- geotech 时间戳有明确偏移/UTC；QGIS 文章显示日与北京时间可相差一天，这不是事实错误。原文显示日期、瞬时时间和发布时区宜分别保存。
- 地信文件原始字符串月份统计为五月 4、六月 3；转换为本站 Asia/Shanghai 后是五月 3、六月 4。[OSMF 论坛回顾](https://blog.openstreetmap.org/2026/05/31/osmf-at-the-geospatial-world-forum-2026/) publishedAt=2026-05-31T17:35:06Z，对应北京时间 2026-06-01T01:35:06+08:00。因此研究报告的“时间戳月份”表成立，但本站月报必须按明确的刊期时区窗口归属，不应照抄该表。原事件是 04-28 至 05-01 论坛，文章是五月底回顾，更不能倒填为四月即时消息。
- 日期精度为日的历史回补属于后续补刊材料；日报宜显示补刊生成/更新日，不能将未知时刻伪装成当天定时出刊时已采到的事实。周报/月报仍走本站既有管道和时间窗口。

## 未覆盖边界

未核验全部 91 个详情的逐句忠实性、所有地图/PDF/外链、灾害数据的后续最终修订；未执行真实模型预筛/双评分、入库去重、成刊或公共页面验收。三个来源组只覆盖 5 个机构/项目信源，十个月均有候选不等于全年或全部地理领域覆盖；历史人文组仅 LOC，当前中国人口/城市/规划和政治地理仍需独立候选补充。

## 同轮整改与独立复核

本组报告发现后，根 agent 修改导入路径。本组随后只读确认：91/91 候选都带 `raw.archive.bodyIsSynopsis=true`；`scripts/seed-curated.ts` 在 archive 模式对此标识写 bodyText=null、bodyStatus=pending，把摘述保留为 raw._geohot.researchSynopsis，并记 originalExtractionRequired=true。这解决了新导入候选把短摘述当完整正文的入口问题。抽取失败时既有分析器仍可能降级为有限材料评分，不能仅凭代码修改宣称 91 条已全部取到完整原文；须由生产队列与正文状态复核。

根 agent 另通报早期 61 条中 12 条重复正文已从 revision 恢复并记录 audit_log，以及旧短摘述将精准重投抽取。本组没有访问生产库独立核验这些写入，状态属于根 agent 执行通报，不与本组实证混用。

本组直接确认 GDAL 5 个候选 id 现为 archive-geotech-gdal-3-12-4、3-13-0、3-13-1、3-13-2、3-13-3，版本分隔已使用连字符。此前含点 id 被 CLI 跳过的原因及重投生产结果由根 agent 复核；本组确认修后的候选结构，未执行重投。

整改后文件复读仍为 30/31/30 行。SHA256：natural 8e20c4b80f055fe52279a8fd4a1cbc26ad0b1cbb4ef60d42c84567dec1ea5edc；human 24188b71c47b21768a7dac80b006bb941010999818202a8e29a47c57f8514a0e；geotech 9b512b71e021d227cc9ceee1baf0037ec92507c922bdd4654d254d6e053d2725。正文忠实性、日期精度、UTC/上海月份归属与全年覆盖限制仍按本报告对应章节处理。
