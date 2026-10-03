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
所以上面那三档在关着采集的机器上根本不会跑；② **本站一条按次计费的信源都没有**——`industry/sources.json` 的 58 条里
`x_search`、`mp_account`、带 `paid_listing` 的现值都是 0，所以"按次计费"这一档在现部署下是空集，采集不产生账单。
登记间隔的现值最小 30 分钟（3 条 30、6 条 60、12 条 120、1 条 180、11 条 240、2 条 360、1 条 720、8 条 1440；
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

四个新板块要落地，先要证明"这些源真的在发、采集器真的够得着"。下表每条都是**在采集器所在的那台服务器上**用
`curl -sS -o /dev/null -w "%{http_code}|%{content_type}" -L --max-time 25 <url>` 当天实测过的；
"最近条目"是当时从响应里读到的 `<pubDate>`/`<updated>`。加进 `industry/sources.json` 之后它们各自声明了
`defaultCategory`，条目直接归到对应板块（见 `industry/boards.json`）。

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
  要么没有机器可读形状，全部没接；这也是"考研板块目前只有政策一条源"的原因。
