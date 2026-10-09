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

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）、
`headers`（这条订阅自己的请求头，第三十轮加的）。它只为「发布方按客户端标识发门槛」的站存在：
`worldpoliticsreview.com/feed` 对本站默认 UA（`http-fetch.ts:60` 的 `DEFAULT_UA`，带 GEOHOTBot 标识）回 Cloudflare 403，
对浏览器 UA 回 200。放在单条配置里而不是全局换 UA，是因为全局换等于对所有守规矩的订阅源谎报身份；
`json_list` 早就是这个形状（`headers` 在它的白名单里），`rss` 现在对齐。要写什么头由 `config-keys.ts:11` 的白名单把关。

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

## 平台信源（X、YouTube 等官方账号）

同一机构的另一个出口也算信源：官方 X 账号、官方 YouTube 频道说的都是那家机构的原话，`first_party` 一律 true。

### YouTube：技术上用 `rss` 接、不需要 key，但本站当前没有登记视频频道

这一节写的是"怎么接"和"当初为什么撤"。视频频道会占本地磁盘：视频文件从不下载，`articles.media` 里只有观看地址、简介和封面 URL，可条目页那张封面和站内其它图片一样走签名代理，`packages/backend/src/media/images.ts:12` 把渲染结果写进 `data/imgcache`（`operations/retention.ts:37` 三十天后清）。第二十四轮（2026-10-05）接进来当晚，站长要求本地磁盘不涨，三条频道因此撤下；下面的 id 与实测结论留着，接回来加一条 `rss` 记录就行。每个频道都有一张服务端渲染的 Atom 列表：`https://www.youtube.com/feeds/videos.xml?channel_id=UC…`。频道 id 只能从频道「关于」页的 `channelMetadataRenderer.externalId` 取（同一页的 `<meta itemprop="channelId">` 给的是同一个值）——**在频道页 HTML 里抓第一个 `UC…` 会抓到侧栏推荐位上的别的频道**，本轮就踩过：这么取回来的 `@NASAEarth` 是一个人的私人频道、`@UNOSAT` 是一段 2010 年的雪景视频。取回还要对得上：feed 的 `<title>` 与 `<author><name>` 必须是这个 handle 的主人本人。第二十四轮（2026-10-05 本机实测，用项目自己的 `fetchRss`）试过三条，每条各回 15 项：

| 频道 | 上传列表 channel_id | 实测 |
|---|---|---|
| `@usgs` | `UCeXH8GZyV3sVqAr45AvupOA` | 15 条，首条〈What stinks in Yellowstone? (Yellowstone monthly update, September 2026)〉，封面 480×360 |
| `@NASA` | `UCLA_DiR1FfKNvjuUpBHmylQ` | 15 条，首条是 Crew-12 的告别与访谈（标题在本机打印时被截断过） |
| `@NOAA` | `UCe9IxQeBttZIYl5c43ycf9g` | 15 条，首条是 1926 年迈阿密飓风百年回顾（同上） |

试过但没登记的：`@esri` 频道存在（`UC_X6fM_9mDxpAUx7GHrD0cA`），可它的上传列表回 **0 条**——视频都排在播放列表里，接进来就是一条永远空的信源；`@CopernicusEU`、`@Britannica`、`@NatGeoLab` 的 handle 直接 404。

视频 feed 不给 `<content>` 也不给 `<summary>`：简介在 `<media:group>/<media:description>`，封面在 `<media:thumbnail>`，`<yt:videoId>` 说明这是一条视频。`packages/backend/src/sources/rss.ts` 因此把这一组读成一条 `kind: "video"` 的媒体（`url` 是观看地址、`poster` 是封面、带上宽高），正文留空。`content/extract.ts` 的 `pageFetchable()` 也把 youtube.com / youtu.be 归进「要么整条到手，要么拿不到」那一类：不再为一条视频去抓 watch 页，也不再为它调用按次计费的渲染服务。读者拿到的就是封面 + 简介 + 回原站，这正是一条视频能给出的全部。频道撤下了，这段读取与解析没有跟着撤：`providers/socialdata.ts:118` 从 X 带回的视频走的是同一个 `publication/items.ts` 的 `videoMedia`，X 额度到位就要用它；`tests/sources.test.ts` 与 `tests/media-performance.test.ts` 一直盯着这条解析与渲染。

### X：用 `x_search` 接，但要 `SOCIALDATA_API_KEY`

SocialData 按请求计费，本部署没有这个 key，所以第二十四轮登记的 8 个账号**全部 `enabled=false`**：`@USGS`、`@NASA`、`@NOAA`、`@WMO`、`@CopernicusEU`、`@un_ocha`、`@Esri`、`@metoffice`。账号存在性是不花钱的——`https://x.com/<handle>` 的页面标题就是「名称 (@handle) / X」，八条逐个核过（`@un_ocha` 的显示名是「UN Ocha」、`@metoffice` 是「Met Office」，登记名按这个写）。猜的另外几个 `@esrigeo`、`@CMA_Weather`、`@china_meteo`、`@gdacs_asi` 全部 404，不进表。补上 key 之后在后台「信源」里逐条启用即可；`tests/industry-pack-sources.test.ts` 一直拦着「按次计费却登记为启用」这种写法。

### 微信公众号：一条都没登记

`mp_account` 需要 `DAJIALA_KEY`（极致了，按请求计费），而配置里的 `ghid` 只有在那个账号真正查一次列表时才拿得到。现在写进去的任何 `gh_xxxxxxxx` 都只能是编造，所以不写。要接就先补 key，再用后台「新建信源 → 微信公众号」按名称搜出来填。

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
其余 60 分钟；下限 15 分钟，带 `paid_listing` 的那类不低于 60 分钟。这一句以前写的是"免费信源最长 60 分钟，
按次计费的信源最长 120–180 分钟"，把属于 `hot_signal` 的 180 说成了计费档，已改正。

**一个例外要说清：按 shard 读的 X 账号不跟自己的量走，跟 shard 的节拍走。** 一次搜索最多带二十几个账号，所以
`collect.ts:403` 的 `X_SHARD_MINUTES` 是 editorial 30 分钟、hot_signal 60 分钟，`adaptIntervals` 对分片源直接
返回这个数（`:631`），每次成功抓取也会把 `interval_minutes` 写成它（`:497`）——**包里给 `x_search` 写的
`interval_minutes` 与 `_aihot.intervalMinutesLocked` 在这条路上都不算数**（30 分钟低于上面那句"不低于 60"）。
按请求计费看的是 shard 的次数而不是账号数，所以这是设计；但第二十四轮登记的 8 条 `x_search` 一旦补上 key 启用，
实际节拍是每 30 分钟一次共享搜索，不是包里那个 120。要真按账号节流，得给 shard 路径也读 `intervalMinutesLocked`。

两条本站的实情：① 这个自动调整任务只在 `COLLECT_ENABLED` 不为 false 时才注册（`apps/worker/src/schedules.ts:82-87`），
所以上面那三档在关着采集的机器上根本不会跑；② **现站在跑的按次计费信源是 0 条**——`industry/sources.json` 里 `mp_account` 与带 `paid_listing` 的仍是 0，`x_search` 第二十四轮登记了 8 条但全部 `enabled=false`（本部署没有 `SOCIALDATA_API_KEY`），所以“按次计费”这一档在现部署下依然是空集，采集不产生账单。
登记间隔的现值最小 30 分钟（271 条：6 条 30、12 条 60、1 条 90、23 条 120、4 条 180、138 条 240、12 条 360、65 条 720、10 条 1440；
`node -e` 一行可复测，读的就是 `industry/sources.json` 这一份）——**包内登记值最快是 30 分钟，15 分钟只是自适应下限**。
这句只对包成立，不对库成立：**线上确实有源被打到了那个下限**。2026-10-09 19:15 从服务器只读复测（本轮那份逐源产量表读的就是 `sources.interval_minutes`，见下面「第五十七轮」一节）：
`json-nmc-weather-alarm` 与 `cn-chinanews-scroll` 两条都是 **15 分钟**（同一份查询里它们 5 小时的入库量是 48 条与 172 条，
也就是每十几分钟就有一条新材料），另有 21/28/40/59/116/153 分钟这些自适应中间值；包内写的 30 分钟因此只是**起点**，
自适应（`adaptIntervals()`，每轮采集后按产量调）才是线上真正的节奏。

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
| `cn-chsi-kydt` | 研招网 政策与规定（教育部） | `web_list` | 200 · 80 条 · 最新 2026-09-24《2027 年全国硕士研究生招生工作管理规定》 | 考研〔2026-10-09 该类别与本条源一并删除〕 |
| `intl-ogc-blog` | OGC 开放地理空间联盟 | `rss` | 200 · 10 条 · 2026-10-01 | 地理信息系统 |
| `intl-qgis-releases` | QGIS 版本发布（官方 Atom） | `rss` | 200 · 10 条 · 2026-09-25 | 地理信息系统 |
| `intl-thediplomat` | The Diplomat | `rss` | 200 · 96 条 · 2026-10-03 | 政治地理 |
| `intl-worldpoliticsreview` | World Politics Review | `rss` | 200 · 10 条 · 2026-10-02 | 政治地理 |
| `intl-foreignaffairs` | Foreign Affairs | `rss` | 200 · 20 条 · 2026-10-02 | 政治地理 |
| `intl-crisisgroup` | International Crisis Group | `rss` | 200 · 10 条 · 2026-09-25 | 政治地理 |
| `intl-chinadialogue-zh` | 对话地球 China Dialogue（中文版） | `rss` | 200 · 10 条 · 2026-10-01 | 政治地理 |
| `intl-unocha` | UN OCHA（人道协调厅） | `rss` | 200 · 10 条 · 2026-10-02 | 自然地理（灾害） |
| `intl-theconversation-env` | The Conversation 环境话题（逐条 CC） | `rss` | 200 · 25 条 · 2026-10-02 | 自然地理 |
| `intl-nasa-science` | NASA Science | `rss` | 200 · 10 条 · 2026-10-03 | 自然地理 |
| `intl-loc-worlds-revealed` | 国会图书馆 · Worlds Revealed | `rss` | 200 · 10 条 · 2026-10-01 | 历史地理 |
| `intl-publicdomainreview` | The Public Domain Review | `rss` | 200 · 100 条 · 2026-09-30 | 历史地理 |
| `intl-eseh` | 欧洲环境史学会 ESEH | `rss` | 200 · 10 条 · 2026-09-30 | 历史地理 |

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
  要么没有机器可读形状，全部没接；这也是当时「考研」方向只有一条政策源的原因。**2026-10-09：这一类别连同
  那一条源（`cn-chsi-kydt`）都已整块删除**，本段保留是为了不让下一轮再去试这批候选。

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
`external` 8），其中 **77 条可轮询**、8 条 `external` 仍是人工投递通道（那一轮之后又加了三条中文 `web_list`，2026-10-04 晚到 90 条 / 82 条可轮询；条数的唯一口径是 `industry/sources.json` 本身）。

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

## 第三十轮（2026-10-06）：一条复活、五条停用

本轮把持续失败的信源逐条重测（本机 + Azure 采集机各一遍，用的是项目自己的 `fetchRss` / 同一条 curl），结论是
**七条里只有一条真能修**。逐条记录：

| 信源 | 本机（境内出口） | 采集机（境外出口） | 处理 |
|---|---|---|---|
| `intl-worldpoliticsreview` | 默认 UA 403 / 浏览器 UA 200 | 同左 | **修好**：`config.headers` 带浏览器 UA，feedUrl 补结尾斜杠；`fetchRss` 实测 10 条 |
| `intl-unocha` | 406（任何 UA） | 406 | **停用**：edge 直接挂反爬告示 |
| `web-thepaper-topnews` | 200 | 403（解析到 23.248.173.25） | **停用**：WAF 按来源 IP |
| `web-cea-fzjzyw` | 200 | 403 | **停用**：同上，浏览器 UA 也一样 |
| `web-mnr-ywbb` | 200 | DNS 无应答（`getent hosts` 空） | **停用**：域名不回答境外 resolver |
| `web-cjw-cjyw` | 200 | 解析到 59.175.239.227，TCP 连不上（http/https 都是 000） | **停用**：连接层不通 |

`json-ceic-earthquake`（上一轮报的那条）复核是**抖动不是坏**：同一台采集机上重跑拿到 322 条。

### UN OCHA 为什么不追着修

`https://www.unocha.org/rss.xml` 对所有请求（站内 UA、浏览器 UA、`Accept: */*`、直接命中跳转后的最终地址）都回
406，响应体是 AWS 负载均衡那层的 JSON，`error` 字段写的是 `Blocked due to bot activity`，还留了邮箱让人类去联系。
同一地址裸 `curl` 能拿到 200——差别在客户端指纹（TLS/HTTP 实现），不在请求头。要过去就得给请求补上浏览器才有的
`sec-fetch-*` / Client Hints 并伪造 TLS 指纹。这是**绕过站点明确挂出的反爬告示**，本站不做：内容诚信这条线不只管写出来的字，
也管取内容的手段。真要接 OCHA，正路是按它自己给的方式去联系拿授权，或者换一个境内出口再测。配置原样留着，改回
`enabled=true` 就能跑。

### 四条境内官方站：问题在部署位置，不在配置

澎湃、中国地震局、自然资源部、长江水利委员会这四条在本机（境内网络）全部 200，配置和选择器都还是对的；
在采集机（Azure，境外出口）上被 WAF、DNS 与连接层各自挡掉。这类失败换 UA、换路径都不会变，因为门槛看的是来源地址。
所以按 `enabled=false` 停用，而不是留着让调度每轮记一次失败——后台的「信源」页会一直显示四条红的，读者与站长看到的
健康度就全是噪声。**采集出口若搬到境内节点，把这四条改回 `enabled=true` 即可，配置不用动。**

### 信源包改了，库里的行不会自己变

`scripts/seed.ts` 是 `ON CONFLICT (id) DO NOTHING`，只增不改（这是设计：导入之后开关归后台管）。所以本轮这六处
`enabled` / `config` 改动**不会**随部署生效，必须把包里的现状推回库。以前这一步只能手敲 SQL，而这个仓库不接受
没有留痕的生产写库，于是有了 `scripts/set-source-state.ts`：

```
node scripts/set-source-state.ts --ids=intl-unocha,web-thepaper-topnews,…           # 先 dry run，打印差异
node scripts/set-source-state.ts --ids=… --apply --database-url=postgres://…        # 显式给库才写
```

它只写 `enabled` 与 `config` 两列（`tier`、`interval_minutes` 这些仍是后台所有），并且照抄后台开关的副作用：
停用把 `health` 停到 `paused`、启用把陈旧的 `paused` 清成 `unknown`（`packages/backend/src/admin/sources.ts:118`）。
`--ids` 是必填的——不做整包对齐，免得把站长在后台手动关掉的源悄悄打开。

调度侧不用另外处理：`collect.ts:561` 的入队查询带 `WHERE enabled`，`collect.ts:209` 对已停用的源直接返回
`skipped/paused`，已入库的条目一律留着不改（停用只停止新增，不下架旧内容）。

## 第四十一轮（2026-10-06 深夜）：学术团体与政府间机构六条（98 → 104）

站长要求"再拓展信息源，一定要权威官方"。做法与第三十轮一样：**先探后收**——候选名单先在**采集那台机器**上
用采集器自己的 UA 逐条 `curl`（本机 DNS 会骗人，第三十轮已吃过一次），feed 活着、条目数正常、**最近一条在 45 天
以内**三条同时成立才写进信源包；写进包之后还要在生产库跑一次 `scripts/collect.ts` 真抓，**第一次抓取入库 0 条就退回**。

**收下的六条**（全部 `participation_mode=editorial`、`site_fulltext=false`，实测时间 2026-10-06 23:0x +0800）：

| id | 名称 | feed | tier | 实测 |
|---|---|---|---|---|
| `rss-igu-online` | 国际地理联合会（IGU）· 新闻 | `https://igu-online.org/feed/` | T1_5 | 200 RSS、10 条、**最新就是当天** |
| `rss-aag-news` | 美国地理学家协会（AAG）· 新闻 | `https://www.aag.org/feed/` | T1_5 | 200 RSS、10 条、最新 10-05 |
| `rss-ica-carto` | 国际制图协会（ICA）· 新闻 | `https://icaci.org/feed/` | T1_5 | 200 RSS、10 条、最新 09-29 |
| `rss-ipbes-news` | IPBES（生物多样性与生态系统服务政府间科学政策平台）· 新闻 | `https://www.ipbes.net/rss.xml` | T1 | 200 RSS、30 条、最新 09-30 |
| `rss-isc-science` | 国际科学理事会（ISC）· 新闻 | `https://council.science/feed/` | T1_5 | 200 RSS、10 条、最新 10-01 |
| `rss-unhabitat-news` | 联合国人居署（UN-Habitat）· 新闻 | `https://unhabitat.org/rss.xml` | T1 | 200 RSS、10 条、最新 08-28（频率低，抓取间隔 720 分钟） |

**同批退回的候选（记下来，下一轮别再重复探）**：`intl-unep`（UNEP 的 feed 不是 RSS——是自定义
`<response><item><title><path><created>` 的 XML，现有采集器没有这种形状的解析器；要接得先写解析器，不是加一行）、
`reliefweb`（给出的是 HTML 页不是 feed）、`noaa-research` / `usgs-newsroom` / `usgs-volcano-watch` / `noaa-ncei` /
`bgs-news` / `ga-news` / `geonet` / `seismo-eth` / `dwd` / `eurostat` / `iom` / `fao` / `unccd` / `unesco` /
`unfccc` / `copernicus-news` / `copernicus-clms` / `jma` / `imo-vedur` / `cgs` / `nsmc` / `nmefc` 全是 404 或页面不是 feed；
`gvp-weekly`（Smithsonian 全球火山活动计划）**403**、`gbif` 403、`wri` 403、`ams-news` 403、`jaxa` 403、
`bom-warnings` 403、`nasa-earthdata` 403；`iucn` 的 feed 最新一条停在 2022-02、`cnes` 停在 2024-05、
`copernicus-cdse` 停在 2026-05、`copernicus-c3s` 停在 2026-08（后两条的内容我们已经有别的哥白尼源覆盖着）；
`fig-surveyors` 与 `worldbank-climate` 返回的是网页。**中国官方站这一批依旧探不动**：`cas.cn`（中国科学院）与
`most.gov.cn`（科技部）页面本身 200、列表也拿得到（CAS 的 `/syky/` 有当天条目），但它们没有 feed，
要接得按 `web_list` 写选择器（CAS 的列表不含日期、日期只在 URL 的 `t2026MMDD` 里）——**列为下一轮候选**，
`gov.cn`、`cma.gov.cn` 分别返回 685 字节的拦截页与 406。

**六条全部已用 `scripts/seed.ts` 写入生产库**（`ON CONFLICT DO NOTHING` 只增不改），首次抓取入库数量见本节末那张表的「本机首轮入库」列
「信源数量的唯一说法」那一段所在的同一轮记录；分级依据：IGU/AAG/ICA/ISC 是学会与理事会（自己发布，不是转述），
定 `T1_5`；IPBES 与 UN-Habitat 是政府间机构，定 `T1`。`defaultCategory`：IPBES → `physical`（生态与生物多样性），
UN-Habitat → `human`（城市与城镇化），其余留空由模型判断。

## 第四十八轮（2026-10-07 上午）：卫星与大气、Nature 子刊与院级进展（104 → 113）

站长第二次要求「拓展信息源，一定要权威官方」。判据与前几轮同一套：**先在采集那台机器（Azure VM）上逐条
`curl` 实测**——feed 活着、条目数正常、**最近一条在 45 天以内**三条同时成立才写进包；写进包之后再在本机库
用 `node --env-file=.env scripts/collect.ts <id>` 真抓一遍，**首轮入库 0 条就退回**。

**这一轮收进来 9 条（全部启用）**。表里"实测"是采集机上直接看 feed 得到的，"入库"是本机 `scripts/collect.ts`
首轮的结果：

| id | 地址 | 实测 | 本机首轮入库 | 分级与默认分类 |
|---|---|---|---|---|
| `rss-eumetsat-news` | eumetsat.int/rss.xml | 10 条，最新 2026-10-06 | 10 | T1 / `geotech`（气象卫星与影像） |
| `rss-copernicus-atmosphere` | atmosphere.copernicus.eu/rss.xml | 10 条，最新 2026-09-23 | 8 | T1 / `physical`（大气与空气质量） |
| `rss-nature-water` | nature.com/natwater.rss | 8 条，最新 2026-10-02 | 8 | T1_5 / `physical` |
| `rss-nature-sustainability` | nature.com/natsustain.rss | 8 条，最新 2026-10-06 | 8 | T1_5 / `human` |
| `rss-nature-food` | nature.com/natfood.rss | 8 条，最新 2026-10-01 | 8 | T1_5 / `human` |
| `rss-pnas-toc` | pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas | 90 条，最新 2026-09-29 | 12（`initialBackfillLimit`） | T1_5 / 留空 |
| `rss-ifrc-news` | ifrc.org/rss.xml | 10 条，最新 2026-10-04 | 10 | T1 / 留空（灾害与人道，内容跨类） |
| `rss-cms-bonn` | cms.int/rss.xml | 10 条，最新 2026-10-06 | 8 | T1 / `physical`（迁徙物种与生态） |
| `web-cas-syky` | cas.cn/syky/ | 15 条带日期（见下） | 10，日期无空值 | T1 / `physical` |

**`web-cas-syky` 的教训（这一条值得记着）**：`https://www.cas.cn/syky/` 不是列表页而是**门户**——
`li:has(a[title])` 能匹到 84 个节点，里面是奖项入口、期刊外链、博物馆链接、党建与科普栏目，
只有 `#content` 那一块 15 条才是真正的「科研进展」。第一版选择器收进 10 条、**其中 6 条没有日期**；
改成 `#content li:has(a[title])` 后 10 条全部带日期（列表页 `<span>` 印的是发布日，与 URL 里的
`t2026MMDD` 可以差几天——我们取页面上给读者看的那个）。`allowUrlPrefixes` 是第一道闸，
但它只挡域名与路径，**挡不住同域名下的导航块**，所以门户页必须限定容器。

**同批退回的候选（记下来，下一轮别再重复探）**：

- **停更快照**：`marine.copernicus.eu/rss.xml`（10 条但最新停在 **2025-07-18**）、`unccd.int/rss.xml`
  （最新 2026-03-16，超 45 天）。
- **端点不存在**：`public.wmo.int/en/rss.xml`、`wmo.int/feed`、`nsidc.org/rss.xml`（包里活的是
  `nsidc.org/news/feed`）、`unosat.org/feed`、`emergency.copernicus.eu/rss` 与 `/feed`、
  `emsc-csem.org/service/rss/rss.php` 与 `Earthquake/eqfeed_recent.php`、`psl.noaa.gov/rss/enso.xml`、
  `cpc.ncep.noaa.gov/…/enso-update.rss`、`unesco.org/en/rss.xml` 与 `/en/news/rss.xml`、
  `internal-displacement.org/rss` 与 `/press-releases`、`worldbank.org/en/rss`、`blogs.worldbank.org/rss`、
  `data.worldbank.org/rss.xml`、`cbd.int/doc/rss.xml`、`egu.eu/rss.xml`、`sipri.org/rss.xml` 与 `/feed`、
  `nhc.noaa.gov/rss.xml`、`nationalgeographic.com/environment/feed`、`icimod.com/rss.xml` 与 `/feed`
  （**返回 114 字节的 HTML 壳，包里活的是 `icimod.org/feed/`**）、`tandfonline.com/action/showFeed`。
- **403 / 反爬**：`ctbto.org`、`ramsar.org`、`rsis.edu.sg`、`mdpi.com/rss/journal/*`、`preventionweb.net`、
  `advances.sciencemag.org/rss/current.xml`。**不改 `DEFAULT_UA` 去绕**。
- **返回 200 但不是 feed**：`land.copernicus.eu/rss.xml`（500）、`land.copernicus.eu/global/rss.xml`
  （HTML）、`blog.globalforestwatch.org/feed/`（HTML、0 item）、`link.springer.com/journal/11629/updates.rss`
  （3 KB 的 JS 壳）、`earthobservatory.nasa.gov/feed`（HTML；包里活的是 `/feeds/earth-observatory.rss`）。
- **接口已废弃**：`api.reliefweb.int/v1/reports` → **410 Gone**（v1 下线，要接得走 v2）。
- **UNEP 仍然不可接**：`unep.org/news-and-stories/rss.xml` 有 13 个 `<item>`，但**条目里没有 `<link>`**
  （自定义 XML 方言），与第三十九轮的结论一致；`unep.org/rss.xml` 是停更在 2024-02 的旧快照。
- **本机 DNS 不通（不代表对方下线）**：`nosa.gov.cn`、`cers.ac.cn`、`dtu.iom.int`、`gsi.go.jp`。
- **MOST（科技部）**：根页 200 但列表是脚本渲染、拿不到带日期的服务端锚点，`/xxgk/.../gkxz/` 直接 404。
  留作候选，接它得先找到服务端渲染的列表路径。

**分级依据**：EUMETSAT / CAMS / IFRC / CMS / CAS 是**发布主体自己写稿**（一手），定 `T1`；
Nature 子刊与 PNAS 的当期目录是**期刊编辑部自己出的目录**，与包里 `rss-nature-geoscience` 同一档，
定 `T1_5`。`owner_entity_id` 只用 `industry/taxonomy.ts` 的 `ENTITIES` 键（`tests/industry-pack-sources.test.ts`
逐条断言），所以 EUMETSAT / IFRC / CMS / Nature / PNAS 一律留 `null`，CAS 用 `cas`。
**EUMETSAT 的条目 `<link>` 是 `http://` 明文**——不改写（改写等于替读者决定跳转），出站由对方站点自己 301。

**上线后的对账（2026-10-07 上午，生产库）**：`scripts/seed.ts` 报 `9 added, 104 already there`，
`sources` 现 **117 行 / 100 条启用**——117 = 包里 113 + **4 条不在包里的停用遗留**：`cn-people-intl` /
`cn-people-politics` / `cn-people-scitech`（人民网那三条公开 feed，实测最新一条分别停在 2025-06-03 /
2025-06-04 / 2021-02-01，是停更快照）与 `cn-web-geog-toc`（试接地理学报）。四条都是 `enabled=false`，
不采集、不发布，所以留着不影响读者；要清掉用 `scripts/delete-sources.ts`，那是删数据，未获授权不动。
九条新源在生产各已真抓一次：`eumetsat 10 / cams 10 / natwater 8 / natsustain 8 / natfood 8 /
pnas 87 / ifrc 10 / cms 10 / cas-syky 15`，`last_error` 全空、`published_at` 无空值，
CAS 那 15 条标题全部含中文，其余为英文（进编辑管道等中文稿）。


## 第五十六轮新增的 95 条（2026-10-09，学术前沿，逐条在采集机实测）

站长这一轮的要求是「增加『前沿地理』板块，搜集学术界的前沿优秀科研成果，信息源一定要全，越多越好」。
15 路只读发现代理交出 **256 条候选**，全部先在采集器所在那台服务器上重跑一遍才算数（本机 DNS 走代理会返回
fake-IP，本机的"能打开"不作数——这一轮就有一条 Nature 子刊在本机是好的、采集机侧回 "Client Challenge"）。
探测用的是项目自己的默认 UA（`GEOHOTBot`）、**不伪造浏览器 UA、不枚举对端 id**，4xx 不重试。

**判据（四条同时成立才登记）**：HTTP 200；解析得出 ≥1 条 item；最新一条在 45 天以内；
**条目自带摘要**（`description` / `dc:description` 剥标签后 ≥80 字）。最后一条是这一轮新加的硬杠：
本站只出「标题 + 摘要 + 原文链接」（`site_fulltext=false`），而英文条目要过中文闸门必须有可译的正文——
Elsevier 的 `rss.sciencedirect.com` 与 Taylor & Francis 的 feed 实测**只有卷期/作者/DOI、没有摘要**，
接进来只会产出一批永远发不出去的条目，所以整族本轮不接（逐条实测值记在下面与 `rejects` 段）。

**登记 95 条**：tier 分布 T1_5 63 / T1 22 / T2 10；
默认分类 （模型判） 64 / frontier 31
（期刊当期目录一律留 `null` 交给模型判——一条古气候论文该归「历史地理」还是「前沿地理」是编辑判断，
不是信源属性；只有预印本线、学会研究进展、机构科研动态这类"整条源都是研究进展"的才兜底成「前沿地理」）。
每条都按包内既有期刊源的形状登记：`allowUrlPrefixes`（Nature 只留 `/articles/`、Wiley 只留 `/doi/`、
arXiv 只留 `/abs/`）、`ingestNoiseFilter.dropMarkersTitleOnly`（实测这批 feed 里真的出现过的
`Author Correction` / `Corrigendum` / `Publisher Correction` / `Editorial` / `Issue Information` /
`Addendum` / `Book Review`）、`_aihot.initialBackfillLimit` 6–8 且 `intervalMinutesLocked: true`。

| id | 信源 | 类型 | 采集机实测 | 归到 |
|---|---|---|---|---|
| `rss-nature-comm-toc` | Nature Communications · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-09（0 天前） · 摘要最长 701 字 | （模型判） |
| `rss-sci-reports-geoscience` | Scientific Reports · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-09（0 天前） · 摘要最长 596 字 | （模型判） |
| `rss-npj-climate-atmos-sci` | npj Climate and Atmospheric Science · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-08（1 天前） · 摘要最长 990 字 | （模型判） |
| `rss-nature-energy` | Nature Energy · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-07（2 天前） · 摘要最长 518 字 | （模型判） |
| `rss-npj-climate-action` | npj Climate Action · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-05（4 天前） · 摘要最长 2294 字 | （模型判） |
| `rss-palcomms-hss` | Humanities and Social Sciences Communications · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-08（1 天前） · 摘要最长 1259 字 | （模型判） |
| `rss-grl-toc` | Geophysical Research Letters · 当期目录 | rss | 200 · 67 条 · 最新 2026-10-09（0 天前） · 摘要最长 1279 字 | （模型判） |
| `rss-jgr-solid-earth-toc` | JGR: Solid Earth · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 1917 字 | （模型判） |
| `rss-jgr-atmospheres-toc` | JGR: Atmospheres · 当期目录 | rss | 200 · 28 条 · 最新 2026-10-09（0 天前） · 摘要最长 1731 字 | （模型判） |
| `rss-jgr-oceans-toc` | JGR: Oceans · 当期目录 | rss | 200 · 26 条 · 最新 2026-10-09（0 天前） · 摘要最长 1750 字 | （模型判） |
| `rss-jgr-biogeosciences-toc` | JGR: Biogeosciences · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 1972 字 | （模型判） |
| `rss-jgr-earth-surface-toc` | JGR: Earth Surface · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-09（0 天前） · 摘要最长 1914 字 | （模型判） |
| `rss-jgr-space-physics-toc` | JGR: Space Physics · 当期目录 | rss | 200 · 18 条 · 最新 2026-10-09（0 天前） · 摘要最长 1934 字 | （模型判） |
| `rss-jgr-ml-comp-toc` | JGR: Machine Learning and Computation · 当期目录 | rss | 200 · 40 条 · 最新 2026-10-09（0 天前） · 摘要最长 2035 字 | （模型判） |
| `rss-g3-toc` | Geochemistry, Geophysics, Geosystems (G3) · 当期目录 | rss | 200 · 16 条 · 最新 2026-10-09（0 天前） · 摘要最长 1981 字 | （模型判） |
| `rss-wrr-toc` | Water Resources Research · 当期目录 | rss | 200 · 18 条 · 最新 2026-10-09（0 天前） · 摘要最长 1895 字 | （模型判） |
| `rss-paleocean-paleoclim-toc` | Paleoceanography and Paleoclimatology · 当期目录 | rss | 200 · 5 条 · 最新 2026-10-09（0 天前） · 摘要最长 1871 字 | （模型判） |
| `rss-tectonics-toc` | Tectonics · 当期目录 | rss | 200 · 4 条 · 最新 2026-10-09（0 天前） · 摘要最长 1883 字 | （模型判） |
| `rss-space-weather-toc` | Space Weather · 当期目录 | rss | 200 · 7 条 · 最新 2026-10-09（0 天前） · 摘要最长 1879 字 | （模型判） |
| `rss-reviews-geophysics-toc` | Reviews of Geophysics · 当期目录 | rss | 200 · 2 条 · 最新 2026-10-09（0 天前） · 摘要最长 1987 字 | （模型判） |
| `rss-earths-future-toc` | Earth's Future · 当期目录 | rss | 200 · 14 条 · 最新 2026-10-09（0 天前） · 摘要最长 2060 字 | （模型判） |
| `rss-agu-advances-toc` | AGU Advances · 当期目录 | rss | 200 · 3 条 · 最新 2026-10-09（0 天前） · 摘要最长 1573 字 | （模型判） |
| `rss-james-toc` | Journal of Advances in Modeling Earth Systems · 当期目录 | rss | 200 · 9 条 · 最新 2026-10-09（0 天前） · 摘要最长 1892 字 | （模型判） |
| `rss-agu-this-week` | AGU · This Week from AGU（期刊周导读） | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 95 字 | 前沿地理 |
| `rss-eos-editors-highlights` | Eos（AGU）· 编辑精选 | rss | 200 · 15 条 · 最新 2026-10-07（2 天前） · 摘要最长 200 字 | 前沿地理 |
| `rss-ess-toc` | Earth and Space Science · 当期目录 | rss | 200 · 7 条 · 最新 2026-10-09（0 天前） · 摘要最长 1800 字 | （模型判） |
| `rss-geohealth-toc` | GeoHealth · 当期目录 | rss | 200 · 6 条 · 最新 2026-10-09（0 天前） · 摘要最长 1858 字 | （模型判） |
| `rss-gbc-toc` | Global Biogeochemical Cycles · 当期目录 | rss | 200 · 8 条 · 最新 2026-10-09（0 天前） · 摘要最长 1829 字 | （模型判） |
| `rss-radio-science-toc` | Radio Science · 当期目录 | rss | 200 · 2 条 · 最新 2026-10-09（0 天前） · 摘要最长 1734 字 | （模型判） |
| `rss-pass-toc` | Perspectives of Earth and Space Scientists · 当期目录 | rss | 200 · 21 条 · 最新 2026-10-09（0 天前） · 摘要最长 1715 字 | （模型判） |
| `rss-community-science-toc` | Community Science · 当期目录 | rss | 200 · 6 条 · 最新 2026-10-09（0 天前） · 摘要最长 1926 字 | （模型判） |
| `rss-eos-research-spotlights` | Eos（AGU）· 研究聚焦 | rss | 200 · 15 条 · 最新 2026-10-08（1 天前） · 摘要最长 168 字 | 前沿地理 |
| `rss-eos-landslide-blog` | Eos（AGU）· 滑坡博客 | rss | 200 · 15 条 · 最新 2026-10-08（1 天前） · 摘要最长 378 字 | 前沿地理 |
| `rss-copernicus-tc` | The Cryosphere · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 935 字 | （模型判） |
| `rss-copernicus-bg` | Biogeosciences · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-08（1 天前） · 摘要最长 886 字 | （模型判） |
| `rss-copernicus-hess` | Hydrology and Earth System Sciences · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 908 字 | （模型判） |
| `rss-copernicus-se` | Solid Earth · 当期目录 | rss | 200 · 20 条 · 最新 2026-09-29（10 天前） · 摘要最长 939 字 | （模型判） |
| `rss-copernicus-os` | Ocean Science · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-08（1 天前） · 摘要最长 770 字 | （模型判） |
| `rss-copernicus-acp` | Atmospheric Chemistry and Physics · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 971 字 | （模型判） |
| `rss-copernicus-nhess` | Natural Hazards and Earth System Sciences · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-07（2 天前） · 摘要最长 901 字 | （模型判） |
| `rss-copernicus-gmd` | Geoscientific Model Development · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 1030 字 | （模型判） |
| `rss-copernicus-cp` | Climate of the Past · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-08（1 天前） · 摘要最长 902 字 | （模型判） |
| `rss-copernicus-essd` | Earth System Science Data · 当期目录 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 1143 字 | （模型判） |
| `rss-egusphere` | EGUsphere（EGU 预印本与讨论稿） | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 996 字 | 前沿地理 |
| `rss-egu-announcements` | EGU · 公告与分会消息 | rss | 200 · 10 条 · 最新 2026-09-21（18 天前） · 摘要最长 850 字 | 前沿地理 |
| `rss-egu-highlight-articles` | EGU · 各刊主编精选研究 | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 930 字 | 前沿地理 |
| `rss-arxiv-ao-ph` | arXiv · 大气与海洋物理（physics.ao-ph） | rss | 200 · 8 条 · 最新 2026-10-09（0 天前） · 摘要最长 1790 字 | 前沿地理 |
| `rss-arxiv-geo-ph` | arXiv · 地球与行星物理（physics.geo-ph） | rss | 200 · 6 条 · 最新 2026-10-09（0 天前） · 摘要最长 1957 字 | 前沿地理 |
| `rss-arxiv-space-ph` | arXiv · 空间物理（physics.space-ph） | rss | 200 · 3 条 · 最新 2026-10-09（0 天前） · 摘要最长 1793 字 | 前沿地理 |
| `rss-eartharxiv-preprints` | EarthArXiv · 地球科学预印本 | rss | 200 · 10 条 · 最新 2026-10-09（0 天前） · 摘要最长 405 字 | 前沿地理 |
| `rss-rgs-geographical-journal-toc` | The Geographical Journal（RGS-IBG 会刊）· 当期目录 | rss | 200 · 9 条 · 最新 2026-10-09（0 天前） · 摘要最长 2506 字 | （模型判） |
| `rss-rgs-tibg-toc` | Transactions of the IBG（RGS-IBG 会刊）· 当期目录 | rss | 200 · 2 条 · 最新 2026-10-09（0 天前） · 摘要最长 2630 字 | （模型判） |
| `rss-rgs-area-toc` | Area（RGS-IBG 会刊）· 当期目录 | rss | 200 · 5 条 · 最新 2026-10-09（0 天前） · 摘要最长 1699 字 | （模型判） |
| `rss-rgs-geo-toc` | Geo: Geography and Environment（RGS-IBG OA 会刊）· 当期目录 | rss | 200 · 13 条 · 最新 2026-10-09（0 天前） · 摘要最长 2516 字 | （模型判） |
| `rss-cag-canadian-geographies-toc` | Canadian Geographies / Géographies canadiennes（CAG 会刊）· 当期目录 | rss | 200 · 4 条 · 最新 2026-10-09（0 天前） · 摘要最长 3198 字 | （模型判） |
| `rss-nzgs-nz-geographer-toc` | New Zealand Geographer（NZGS 会刊）· 当期目录 | rss | 200 · 6 条 · 最新 2026-10-09（0 天前） · 摘要最长 812 字 | （模型判） |
| `rss-kngg-jehg-toc` | J. of Economic and Human Geography（KNGG/NAGI 会刊）· 当期目录 | rss | 200 · 48 条 · 最新 2026-10-09（0 天前） · 摘要最长 1147 字 | （模型判） |
| `rss-rgs-wires-climate-change-toc` | WIREs Climate Change（综述刊）· 当期目录 | rss | 200 · 5 条 · 最新 2026-10-09（0 天前） · 摘要最长 2765 字 | （模型判） |
| `rss-nsf-news` | 美国国家科学基金会 NSF · 新闻 | rss | 200 · 15 条 · 最新 2026-10-08（1 天前） · 摘要最长 250 字 | 前沿地理 |
| `rss-gfz-newsroom` | 德国地球科学研究中心 GFZ · 新闻室 | rss | 200 · 20 条 · 最新 2026-10-09（0 天前） · 摘要最长 196 字 | 前沿地理 |
| `rss-geomar-news` | GEOMAR 亥姆霍兹基尔 · 科研动态 | rss | 200 · 30 条 · 最新 2026-10-09（0 天前） · 摘要最长 882 字 | 前沿地理 |
| `rss-bgs-news` | 英国地质调查局 BGS · 新闻 | rss | 200 · 8 条 · 最新 2026-10-05（4 天前） · 摘要最长 398 字 | 前沿地理 |
| `rss-eth-zurich-news` | 苏黎世联邦理工学院 ETH · 新闻 | rss | 200 · 100 条 · 最新 2026-10-08（1 天前） · 摘要最长 307 字 | 前沿地理 |
| `rss-fmi-articles` | 芬兰气象研究所 FMI · 文章（芬兰语） | rss | 200 · 10 条 · 最新 2026-10-06（3 天前） · 摘要最长 3430 字 | 前沿地理 |
| `rss-ecmwf-science-blog` | ECMWF · 科学博客 | rss | 200 · 10 条 · 最新 2026-09-07（32 天前） · 摘要最长 358 字 | 前沿地理 |
| `rss-camgeog-news` | 剑桥大学地理系 · 科研新闻 | rss | 200 · 24 条 · 最新 2026-10-09（0 天前） · 摘要最长 990 字 | 前沿地理 |
| `rss-exeter-geog-news` | 埃克塞特大学环境科学与经济系 · 地理新闻 | rss | 200 · 10 条 · 最新 2026-10-07（2 天前） · 摘要最长 288 字 | 前沿地理 |
| `rss-scripps-news` | 斯克里普斯海洋研究所 Scripps · 新闻 | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 3738 字 | 前沿地理 |
| `rss-byrd-polar-news` | 俄亥俄州立大学 Byrd 极地与气候研究中心 · 新闻 | rss | 200 · 10 条 · 最新 2026-10-04（5 天前） · 摘要最长 364 字 | 前沿地理 |
| `rss-mcgill-geog-news` | 麦吉尔大学地理系 · 科研新闻 | rss | 200 · 6 条 · 最新 2026-10-07（2 天前） · 摘要最长 544 字 | 前沿地理 |
| `rss-psu-news` | 宾夕法尼亚州立大学 · 科研新闻 | rss | 200 · 16 条 · 最新 2026-10-07（2 天前） · 摘要最长 443 字 | 前沿地理 |
| `rss-oxford-sge-sitefeed` | 牛津大学地理与环境系 · 新闻 | rss | 200 · 10 条 · 最新 2026-10-09（0 天前） · 摘要最长 2559 字 | 前沿地理 |
| `rss-whoi-news` | 伍兹霍尔海洋研究所 WHOI · 新闻 | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 200 字 | 前沿地理 |
| `rss-mbari-news` | 蒙特雷湾水族馆研究所 MBARI · 新闻 | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 501 字 | 前沿地理 |
| `rss-scar-news` | 南极研究科学委员会 SCAR · 新闻 | rss | 200 · 10 条 · 最新 2026-10-07（2 天前） · 摘要最长 141 字 | 前沿地理 |
| `rss-imos-news` | 澳洲海洋观测系统 IMOS · 新闻 | rss | 200 · 10 条 · 最新 2026-09-24（15 天前） · 摘要最长 336 字 | 前沿地理 |
| `rss-grss-news` | IEEE 地球科学与遥感学会 GRSS · 新闻 | rss | 200 · 10 条 · 最新 2026-10-06（3 天前） · 摘要最长 518 字 | 前沿地理 |
| `rss-earthscope-news` | EarthScope Consortium（原 IRIS）· 新闻 | rss | 200 · 10 条 · 最新 2026-10-06（3 天前） · 摘要最长 443 字 | 前沿地理 |
| `rss-sciencenews-earth` | Science News · 地球板块 | rss | 200 · 20 条 · 最新 2026-10-08（1 天前） · 摘要最长 115 字 | （模型判） |
| `rss-theconversation-geology` | The Conversation · 地质学话题 | rss | 200 · 25 条 · 最新 2026-10-08（1 天前） · 摘要最长 167 字 | （模型判） |
| `rss-theconversation-climate-science` | The Conversation · 气候科学话题 | rss | 200 · 25 条 · 最新 2026-10-09（0 天前） · 摘要最长 148 字 | （模型判） |
| `rss-newswise-scinews` | Newswise · 科学新闻稿（转载层） | rss | 200 · 25 条 · 最新 2026-10-09（0 天前） · 摘要最长 884 字 | （模型判） |
| `rss-sciencedaily-fossils-ruins` | ScienceDaily · 古生物与遗址（转载层） | rss | 200 · 60 条 · 最新 2026-10-08（1 天前） · 摘要最长 522 字 | （模型判） |
| `rss-sciencedaily-space-time` | ScienceDaily · 空间与时间（转载层） | rss | 200 · 60 条 · 最新 2026-10-08（1 天前） · 摘要最长 497 字 | （模型判） |
| `rss-phys-org-earth-sciences` | Phys.org · 地球科学（转载层） | rss | 200 · 30 条 · 最新 2026-10-09（0 天前） · 摘要最长 514 字 | （模型判） |
| `rss-phys-org-planetary-sciences` | Phys.org · 行星科学（转载层） | rss | 200 · 30 条 · 最新 2026-10-08（1 天前） · 摘要最长 592 字 | （模型判） |
| `rss-earthsky-news` | EarthSky · 天文与地球新闻 | rss | 200 · 10 条 · 最新 2026-10-09（0 天前） · 摘要最长 263 字 | （模型判） |
| `rss-yale-climate-connections` | Yale Climate Connections · 气候研究报道 | rss | 200 · 10 条 · 最新 2026-10-08（1 天前） · 摘要最长 188 字 | （模型判） |
| `rss-geb-toc` | Global Ecology and Biogeography · 当期目录 | rss | 200 · 10 条 · 最新 2026-10-09（0 天前） · 摘要最长 2486 字 | （模型判） |
| `rss-ijc-toc` | International Journal of Climatology · 当期目录 | rss | 200 · 92 条 · 最新 2026-10-09（0 天前） · 摘要最长 2823 字 | （模型判） |
| `rss-tgis-wiley-toc` | Transactions in GIS · 当期目录 | rss | 200 · 15 条 · 最新 2026-10-09（0 天前） · 摘要最长 1902 字 | （模型判） |
| `rss-gcb-toc` | Global Change Biology · 当期目录 | rss | 200 · 27 条 · 最新 2026-10-09（0 天前） · 摘要最长 2704 字 | （模型判） |
| `rss-phg-toc` | Progress in Human Geography · 当期目录 | rss | 200 · 47 条 · 最新 2026-10-01（8 天前） · 摘要最长 340 字 | （模型判） |
| `rss-ppg-toc` | Progress in Physical Geography: Earth and Environment · 当期目录 | rss | 200 · 37 条 · 最新 2026-10-08（1 天前） · 摘要最长 366 字 | （模型判） |
| `rss-ijgis-toc` | International Journal of Geographical Information Science · 当期目录 | rss | 200 · 81 条 · 最新 2026-10-08（1 天前） · 摘要最长 145 字 | （模型判） |

### 这一轮量到的平台事实（写给下一轮，别重新试一遍）

- **Wiley / AGU**：期刊页 HTML 对 `GEOHOTBot` 一律 403（Cloudflare challenge），但
  `onlinelibrary.wiley.com/feed/<ISSN 去连字符>/most-recent` 通，摘要在 **`dc:description`** 而不是
  `description`；ISSN 校验位 X 必须小写（`2576604x`），后缀只有 `most-recent`（`latest` 404）。
- **Copernicus / EGU**：十本刊的 `<刊>.copernicus.org/xml/rss2_0.xml` 全部 200、每轮 20 条、带摘要。
  **EGUsphere 的 RSS 时间戳是请求时生成的**（两次实取的 20 条 `pubDate` 秒数随请求时刻跳），
  所以"最新日期"不能当水位用；EGU 主站 `egu.eu` 对部分代理路径 403、采集机侧通。
- **arXiv**：`rss.arxiv.org/rss/<类别>` 当日出批，feed 里有 `<arxiv:announce_type>`
  （new / cross / replace / replace-cross），实测约三分之一是旧论文重公告；**不新增过滤项**——
  重公告的 `<link>` 与首发同 URL，`identityKeyForUrl` 按地址判重，天然吸收。
  三条同源变体（`ao-ph+geo-ph` 合并 feed、`export.arxiv.org/api` 的 API 形状）本轮**不接**，
  同一批论文数三遍会把热度算歪。
- **Taylor & Francis / Elsevier / Springer**：T&F 的公开 feed 短码族 `tandfonline.com/feed/rss/<短码>`
  实测 200（A 路代理曾据带连字符 ISSN 判"整族 404"，是写法问题不是站点问题）；
  Elsevier `rss.sciencedirect.com/publication/science/<无连字符 ISSN>` 通但**没有摘要**、
  且 `description` 里的 "Publication date" 常是**未来的封面日期**（实测见到 2027-01、2027-02），
  所以按上面的第二条判据整族不接；Springer `link.springer.com/search.rss?facet-journal-id=<id>`
  有摘要、有真 `pubDate`，本轮接了 Climatic Change 等五刊。
- **MDPI / IEEE Xplore**：对默认 UA 全站 403 / 418，不伪装 UA 就没有接法，本轮零条。
- **中文学术站**：Magtech 平台（地理学报 / 地球信息科学学报等）的 RSS 端点存在但对裸客户端返回
  人机验证页，服务端渲染的 `home.shtml` 当期列表可读——这类只能走 `web_list`，
  而 `web_list` 的选择器要逐条核，本轮**没有**把中文期刊接进来（留下一批，与 Crossref 那 23 条 json_list 一起）。
- **现有信源的一条健康告警**（发现代理报、采集机侧待复核）：包内 `rss-igu-online`（国际地理联合会）
  两次直连都只拿到 200 的 "One moment, please…" JS 挑战壳，**没有一条 item**。按
  `intl-unocha` 的先例，复核后应当停用而不是留着空跑。
  **第五十七轮复核：这条告警不成立，源是活的，不要停用。** 2026-10-09 19:33 从生产库读它自己的账：
  13 次抓取、`found` 累计 20、`new` 累计 10、库里 10 条条目、`health=ok`、`fail_count=0`，最近一轮是 304
  `notModified`；同一分钟在采集机上直连 `https://igu-online.org/feed/` 拿到 200 + 42 KB 真 XML、10 条 item、
  最新一条 2026-10-06、`content:encoded` 中位 2923 字。那两个 "One moment, please…" 是发现代理那一次
  撞上的偶发挑战壳，不是这个 feed 的常态——**一次抓不到就推断"该停用"是错的，要看这条源自己的运行账**。

### 本轮明确没接的（点名，免得下一轮重新试）

无摘要的 Elsevier / T&F 整族（13 条实测通但过不了第二条判据）；采集机侧被挡的
`nature.com/natrevearthenviron.rss`、`iiasa.ac.at`、`lamont.columbia.edu`、`mdpi.com`、`eurekalert.org`；
停更超过 45 天的 45 条（含 `psl.noaa.gov/news` 停在 2017、`oceanservice.noaa.gov/news` 停在 2015、
`climate.gov` 停在 2025-06、`ipgp.fr` 停在 2022）；SPA / 前端模板的中文站（SciEngine《中国科学:地球科学》、
河口海岸、地震学报 `/article/current` 的 HTML 里是 `{{basePath}}`）；企业研究院整刊博客
（Google Research、Microsoft Research——地理占比极低，接进来只会喂给预筛一堆 BLOCK）；
以及三条与已接源同内容/超集的重复形状（arXiv 合并 feed、GRSS 分类 feed、Newswise 的 feedburner 镜像）。

## 第五十七轮：巡检上一轮 95 条 + 再挂 12 条（2026-10-09 晚，逐条采集机实测）

这一轮的开头不是找新源，而是**核对第五十六轮那句"105 ok / 1 条 fetch failed"**。那句话只看了 `health` 与
`last_error`，而这两列对"抓到了但一条没存"和"这周确实没新东西"是同一种脸色。把 95 条首次导入的
`fetch_runs.detail` 逐条拉出来看（`found / filtered / dropped / stored` 四个数对读），当场翻出两个静默缺陷：

**① Wiley 的每条刊不在 `onlinelibrary.wiley.com` 上，而在学会子域。** 六条刊的目录 feed 首次导入是
`found 92/13/9/5/5/2 → filtered 0 → stored 0`：本包当时统一写的 `allowUrlPrefixes` 是
`onlinelibrary.wiley.com/doi/` 加 `agupubs.` 两条，而 International Journal of Climatology（英国皇家气象学会）
的条目链接是 `https://rmets.onlinelibrary.wiley.com/doi/10.1002/joc.…`，RGS-IBG 四刊是 `rgs-ibg.`，
WIREs 是 `wires.`——**前缀不匹配，`allowed()` 把整个列表判成站外，一条不剩，而 `health` 仍是 ok**。
改法是逐条把该刊自己的子域写进 allow（不是放开通配：这一列是入口白名单，写宽一格就多一格可 ingest 的地址）。
同形制的 30 多条 AGU/Nature 源不受影响，因为它们的链接本来就落在写好的两个主机上。

**② `<title>` 里放未转义 HTML 的 feed，会被解析成"结构"，于是条目被当作无标题丢掉。**
Byrd 极地中心与 ECMWF 两条首次导入是 `found 0`——但直接在采集机上取同一地址能拿到 200 + 7.9 KB / 7.4 KB
真 RSS、各 10 条 item。差别在 Drupal 的写法：`<title><a href="/news/…">标题正文</a></title>`。这是合法 XML，
`fast-xml-parser` 交回一个对象节点而不是字符串，`rss.ts` 的 `text()` 只认 `#text`/`#cdata`，于是返回空串，
`rss.ts` 里那句 `if (!link || !title) continue`（不写行号：它会随每次改动漂） 把十条全丢掉；而 `collect.ts` 里 `found = candidates.length` 记的是**解析器的产出**
（在 `applySourceFilters` 之前），所以运行记录上写着 `found: 0`、`health: ok`——原始 feed 里明明躺着 10 条。**修法两处**：`text()` 在没有文本节点时递归读子节点（标题取词、`stripTags` 照旧收尾），
以及新增一条"这条 feed 有 item 但一条都读不出来"就明确判失败的闸门——后者今日零影响面（全库扫过：
`found_all=0` 的启用源只有这两条，都是本轮新增），但它正是这一类缺陷唯一的可见方式。
修完用采集机上当真取回的 `byrd.xml` / `ecmwf.xml` 两份字节复跑解析器：**各 10 条、标题干净、日期与摘要都在**。

**③ 一条永远重复的源**。`rss-phys-org-earth-sciences`（Phys.org 地球科学分栏）首次导入 `found 30 → kept 8 → stored 0`，
而 8 条全部命中 `article_discoveries`：它的父栏 `rss-phys-org-earth`（`/rss-feed/earth-news/`）把它们全包了。
分栏是父栏的子集，这条源从结构上就不可能带来新东西 ⇒ **包内删除该条**，库里那一行留着（它没有自己的条目，
删除会连带影响发现记录），下一轮部署由 `scripts/set-source-state.ts` 停用。

**这一轮接进去的 12 条**（每条都是采集机上亲眼取到 XML、条目数与日期与摘要字段都记下来的；
`实测` 那一列就是当次取到的字节，不是代理的转述）：

| id | 名称 | feed | 实测 | 摘要在哪 | 条目链接主机 | tier/间隔 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-wwa-attribution` | World Weather Attribution · 事件归因研究发布 | `worldweatherattribution.org/feed/` | 200 · 10 条 · 最新 2026-09-16 | `content:encoded` 中位 9449 字 | `www.worldweatherattribution.org` | T1_5/720 |
| `rss-mercator-news` | Mercator Ocean International · 海洋与气候新闻 | `mercator-ocean.fr/feed/` | 200 · 12 条 · 最新 2026-10-06 | `content:encoded` 中位 4948 字 | **`www.mercator-ocean.eu`**（feed 在 .fr、链接在 .eu） | T1/720 |
| `rss-wcrp-climate-news` | WCRP 世界气候研究计划 · Climate News | `feeds.feedburner.com/WCRP-Climate-News` | 200 · 10 条 · 最新 2026-10-07 | `description` 中位 812 字 | `www.wcrp-climate.org` | T2/720 |
| `rss-jawra-toc` | JAWRA（美国水资源协会会刊）· 当期目录 | `onlinelibrary.wiley.com/feed/17521688/most-recent` | 200 · 8 条 · 最新 2026-09-30 | `dc:description` 中位 1510 字 | `onlinelibrary.wiley.com` | T1_5/240 |
| `rss-geobiology-toc` | Geobiology · 当期目录 | `…/feed/14724669/most-recent` | 200 · 12 条 · 最新 2026-10-08 | `dc:description` 中位 1824 字 | 同上 | T1_5/240 |
| `rss-palaeontology-toc` | Palaeontology（英国古生物学会会刊）· 当期目录 | `…/feed/14754983/most-recent` | 200 · 6 条 · 最新 2026-09-29 | `dc:description` 中位 1464 字 | 同上 | T1_5/240 |
| `rss-sedimentology-toc` | Sedimentology（国际沉积学家协会会刊）· 当期目录 | `…/feed/13653091/most-recent` | 200 · 31 条 · 最新 2026-10-05 | `dc:description` 中位 2181 字 | 同上 | T1_5/240 |
| `rss-terranova-toc` | Terra Nova（构造地质）· 当期目录 | `…/feed/13653121/most-recent` | 200 · 19 条 · 最新 2026-10-07 | `dc:description` 中位 1072 字 | 同上 | T1_5/240 |
| `rss-antipode-toc` | Antipode（批判地理学与政治地理学刊）· 当期目录 | `…/feed/14678330/most-recent` | 200 · 12 条 · 最新 2026-10-07 | `dc:description` 中位 1129 字（`description` 只有卷期行） | 同上 | T1_5/240 |
| `rss-piahs-articles` | PIAH（国际水文科学学会会议论文集）· 近期文章 | `piahs.copernicus.org/xml/rss2_0.xml` | 200 · 20 条 · 最新 2026-09-24 | `description`＝题录块 + 摘要起句（862 字） | **`doi.org`** ⇒ allow 写死 `https://doi.org/10.5194/piahs-` | T2/1440 |
| `rss-epb-toc` | Environment and Planning B: Urban Analytics and City Science · 当期目录 | `journals.sagepub.com/action/showFeed?type=etoc&feed=rss&jc=epb` | 200 · 114 条 · **全表最大日期 2026-10-08** | `content:encoded`（112/114 条 >200 字） | `journals.sagepub.com/doi/abs/…?af=R` | T1_5/1440 |
| `rss-dhg-toc` | Dialogues in Human Geography · 当期目录 | `…&jc=dhg` | 200 · 193 条 · 最大日期 2026-10-07 | `content:encoded`（142/193） | 同上 | T1_5/1440 |

**SAGE 那两条差点被本轮判死**，原因值得单独记：etoc feed 的条目**不是按日期排的**（第一条是 2025-12，
最后一组才是 2026-10）。按"第一条的日期"量新旧，两条都会以"停更 300 天"被退回；把 114/193 条的日期
全量解析取最大，才发现它们最新稿是昨天。因此这两条登记时加了 `sortByPublishedAt: true`——
`applySourceFilters` 会先按发布日期排序再截断，首次导入取到的才是 8 条**最新**而不是列表开头的 8 条旧刊。
**"最新一条"必须扫全部条目，不能取第一条**：这一条现在同时写在这里与 `docs/known-issues.md`。

**退回的（点名 + 实测值，下一轮别再试）**：

| 候选 | 采集机实测 | 结论 |
| --- | --- | --- |
| `onlinelibrary.wiley.com/feed/14350157/most-recent`（代理报"International Journal of Information Systems，25 条有摘要"） | **HTTP 404** | 未接。代理那侧看到的字节不作数 |
| `onlinelibrary.wiley.com/feed/14679493/most-recent`（Singapore J. Tropical Geography） | 200 · 30 条 · 只有 8 条 >200 字；首条 `Referees for July 2025–June 2026`，EarlyView 条的 `description` 只有 51 字"…EarlyView." | 未接（无摘要为主）。`Referees` 已加进本轮 SAGE 两条的噪声词 |
| `onlinelibrary.wiley.com/feed/17455871/most-recent`（Geographical Research） | 200 · 13 条 · 7 条有摘要 · 最新 2026-07-13（88 天） | 未接：过不了 45 天与"条条有摘要"两条杠 |
| `cartographicperspectives.org/…/WebFeedGatewayPlugin/rss2`（NACIS） | 200 · 16 条 · 只有 3 条 >200 字 · 最新 2026-06-09 | 未接 |
| `erdkunde-online.de/feed/`（德国地理学会） | 200 · 20 条 · 摘要有 · **最新 2026-02-04**，首条 `Sommerurlaub auf Kuba`（散文） | 未接：停更 8 个月 + 内容是散文不是研究进展 |
| `journals.sagepub.com/…&jc=epa` / `…&jc=11598` / `facet-journal-id=13578` | 200 但分别是 AERA 的教育评估刊、考古刊、生物医学刊 | 未接：**jc / journal-id 不能由刊名或 ISSN 推**，逐条从文章页自链取并核对 channel 标题 |
| Springer `link.springer.com/search.rss?…`（Bulletin of Volcanology 445、PalZ 12542、Mineralium Deposita 126、Climatic Change 10584、TAC 704、KN 42489） | 本轮两次探测**全部 200 + 3036 字节 `Client Challenge` HTML**，0 条 item；同形制 40 分钟前由发现代理取到过 20 条真 XML | 本轮不接：限流是时段性的，**未取到字节就不登记**。下一轮错峰重试（不换 UA、不试号） |
| `meteofrance.com/rss.xml` | 200 · 10 条 · `description` 中位 14077 字（全站正文塞进摘要） | 未接：内容是法语气象科普栏目（`/meteo-a-z/`、热浪影响专栏），不是科研发布，方向不对 |

**包内现状**：271 条（第五十七轮 218 → 第五十八轮 +53），`rss` 226、`web_list` 26、
`json_list` 3、`external` 8、`x_search` 8；启用 258；`defaultCategory=frontier` 35 条。

**顺带修好的一条境内源**：`web-pric-news`（中国极地研究中心）连败 9 轮，错误写着 `no items matched (html)`。
两层原因：① 它原指的首页改版后 HTML 里 `c_show_id_` 出现 **0 次**；② 更根本的是 `web-list.ts:75` 的
`listingItself()` 只比 `host + pathname`、把 query 丢了，而这个站整站走 `/index.php?c=…&id=…` 一条路径，
于是每条文章链接都被判成"列表页自己"。判据改成：列表页自带的每个 query 键值**都还在**才算本页
（`&page=2` 仍是本页；`?c=show&id=3501` 是文章）。之后把它重指到站点自己导航里的 `科技进展` 栏目
`https://www.pric.org.cn/index.php?c=category&id=89`（`itemSelector: li.gsgg-item` /
`linkSelector: a[href*='c=show']` / `titleSelector: .gsgg-title h3` / `publishedAtSelector: .gsgg-time`），
实测 5 条、最新 2026-09-15，日期与中文导语都是服务端直出，首条即
「极地中心在北极海冰干舷高度高分辨率反演方法研究中取得重要进展」。
**这一修的适用面比一条源大**：境内机构站按查询串路由的非常多，修之前它们不可能接成 `web_list` 信源。


## 第五十八轮：第三批学术信源 53 条，以及"量具自己也要被量"（2026-10-09 深夜，逐条采集机实测）

本轮把信源包从第五十七轮的 **218 条推到 271 条**（+53，全部是 `rss`），口径与上一轮同一把尺子，三条同时成立才登记：
**45 天内有稿**（取全部条目里最大的那个日期，不取第一条）、**摘要中位 ≥200 字**（六个字段 `description` / `dc:description` /
`content:encoded` / `summary` / Atom `content` 取最长者）、**目录里每条都读得出可用链接与标题**。
测量全部在采集机上用 `curl -4` 跑（这台 VM 没有 IPv6 出口，见 `docs/known-issues.md` 第五十八轮第一节），
逐条数值如下——这张表由 `/tmp/r58-final.json` 生成，不是从终端记录里抄的。

**Copernicus（27 本，条目链接是 doi.org/10.5194/…）**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-copernicus-esd` | T1_5/240 | 20 | 780 字 | 0 天前 | ESD - recent papers | doi.org |
| `rss-copernicus-ls` | T1_5/240 | 7 | 810 字 | 8 天前 | LS - recent papers | doi.org |
| `rss-copernicus-gc` | T1_5/240 | 20 | 765 字 | 2 天前 | GC - recent papers | doi.org |
| `rss-copernicus-gchron` | T1_5/240 | 20 | 737 字 | 1 天前 | GCHRON - recent papers | doi.org |
| `rss-copernicus-hgss` | T1_5/240 | 20 | 666 字 | 7 天前 | HGSS - recent papers | doi.org |
| `rss-copernicus-angeo` | T1_5/240 | 20 | 759 字 | 8 天前 | ANGEO - recent papers | doi.org |
| `rss-copernicus-amt` | T1_5/240 | 20 | 787 字 | 3 天前 | AMT - recent papers | doi.org |
| `rss-copernicus-ar` | T1_5/240 | 20 | 851 字 | 2 天前 | AR - recent papers | doi.org |
| `rss-copernicus-soil` | T1_5/240 | 20 | 807 字 | 8 天前 | SOIL - recent papers | doi.org |
| `rss-copernicus-wcd` | T1_5/240 | 20 | 746 字 | 3 天前 | WCD - recent papers | doi.org |
| `rss-copernicus-wes` | T1_5/240 | 20 | 770 字 | 0 天前 | WES - recent papers | doi.org |
| `rss-copernicus-eo` | T1_5/240 | 9 | 748 字 | 9 天前 | EO - recent papers | doi.org |
| `rss-copernicus-npg` | T1_5/240 | 20 | 736 字 | 7 天前 | NPG - recent papers | doi.org |
| `rss-copernicus-sp` | T1_5/240 | 20 | 781 字 | 9 天前 | SP - recent papers | doi.org |
| `rss-copernicus-ascmo` | T1_5/240 | 20 | 750 字 | 2 天前 | ASCMO - recent articles | doi.org |
| `rss-copernicus-isprs-annals` | T1_5/240 | 20 | 1920 字 | 10 天前 | ISPRS-ANNALS - recent articles | doi.org |
| `rss-copernicus-isprs-archives` | T1_5/240 | 20 | 1843 字 | 1 天前 | ISPRS-ARCHIVES - recent articles | doi.org |
| `rss-copernicus-egqsj` | T1_5/240 | 20 | 798 字 | 9 天前 | EGQSJ - recent articles | doi.org |
| `rss-copernicus-esurf` | T1_5/240 | 20 | 744 字 | 1 天前 | ESURF - recent papers | doi.org |
| `rss-copernicus-gi` | T1_5/720 | 20 | 800 字 | 1 天前 | GI - recent papers | doi.org |
| `rss-copernicus-gh` | T1_5/720 | 20 | 682 字 | 3 天前 | GH - recent articles | doi.org |
| `rss-copernicus-ejm` | T2/720 | 20 | 779 字 | 2 天前 | EJM - recent articles | doi.org |
| `rss-copernicus-jm` | T2/720 | 20 | 805 字 | 1 天前 | JM - recent articles | doi.org |
| `rss-copernicus-sd` | T2/720 | 20 | 875 字 | 10 天前 | SD - recent articles | doi.org |
| `rss-copernicus-we` | T2/720 | 20 | 776 字 | 1 天前 | WE - recent articles | doi.org |
| `rss-copernicus-asr` | T2/720 | 20 | 727 字 | 1 天前 | ASR - recent articles | doi.org |
| `rss-copernicus-ica-abs` | T2/720 | 20 | 232 字 | 30 天前 | ICA-ABS - recent articles | doi.org |

**Frontiers（6 本）**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-frontiers-remote-sensing` | T1_5/720 | 20 | 1992 字 | 1 天前 | Frontiers in Remote Sensing | New and Recent Articles | www.frontiersin.org |
| `rss-frontiers-climate` | T1_5/720 | 20 | 1781 字 | 2 天前 | Frontiers in Climate | New and Recent Articles | www.frontiersin.org |
| `rss-frontiers-earth-science` | T1_5/720 | 20 | 1773 字 | 1 天前 | Frontiers in Earth Science | New and Recent Articles | www.frontiersin.org |
| `rss-frontiers-marine-science` | T1_5/720 | 20 | 1958 字 | 1 天前 | Frontiers in Marine Science | New and Recent Articles | www.frontiersin.org |
| `rss-frontiers-environmental-science` | T1_5/720 | 20 | 1900 字 | 1 天前 | Frontiers in Environmental Science | New and Recent Articles | www.frontiersin.org |
| `rss-frontiers-sustainable-cities` | T1_5/720 | 20 | 1846 字 | 1 天前 | Frontiers in Sustainable Cities | New and Recent Articles | www.frontiersin.org |

**PLOS（4 本）**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-plos-climate` | T1_5/720 | 30 | 1756 字 | 1 天前 | PLOS Climate | journals.plos.org |
| `rss-plos-sustainability` | T1_5/720 | 30 | 1898 字 | 1 天前 | PLOS Sustainability and Transformation | journals.plos.org |
| `rss-plos-ecosystems` | T1_5/720 | 12 | 1894 字 | 3 天前 | PLOS Ecosystems | journals.plos.org |
| `rss-plos-water` | T1_5/720 | 30 | 1803 字 | 1 天前 | PLOS Water | journals.plos.org |

**Pensoft（3 本）**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-pensoft-oneecosystem` | T1_5/720 | 100 | 1853 字 | 0 天前 | Latest Articles from One Ecosystem | oneecosystem.pensoft.net |
| `rss-pensoft-natureconservation` | T1_5/720 | 100 | 2038 字 | 0 天前 | Latest Articles from Nature Conservation | natureconservation.pensoft.net |
| `rss-pensoft-bdj` | T2/720 | 100 | 1653 字 | 1 天前 | Latest Articles from Biodiversity Data Journal | bdj.pensoft.net |

**OpenEdition / OJS 与学会刊**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-polar-research` | T1_5/720 | 14 | 1262 字 | 8 天前 | Polar Research | polarresearch.net |
| `rss-erdkunde` | T1_5/720 | 6 | 1649 字 | 3 天前 | ERDKUNDE | www.erdkunde.uni-bonn.de |
| `rss-cybergeo` | T1_5/720 | 10 | 1001 字 | 2 天前 | Cybergeo: European Journal of Geography | journals.openedition.org |
| `rss-belgeo` | T2/720 | 10 | 1000 字 | 11 天前 | Belgeo | journals.openedition.org |
| `rss-rga` | T2/720 | 10 | 1001 字 | 23 天前 | Journal of Alpine Research | Revue de géographie alpine | journals.openedition.org |
| `rss-confins` | T2/720 | 10 | 1000 字 | 9 天前 | Confins | journals.openedition.org |
| `rss-ijg-ugm` | T2/720 | 15 | 2058 字 | 30 天前 | Indonesian Journal of Geography | journal.ugm.ac.id |
| `rss-usp-geografia` | T2/720 | 30 | 1543 字 | 5 天前 | Revista do Departamento de Geografia | revistas.usp.br |

**机构、开放库与聚合层**

| 信源 | tier/间隔 | 目录条数 | 摘要中位 | 最新一条 | feed 自报栏目名 | 条目链接主机 |
| --- | --- | --- | --- | --- | --- | --- |
| `rss-egu-blogs` | T1_5/720 | 10 | 5426 字 | 0 天前 | Latest posts from EGU blogs | blogs.egu.eu |
| `rss-ecsociety` | T1_5/720 | 10 | 67914 字 | 1 天前 | Ecology Society | ecologyandsociety.org |
| `rss-arctic-portal` | T2/720 | 15 | 3689 字 | 2 天前 | News - Arctic Portal | arcticportal.org |
| `rss-aad-news` | T1/720 | 10 | 251 字 | 2 天前 | Australian Antarctic Division | www.antarctica.gov.au |
| `rss-hal-geography` | T2/720 | 40 | 1791 字 | 0 天前 | HAL : Dernières publications | hal.science、shs.hal.science |


**接入合计**：包内 Copernicus 家族共 41 条（本轮 +27），
`rss` 226 条，258 条 `enabled=true`。

### 首导闸门看不见的那一类：允许前缀只匹配了一半的主机

`allowed()`（`packages/backend/src/sources/web-list.ts:52`）是**整串 URL 的前缀比较**，不是主机比较。
`rss-hal-geography` 按"HAL 都在 hal. 下面"的直觉写了 `allowUrlPrefixes: ["https://hal."]`，
实测它的目录发布的主机是 `hal.science`、`shs.hal.science`、`amu.hal.science`、`ifp.hal.science`——
**四分之三会被静默丢掉**，而第五十七轮那道"首导一条不剩就报故障"的闸门叫不出来，因为首导确实存下几条。
修法不是把前缀写成正则后缀匹配（那就是给一个匹配器加它不该有的能力），而是这条源本来就被自己的查询串
（`q=geography`）限定，前缀清单删掉即可。**下一轮写 allow-list 之前先问一句：这个平台的主机是不是一个前缀能表达干净的。**

### 刊名要从 feed 里读，不能从缩写猜

本轮登记的 27 本 Copernicus 刊里有 5 本的 `name` 是我按三个字母的 slug 猜出来的，抓到 feed 自己 `<channel><title>`
与 `<description>` 之后全部改正：`esd` 是 **Earth System Dynamics**（不是 Earth System Science Data——那本是 `essd`，
第五十六轮已经在包里，两本撞名会把读者直接带错）；`ar` 是 **Aerosol Research**（不是 Advances in Radio Science）；
`sp` 是 **State of the Planet**；`eo` 是 **Earth Observation**；`egqsj` 是 **Quaternary Science Journal**。
每条 feed 的 `<channel>` 还写着"Combined list of the journal … and the recent discussion forum …"，
所以 Copernicus 这 27 条的目录里**同时含正刊与讨论稿**，条目数因此普遍是 20 的整倍数。

### 三条发现路线在这台机器上是死的（下一轮别再走）

- `copernicus.org/en/journals.html` → **HTTP 404**，首页导航是 JS 渲染的 `void(0)`，没有可抓的刊列表；
- **DOAJ** v4 journals 索引对任何字段化查询都回 `total: 0`，且 Cloudflare 对 `GeoHotBot` UA 直接 **403**（不带 UA 反而 200）；
- **Crossref** `/journals?query=geography` 命中 617 本、其中登记了 RSS 链接的 **0 本**。

可用的一条是 **Crossref works-by-prefix**：`/prefixes/10.5194/works` 的 DOI 形如 `10.5194/<刊>`-`<卷>`-`<页>`-`<年>`，
按前缀反推出 91 个**真实存在且这两年在发稿**的刊 slug（2026 年 6094 条、2025–26 共 12977 条登记），
再逐 slug 量它自己的 feed。本轮新增的 9 本 Copernicus 刊就是这么来的，而不是我拼出来的。

### 退回的（点名 + 实测值）

| 候选 | 采集机实测 | 结论 |
| --- | --- | --- |
| `delineation/mjr/foss/tcs/jrsms/jedam/mrs/ett/sh/oc/ejvrr/geors`.copernicus.org | **12 个 slug DNS 直接 NXDOMAIN**（`polf` 与 `agile-giss` 能解析） | 未接：这 12 个子域名是猜出来的。判法见上面 works-by-prefix |
| `polf.copernicus.org/xml/rss2_0.xml` | 200 · 20 条 · 摘要中位 598 字 · 最新 **84 天前** | 未接：过不了 45 天 |
| `agile-giss.copernicus.org/xml/rss2_0.xml` | 200 · 20 条 · 摘要中位 1430 字 · 最新 **121 天前** | 未接：同上 |
| `journals.openedition.org/espacepolitique/backend?format=rssdocuments` | 200 · 10 条 · 摘要 1000 字 · 最新 **109 天前** | 未接：同上 |
| `gaee.agh.edu.pl/gaee/…/rss2`（feed 自报 channel：Geomatics and Environmental Engineering） | 200 · 6 条 · 摘要中位 1290 字 · 最新 **72 天前** | 未接：同上 |
| `ojs.gi.sanu.ac.rs/index.php/zbornik/…/rss2`（feed 自报 channel：Journal of the Geographical Institute “Jovan Cvijić”） | 200 · 8 条 · 摘要中位 1743 字 · 最新 **113 天前** | 未接：同上 |
| `ms` / `aab` / `jbji` / `jsss`（Mechanical Sciences、Archives Animal Breeding、Journal of Bone and Joint Infection、Journal of Sensors and Sensor Systems） | 四本目录都健康（20 条、摘要中位 232–1653 字、最新 0–3 天） | 未接：**内容不是地理**（机械、育种、骨科感染、MEMS 传感器工程）。slug 真实不等于方向对 |
| `plosone` / `complexsystems`（PLOS One、PLOS Complex Systems） | 30 条 · 摘要中位 2089 / 1706 字 · 最新 1–3 天 | 未接：全学科巨型刊，与`前沿地理`要挑的"地理学前沿"不是一回事 |
| `blogs.egu.eu/feed/` | 200 但 **0 条 item** | 未接。EGU 博客走 `egu.eu/news/blogs/rss/`（10 条、摘要中位 5426 字），已接 |

**frontier 板块的分类归属：这批新源一律不设 `defaultCategory`。** 生产库里 `publications.category` 只有
`analyses` 判不出来时才回落到 `sources.default_category`（`packages/backend/src/publication/publish.ts:182`），
而 10-09 往前七天 `frontier` 出了 70 条已发布条目，贡献最多的 `JGR: Biogeosciences`、`Global Change Biology`、
`Earth's Future` 三条的 `default_category` 都是空——**模型自己在判，回落值只在判不出来时兜底**。
第五十六轮那 12 本 Copernicus 刊也是空，本轮跟着这个既有口径走（`defaultCategory=frontier` 包内仍 35 条）。


### 上线首轮实测：53 条全部抓到东西，四条的登记表是错的

登记完不等于接上了。当晚 22:26 在生产上把这 53 条各跑一遍真采集（`scripts/collect.ts`，与调度器同一条代码路径），
**53 条全部 `status: ok`，入库 889 条文章**；四条第一次尝试是失败的，原因都不是对端而是我们的登记表：

| 信源 | 第一次的真实报错 | 修法 |
| --- | --- | --- |
| `rss-pensoft-bdj`、`rss-pensoft-oneecosystem`、`rss-pensoft-natureconservation` | `first import kept none of 100 items: the listing publishes bdj.pensoft.net and config.allowUrlPrefixes allows none of them` | 三条的 `allowUrlPrefixes` 我写的是 `/articles/`（复数），Pensoft 自己发布的是 `/article/207059/`（单数）。改成单数后各入库 5 条 |
| `rss-usp-geografia` | `Too many redirects for https://revistas.usp.br/rdg/pt_BR/gateway/plugin/WebFeedGatewayPlugin/atom` | `guardedFetch` 全局发 `accept-language: zh-CN`，而这个 OJS 站对**任何**非本站语种的 Accept-Language 都 302 到同一个地址（实测：不带该头 200、`pt-BR` 200/95418 字节、`en`/`en-US/`es`/`zh-CN` 第 0 跳就打转）。用 `rss` 本来就支持的每源 `headers` 指回 `pt-BR`，不动 226 条 rss 共用的语种协商 |
| `rss-egu-blogs` | `fetch failed`（270ms） | 瞬时故障：同一条命令重试 1509ms 正常（10 条 / 摘要中位 5426 字）。curl -4 与 node fetch 当场都能取到，不改建法 |

**Pensoft 这三条是第五十七轮那道首导闸门在真实生产上第一次起作用**：它们目录里 100 条都读得出来、
链接主机也对，只有路径写法与对端不符，所以 `found: 100` 而入库 0——在没有那道闸门的年代，
后台只会显示 `health: degraded` 加一句 `found: 100`，看上去像"这个刊最近很勤"。

**HAL 那三条 5 个字的摘要不是我们的截断**。`api.archives-ouvertes.fr` 的 RSS 给 40 条中的 3 条把
`<description>` 直接写成 `<![CDATA[[...]]]>`（对端占位符）。查库里 40 条 `body_status` 全是 ok、
正文最短 389 字——**摘要占位但正文抽到了**，所以模型不是拿" [...]"加标题在编。其余 37 条的摘要来自
`dc:description`（中位 1791 字）。这一条记在这里是为了下次别再把 `[...]` 当成我们的缺陷去"修"。

### 这 53 条把队列压成什么样了（决定下一轮该做什么的数字）

- 采集完成时 `processing_state='new'`（等分析）共 **2060 条**，其中 **1061 条**是今晚首导产生的，其余是既有流入；
- 分析吞吐实测：近 6 小时 309 次分析 = **52 次/小时**（单小时峰值 71–72），每小时大模型调用数仍贴着
  `budgets.llm.per_hour = 420` 的上限（第五十七轮记的是 402/420）；
- 补漏网 `sweepUnprocessed()` 按 `discovered_at ASC` 取 500 条（**旧件优先**），
  所以今晚这批前沿期刊要排在既有 999 条之后，**前沿板块是"一天多里陆续出全"，不是上线即满**。

结论写在这里，避免下一轮误判：**再加信源不会让读者多看到内容，只会把 52 次/小时的带宽摊得更薄。**
数量已经不缺（271 条、`rss` 226 条），缺的是站长那一侧的 `per_hour` 决定，
或者一次"哪些批量源不该逐条进模型"的口径决定——两者都不是采集侧能替站长做的。