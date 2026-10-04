# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔（`interval_minutes`）。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，
最短 15 分钟；上限按**信源类型**分三档，不是按"免不免费"分（`packages/backend/src/sources/collect.ts` 里
`adaptIntervals` 的 `const max = …` 与 `const min = …` 两行）——
`participation_mode=hot_signal` 最长 180 分钟，`x_search` 或带 `paid_listing` 的（真正按次计费的那两类）最长 120 分钟，
其余 60 分钟；下限 15 分钟，按次计费的那两类不低于 60 分钟。这一句以前写的是"免费信源最长 60 分钟，
按次计费的信源最长 120–180 分钟"，把属于 `hot_signal` 的 180 说成了计费档，已改正。

两条本站的实情：① 这个自动调整任务只在 `COLLECT_ENABLED` 不为 false 时才注册（`apps/worker/src/schedules.ts:82-87`），
所以上面那三档在关着采集的机器上根本不会跑；② **本站一条按次计费的信源都没有**——`industry/sources.json` 的信源里
`x_search`、`mp_account`、带 `paid_listing` 的现值都是 0，所以"按次计费"这一档在现部署下是空集，采集不产生账单。
登记间隔的现值最小 30 分钟（4 条 30、12 条 60、1 条 90、15 条 120、4 条 180、32 条 240、8 条 360、1 条 720、8 条 1440；
`node -e` 一行可复测，命令见 `README.md` 的「现状与边界」）——**"最快的源 30 分钟看一次"是本站的口径，
15 分钟只是自适应下限，当前没有任何一条源达到触发它的产量**。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。

## 第八轮新增的 14 条（2026-10-03，逐条实测）

第八轮那四个板块页（`/boards`，2026-10-04 按站长要求已删）要落地，先要证明"这些源真的在发、采集器真的够得着"。下表每条都是**在采集器所在的那台服务器上**用
`curl -sS -o /dev/null -w "%{http_code}|%{content_type}" -L --max-time 25 <url>` 当天实测过的；
"最近条目"是当时从响应里读到的 `<pubDate>`/`<updated>`。加进 `industry/sources.json` 之后它们各自声明了
`defaultCategory`，条目直接归到对应的分类（分类词表 `industry/taxonomy.ts`；「归到」那一列写的就是分类名）。

| id | 信源 | 类型 | 实测 | 归到 |
|---|---|---|---|---|
| `cn-chsi-kydt` | 研招网 政策与规定（教育部） | `web_list` | 200 · 80 条 · 最新 2026-09-24《2027 年全国硕士研究生招生工作管理规定》 | 考研 |
| `intl-ogc-blog` | OGC 开放地理空间联盟 | `rss` | 200 · 10 条 · 2026-10-01 | 地理信息系统 |
| `intl-qgis-releases` | QGIS 版本发布（官方 Atom） | `rss` | 200 · 10 条 · 2026-09-25 | 地理信息系统 |
| `intl-thediplomat` | The Diplomat | `rss` | 200 · 96 条 · 2026-10-03 | 地理与政治 |
| `intl-worldpoliticsreview` | World Politics Review | `rss` | 200 · 10 条 · 2026-10-02 | 地理与政治 |
| `intl-foreignaffairs` | Foreign Affairs | `rss` | 200 · 20 条 · 2026-10-02 | 地理与政治 |
| `intl-crisisgroup` | International Crisis Group | `rss` | 200 · 10 条 · 2026-09-25 | 地理与政治 |
| `intl-chinadialogue-zh` | 对话地球 China Dialogue（中文版） | `rss` | 200 · 10 条 · 2026-10-01 | 地理与政治 |
| `intl-unocha` | UN OCHA（人道协调厅） | `rss` | 200 · 10 条 · 2026-10-02 | 自然地理（灾害） |
| `intl-theconversation-env` | The Conversation 环境话题（逐条 CC） | `rss` | 200 · 25 条 · 2026-10-02 | 自然地理 |
| `intl-nasa-science` | NASA Science | `rss` | 200 · 10 条 · 2026-10-03 | 自然地理 |
| `intl-loc-worlds-revealed` | 国会图书馆 · Worlds Revealed | `rss` | 200 · 10 条 · 2026-10-01 | 地理与历史 |
| `intl-publicdomainreview` | The Public Domain Review | `rss` | 200 · 100 条 · 2026-09-30 | 地理与历史 |
| `intl-eseh` | 欧洲环境史学会 ESEH | `rss` | 200 · 10 条 · 2026-09-30 | 地理与历史 |

许可一律按最保守的一档登记：`site_fulltext` 与 `syndicate_fulltext` 都是 `false`，也就是只出标题、摘要与
原文链接。其中三条的来源方自己写了更宽的条款（GDACS 已在用的 CC BY 4.0、The Conversation 逐条 CC BY、
Public Domain Review 明说可自由分享与复用），**要不要放宽是站长的决定**，本轮没有替他改。

### 看过但没有加的（点名记录，免得下一轮重新试一遍）

- `www.mnr.gov.cn`（自然资源部）：内容活着（钉 CDN IP 后 200、2026-10-02 有新稿），但这台采集器的 DNS 解析不了
  它，而**往配置里钉 IP 是不做的**（换机器就断）。要接它得先换网络出口或换解析。
- `m.thepaper.cn` 的频道页：当天实测被 WAF 拦（403），且为定位频道号枚举过一次 `list_` id 之后整站持续 403
  直到本轮结束——接入纪律就写在这儿：**固定 1–2 个频道号，绝不遍历**。
- `alerts.weather.gov`：域名已注销（NXDOMAIN），替代是 `api.weather.gov/alerts`（`json_list` 可接，本轮未接）。
- EMSC 的 RSS/JSON 三种写法全 404；`esri.com/arcgis-blog/feed/` 是 200 但 0 条目；`metrocosm.com/feed/` 已被人抢注
  成别的内容——永不接入。
- 停更超过 30 天的一律不加（`developers-blog` 915 天、Mapbox Medium 2179 天、CSIS 3865 天、
  `gislounge` 71 天、`blog.qgis.org` 88.8 天〔已在用的保留〕）。
- 考研分区剩下的候选：中国教育在线、知乎专栏、`chinakaoyan.com`（403）——要么前端渲染没有服务端列表，
  要么没有机器可读形状，全部没接；这也是"考研分类目前只有政策一条源"的原因。

## 第九轮新增的 27 条（2026-10-03，逐条实测）

中国部委、流域委员会、国际减灾与气候治理、冰冻圈、极地与火山几个方向在这一轮补齐。下表每条的「实测」栏是
**用项目自己的抓取器**（`packages/backend/src/sources/rss.ts` 的 `fetchRss`、`packages/backend/src/sources/web-list.ts`
的 `fetchWebList`，UA 用默认的 `GEOHOTBot`）跑出来的：`200` 是同一时刻裸 `curl` 在采集器所在那台服务器上拿到的状态码
（原始状态码 / content-type / 字节数另记），「条」是抓取器解析出的条目数，「最新」是当次响应里读到的最新
`<pubDate>` / 列表日期。加进 `industry/sources.json` 之后它们各自声明了 `defaultCategory`，条目直接归到对应的
分类（分类词表 `industry/taxonomy.ts`）。完整的候选与淘汰过程在 `.round9/sources-proposal.md`（不在仓库里，随交付材料）。

| id | 信源 | 类型 | 实测 | 归到 |
|---|---|---|---|---|
| `rss-undrr` | 联合国减灾办公室 UNDRR（新闻与减灾治理动态） | `rss` | 200 · 40 条 · 最新 2026-10-02 | 自然地理 |
| `rss-ipcc` | IPCC 政府间气候变化专门委员会（评估进程与会议动态） | `rss` | 200 · 10 条 · 最新 2026-09-28 | 自然地理 |
| `rss-fao-newsroom` | 联合国粮农组织 FAO（新闻发布） | `rss` | 200 · 20 条 · 最新 2026-10-02 | 人文地理 |
| `rss-jrc-news` | 欧盟委员会联合研究中心 JRC（新闻） | `rss` | 200 · 30 条 · 最新 2026-09-29 | 自然地理 |
| `rss-noaa-ncei` | NOAA 国家环境信息中心 NCEI（新闻） | `rss` | 200 · 10 条 · 最新 2026-10-01 | 自然地理 |
| `rss-nasa-earth-observatory` | NASA 地球观测站（Earth Observatory 影像与解读） | `rss` | 200 · 10 条 · 最新 2026-10-02 | 自然地理 |
| `rss-weeklyosm` | weeklyOSM（OpenStreetMap 社区周报） | `rss` | 200 · 10 条 · 最新 2026-09-27 | 地理信息系统 |
| `rss-mrc-mekong` | 湄公河委员会 MRC（流域治理动态） | `rss` | 200 · 10 条 · 最新 2026-09-18 | 区域地理 |
| `rss-icimod` | 国际山地综合发展中心 ICIMOD（兴都库什—喜马拉雅） | `rss` | 200 · 9 条 · 最新 2026-09-25 | 区域地理 |
| `rss-ingv-news` | 意大利国家地球物理与火山学研究所 INGV（新闻室） | `rss` | 200 · 10 条 · 最新 2026-09-29 | 自然地理 |
| `rss-nrcan-quakes` | 加拿大地震局（显著地震事件 Atom 源） | `rss` | 200 · 12 条 · 最新 2026-09-28 | 自然地理 |
| `rss-nsidc-news` | 美国国家冰雪数据中心 NSIDC（新闻与解读） | `rss` | 200 · 25 条 · 最新 2026-10-01 | 自然地理 |
| `web-mnr-ywbb` | 自然资源部 要闻播报 | `web_list` | 200 · 18 条 · 最新 2026-10-02 | 自然地理 |
| `web-cgs-ddyw` | 中国地质调查局 地质调查动态 | `web_list` | 200 · 14 条 · 最新 2026-09-30 | 自然地理 |
| `web-mee-xwfb` | 生态环境部 新闻发布 | `web_list` | 200 · 6 条 · 最新 2026-09-30 | 自然地理 |
| `web-forestry-lcdt` | 国家林业和草原局 林草动态 | `web_list` | 200 · 20 条 · 最新 2026-10-03 | 自然地理 |
| `web-cea-fzjzyw` | 中国地震局 防震减灾要闻 | `web_list` | 200 · 20 条 · 最新 2026-09-30 | 自然地理 |
| `web-mem-yjglbgzdt` | 应急管理部 工作动态 | `web_list` | 200 · 20 条 · 最新 2026-10-02 | 自然地理 |
| `web-mwr-sjzs` | 水利部 司局直属单位动态（七大流域委员会） | `web_list` | 200 · 25 条 · 最新 2026-10-03 | 自然地理 |
| `web-yrcc-hhyw` | 黄河水利委员会 黄河要闻 | `web_list` | 200 · 15 条 · 最新 2026-09-30 | 自然地理 |
| `web-cjw-cjyw` | 长江水利委员会 长江要闻 | `web_list` | 200 · 30 条 · 最新 2026-10-02 | 自然地理 |
| `web-ncc-wid100` | 国家气候中心 全球灾害简讯（中文） | `web_list` | 200 · 20 条 · 最新 2026-09-29 | 自然地理 |
| `web-ecmwf-news` | 欧洲中期天气预报中心 ECMWF（新闻） | `web_list` | 200 · 18 条 · 最新 2026-10-02 | 自然地理 |
| `web-igsnrr-zhxw` | 中科院地理科学与资源研究所 综合新闻 | `web_list` | 200 · 20 条 · 最新 2026-09-30 | 自然地理 |
| `web-igsnrr-kyjz` | 中科院地理科学与资源研究所 科研进展 | `web_list` | 200 · 20 条 · 最新 2026-09-04 | 自然地理 |
| `web-wmo-news` | 世界气象组织 WMO（新闻） | `web_list` | 200 · 7 条 · 最新 2026-10-01 | 自然地理 |
| `web-pric-news` | 中国极地研究中心（新闻） | `web_list` | 200 · 55 条 · **无列表日期** | 自然地理 |

这 27 条 = **12 条 `rss` + 15 条 `web_list`**，`tier` 是 **26 条 `T1` + 1 条 `T1_5`**（`rss-weeklyosm`）；
`interval_minutes` 登记为 240 分钟 19 条、360 分钟 6 条、120 与 180 分钟各 1 条（和别的源一样，这只是上限，
`adaptIntervals` 会按产量往下调）。许可一律按最保守的一档：`site_fulltext` 与 `syndicate_fulltext` 全部 `false`，
只出标题、摘要与原文链接。那一轮加完之后 `industry/sources.json` 是 **85 条**（`rss` 51 / `web_list` 23 / `json_list` 3 /
`external` 8），其中 **77 条可轮询**、8 条 `external` 仍是人工投递通道（2026-10-04 又加到 87 条 / 79 条可轮询；条数的唯一口径在 `README.md`）。

三件要说明的口径：

- **`owner_entity_id`**：20 条非 `null`，全部同时命中 `industry/taxonomy.ts` 的 `ENTITIES` 与 `IDENTITY_LEXICON`；
  另外 7 条写 `null`（JRC、MRC、ICIMOD、INGV、NRCan、NSIDC、ECMWF）——这几家在两份名录里都没有条目，
  按本文档与 `sources.json` 头部注释的单一规则宁可留空，也不挂到形似的机构上（`writing.ts:190` 只认
  `IDENTITY_LEXICON`，挂错等于给身份守卫放行一个原文没写的机构名）。要给它们归属，先往
  `ENTITIES` / `IDENTITY_LEXICON` / `PUBLISHER_DOMAINS` 补条目，不要在 `sources.json` 里造没人认领的字符串。
  **本轮没有改动 `industry/taxonomy.ts`。**
- **日期**：26 条的列表页带日期；`web-pric-news` 的列表页没有日期元素（试过从 `[月-日]` 串里取，但列表不给年份，
  会被解析成 2001 年，方案已废弃），首次导入按 `_aihot.initialBackfillLimit` 截断，之后靠 `discoveredAt` 兜底。
  列表页没有日期元素的（`web-cjw-cjyw`）用 `publishedAtRegex` 从条目 HTML 里取，30/30 命中。
- **首次导入**：新源第一轮按 `_aihot.initialBackfillLimit` 截断、按 `initialBackfillMonths`（默认 12 个月）丢掉超期条目，
  再走「旧文不刷屏」那条 48 小时规则归档，所以不会一次性把存量倒进「今天」。

#### 端到端复采：27 条全过（2026-10-04 上午）

上面的表是提案阶段的实测。**加进 `sources.json` 之后又整跑了一遍真采集**，用来证明"写在配置里"与"真的跑得通"
是同一件事——命令是 `node scripts/collect.ts <id>` 的批量版（`collectSource(id, { force: true })`），库是一个
一次性的 `geohot_probe`（跑完 `DROP DATABASE`），所以不碰开发库也不碰生产：

- **26 条第一次就 `status=ok`**；`web-forestry-lcdt` 首跑 `HTTP 502`，**紧接着原地重试就 `found=20`**——
  这是 `forestry.gov.cn` 的间歇性 502（同一地址裸 `curl` 连打 6 次全 200，node `fetch` 第 1 次 502、第 2 次起 200），
  不是配置错。`collectSource` 失败时 `fail_count + 1`、`health='degraded'`、`next_fetch_at` 按
  `LEAST(interval_minutes * (fail_count + 2), 360)` 退避，所以真部署上遇到它只是一次延迟，不会变成坏源。
- **27 条合计落库 278 篇**，每条都建了 `fetch_runs` 行（`ok 28 / 非 ok 3`，非 ok 的就是那几次 502）、
  每条 `cursor.initializedAt` 都写上了（首次导入标记）。
- **10 篇没有 `published_at`**，全部来自 `web-pric-news`（上表已说明该列表页不给年份，方案是接受无日期）。
  其余 26 条 268 篇**全部有日期**，最新一条落在 2026-10-03。
- **「旧文不刷屏」那条规则确实生效**：278 篇里 `published_at` 在最近 3 天内的只有 32 篇，
  其余都按 `initialBackfillLimit` 截断后归档，没有把存量倒进「今天」。

### 第九轮看过但没有加的（8 类原因，表里共 58 行）

> 计数口径：提案正文与第 3 节标题写的是「淘汰 47 条」，但八个分节的小标题相加是 57、表格实际数据行是 58
> （`3.3` 小标题写 19、实际 20 行；且有多行是「一条记录里并列多个候选地址」，按 URL 数还会更多）。
> 上面的 58 是按**实际表格行数**数的，与本文件第八轮那节用同一套数法。

- **被 UA / WAF 拦（6 条）**：`cma.gov.cn` 新闻频道对 `GEOHOTBot` 返回 406 拦截页（Chrome 与无 UA 都 200）；
  OECD、UNHCR、BOM、ISO TC211 一律 403；`pearlwater.gov.cn` 412。**不改 `DEFAULT_UA` 去绕**。
- **feed 口不是 RSS/Atom（8 条）**：UNEP 的 `news-and-stories/rss.xml` 是 Drupal 私有 XML（解析器直接抛「不是 RSS/Atom」）、
  南极条约秘书处、World Bank、Met Office、KMA、天地图、`nmefc.cn` 返回 HTML 或 JS 壳；北极理事会返回 202 空体。
- **404 / 域名失效（20 条）**：WMO 三个 feed 口、FAO 的 un.org 旧路径、IOM、Copernicus EMS、NOAA NCEI 旧路径、
  USGS news feed、ECMWF `rss.xml`、JRC 旧路径、JMA、GeoNet、中央气象署与香港天文台、`en.vedur.is`、INGV `/it/rss`、
  GFZ、EMSC 三种写法、NRCan 旧路径、ESA 第二条 feed、itpcas/nieer/cgs 的 feed、`soa.gov.cn`（域名不可达）。
  这些不是"站点死了"，是**feed 口死了**——其中 6 家改用别的入口接上了（见上表：FAO、NOAA NCEI、ECMWF、JRC、INGV、NRCan）。
- **需要 JS（7 条）**：`satellite.nsmc.org.cn`、`nmefc.cn`、`tianditu.gov.cn`、GeoNet 新闻页（详情页也没有任何
  日期元素）、JMA bosai 巨页、ICIMOD 的 web_list 路径、`cma.gov.cn` 首页（`topDates` 还停在 2018 与 2009）。
- **解析不出条目（7 条）**：OSGeo feed 0 条目、IMD 只有 2 条同质标题、地震局另一频道 items=0、
  `ncc-cma.net` 首页 links=0、`cma.gov.cn` 新闻频道只剩 2 个链接、World Bank 首页没有稳定条目容器、OSGeo 新闻页重定向到单篇。
- **结构不合适（6 条）**：`en.vedur.is/about-imo/news` 干净选择器只出 4 条且全无日期、放宽到 218 条混进导航；
  USGS news 列表无日期且 `detail.publishedAtSelector` 对 HTML 列表页不补日期；自然资源部 `/dt/` 混合频道日期格式混杂；
  `/dt/hy/` 过滤后只剩 1 条（由 `web-mnr-ywbb` 覆盖）；长江/黄河的**门户首页**不是新闻列表页（已改用频道页）；
  六个部委的首页都混导航与专题。
- **日期方案不成立（1 条）**：`pric.org.cn` 的 `[月-日]` 正则能命中 29/39 条，但没有年份，全被解析成 2001 年 → 废弃该正则。
- **纪律性淘汰（3 条）**：`unhabitat.org/rss.xml` 200 且 10 条，但最新只到 2026-08-28（距采样日 36 天），
  按「停更超 30 天不加」淘汰——**站长若愿意放宽，这条能补 `human` 分类**；`climate.copernicus.eu/news`
  首条是导航噪声且其 feed 已被 `rss-copernicus-c3s` 占用；`gfz-potsdam.de` 列表页在抓取器口径下出 388 条
  （导航与归档全吃进来），feed 口 404，没定出干净 config。

第八轮那份「看过但没有加的」本轮复核结论不变，不重复实测。
