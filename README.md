<sub>🌐 <b>中文</b> · English（暂无英文版） · 完整手册见 <a href="docs/manual.md">docs/manual.md</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="经纬之交：墨色地球被一条经线与三条纬线切开，青色热点落在北纬与经线的交点上" width="72">

# GEOHOT · 地理热点

> *「关于这片土地的消息每天都有，有依据、值得写的，只有几条。」*

[![Status](https://img.shields.io/badge/%F0%9F%8C%90_线上访问-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Derived from AIHOT](https://img.shields.io/badge/派生自-AIHOT_框架-1F1E1D)](NOTICE)
[![Node](https://img.shields.io/badge/运行时-Node_24-1F1E1D)](#技术栈)
[![Categories](https://img.shields.io/badge/分类-九个-D97757)](#-九个分类一条标准)
[![Sources](https://img.shields.io/badge/信源-58%2B1_个-D97757)](#-现状与边界)
[![Editorial brain](https://img.shields.io/badge/编辑大脑-人工策划_无_LLM_Key-1F1E1D)](#-编辑大脑是人工写的判断这一点不遮掩)
[![GitHub](https://img.shields.io/badge/GitHub-@xxc2007-1F1E1D)](https://github.com/xxc2007)

<br>

**每天把地理这件事读一遍，只留下有依据、值得写的几条。**

<br>

盯住台站、卫星机构、统计与区划部门、期刊和研究者的信源，按**空间显著性**筛出少数几条，写成中文标题与摘要，把同一件事的多方报道并成一个事件，每天早上 08:00（Asia/Shanghai）出一份日报。免费、不用注册，每条都留着原文地址。

它建在开源框架 [AIHOT](https://github.com/KKKKhazix/AIHOT)（MIT）之上，行业层换成了地理：引擎在 `apps/` 与 `packages/`，地理的一切——站名、分类、主题、信源、评分标准、门槛、品牌、条款页——都在 [`industry/`](industry/) 这一个文件夹里。

[特色](#-特色) · [九个分类](#-九个分类一条标准) · [站点结构](#-站点结构) · [技术栈](#-技术栈) · [换成你的行业](#-换成你的行业) · [本地运行](#-本地运行) · [设计笔记](#-设计笔记) · [License](#-license) · [完整手册](docs/manual.md)

<br>

> 这一页是介绍页。**操作手册**（本机跑法、端口对照、检查命令、已知边界、上线前清单）在 [`docs/manual.md`](docs/manual.md)——它就是这棵树原来的 README，内容一字未删地搬了过去。日常运营读 [`docs/geohot-runbook.md`](docs/geohot-runbook.md)，精选与校准读 [`docs/selection.md`](docs/selection.md)，换行业读 [`docs/customize.md`](docs/customize.md)，信源怎么配读 [`docs/sources.md`](docs/sources.md)，部署读 [`docs/deploy.md`](docs/deploy.md)，**换域名或换服务器**读 [`docs/migration.md`](docs/migration.md)，进程与目录读 [`docs/architecture.md`](docs/architecture.md)。这份清单里只有 `README.md`、`docs/manual.md`、`docs/geohot-runbook.md`、`docs/migration.md` 是本站写的，其余（`customize/selection/sources/architecture/leaderboard/deploy`）都还是上游参考文档，若干命令与数字在本站不成立——**哪份文档该打折、逐条打到什么程度，看 [`docs/manual.md` 第 9 节那张"文档 × 状态"表](docs/manual.md)**（那张表是本仓库的反腐烂装置：它按文档逐条写明哪些说法已经不成立、哪些只是抄录）。

</div>

---

<p align="center">
  <img src="docs/shots/home-light.png" alt="首页精选：左侧导航（含板块）、筛选栏含九个分类、按日期分组的精选卡片" width="100%">
</p>
<p align="center"><sub>
  ▲ 首页「精选」· 截图摄于 **2026-10-03 19:36（+0800）**，路由 `/geohot/`，视口 1440×900，浅色主题 · 那一刻**没有「当前热点」条**，因为热点榜是空的（原因见下表 `/hot` 那张图的说明）；时间线是 10月2日 1 条、10月1日 49 条，第一条是 The Guardian·环境、入选分 83 的《「像照顾宠物一样」：一款提醒你街区里的树是否缺水的应用》。筛选栏里已能看到这一轮新增的四个分类（地理与政治 / 地理与历史 / 考研 / 地理信息系统），侧栏多了「板块」。**这一屏每天在变，线上地址才是事实来源**：`https://xxc2007.me/geohot/`。
</sub></p>

---

## ✨ 特色

### 🧭 九个分类，一条标准

分类是这个站的骨架（`industry/taxonomy.ts`，`key` 直接进 URL，上线后不再改）：

| key | 分类 | 收什么 |
|---|---|---|
| `physical` | 自然地理 | 地貌、气候、水文、土壤、植被与灾害事件，须有观测数据、图件或影像 |
| `human` | 人文地理 | 人口与迁移、城市化、产业与交通区位、行政区划调整、城乡与区域政策 |
| `regional` | 区域地理 | 以区域或流域为单位的整体性变化：极地、青藏高原、三角洲、城市群、跨境河流 |
| `geopolitics` | 地理与政治 | 主权、边界与领土的划定与争议，地缘格局、战略通道、跨境河流与海洋权益 |
| `histgeo` | 地理与历史 | 历史时期的地理变迁与古今对照：河道海岸线、政区疆域沿革、城址兴废、古地图 |
| `geoedu` | 考研 | 地理学科的招生政策与专业目录、学科与学位点、考试大纲与分数线、招考数据 |
| `geotech` | 地理信息系统 | 遥感与影像、导航定位、观测数据集与标准的发布，以及 GIS 软件与平台、空间数据库与标准、WebGIS 与三维引擎、开源生态与许可变更 |
| `fieldwork` | 野外与考察 | 野外考察、科考航次、钻探与剖面测量的第一手记录，须有亲历者或现场材料 |
| `comment` | 观点与解读 | 评论、深度分析、趋势解读与科普长文，必须有明确观点或论证 |

> 2026-10-03：**「地理信息技术」与「地理信息系统」合并为「地理信息系统」一个区域**（站长要求）。分类 `key` 保留 `geotech`——它已经在网址与库里，词表头部写着上线后不可改；另一个 key `gis` 只活了几个小时，名下的行由迁移 `0040` 并到 `geotech`。板块页 `/boards/gis` 的地址与图记不变，改为只挂这一个分类。

**板块页**（`/boards`）把其中四个跨类别方向做成独立入口：考研 / 地理信息系统 / 地理与政治 / 地理与历史。一个板块是一个分类的视图（2026-10-03 合并之后，四个板块各自只挂一个分类），页面上两条线**永不混**：**本站精选**是人工签署的编辑判断；**来源原文**是各信源已公开、尚未经本站编辑判断的条目（按时间倒序取最近的若干条，不设"只看当天"的时间窗；标题与链接指向出处，卡片上写明这一点），并按来源折叠——同一条来源最多连出 3 条，其余折成「＋N 条来自同一来源」，免得一个预警源铺满整屏。板块与来源的对应写在 `industry/boards.json` 与每条源的 `defaultCategory`（`industry/sources.json`）。

**入选标准只有一条：空间显著性优先**——影响尺度大、多方独立报道、有数据/图件/影像支撑，三件同时成立才排得靠前。这条既写进评分提示词，也写进五轴权重表，还写进热度算法（"多方独立报道 = 热"）。

**明确压制的噪声**：旅游软文、研学与营地招生、教研培训与课件推销、景区宣传通稿；此外还有无数据的泛泛地方介绍、未经核实的地理传闻、纯机关公文与会议通报、多主题盘点汇编。这些在**预筛**阶段就被 `BLOCK`，到不了评分那一步。

### 🚪 一条资料进站的七步

**采集 → 预筛 → 两次独立打分 → 门槛 → 归并成事件 → 热度 → 日报**

- **预筛**（`industry/prompts/prefilter.md`）：是不是地理的事、有没有实在信息。`BLOCK` 的材料不出现在任何公开页面。
- **两次独立打分**：同一份评分标准串行调用两次（0–100），**两次之和 ≥ 2 × 门槛**才入选，卡片显示两次的平均（向下取整）。
- **门槛按信源分级**：`T1` 56 / `T1_5` 59 / `T2` 62（入选线之和 112 / 118 / 124），另有 `understandFloor` 46——没入选但过这条线的也用精选的写法出中文标题与摘要。现值只写在 [`industry/selection.ts`](industry/selection.ts)，那个文件的头注释就是它的算式，也写着**这组数是推出来的、还没被 gold 集校准过**。
- **归并成事件**：多家报道同一件事并成一个事件，事件页有综述；入选的材料要等归组完成才出现在精选里，避免同一件事先冒出好几条。
- **热度**：48 小时窗口、24 小时半衰期、每个独立来源只投一票，至少 2 位参与者且至少 1 位是编辑类信源。
- **成刊**：日报每天 08:00，周报周一 10:00，月报每月 1 日 10:30；条目按热度排，分节是学科 / 技术 / 实践三节。

### 🖋 编辑大脑是人工写的判断，这一点不遮掩

**本站没有配任何 LLM API Key，也没有自主运行的模型。** 框架只在真要调模型的那一刻读 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，本站把这三个指向一个只听 127.0.0.1 的本地 stub（[`tooling/brain-stub.ts`](tooling/brain-stub.ts)），它按"这条材料是哪一步、是哪一篇"返回**人工撰写的地理编辑判断**，判断存在 `tooling/fixtures/*.jsonl`（13 个能力文件）。

- 闸门是真的：预筛、两次独立打分、门槛、归组的三值关系、48 小时历史闸门、日报分节、公开读取层，**全部走真实代码，一句都没被绕过**。被替换掉的只有"模型今天怎么想"，不是"系统怎么裁决"。
- **结构上产不出假精选**：没有 fixture 的材料落在确定性默认值上（打分 20，两次之和 40，过不了任何一档的 2× 线；归组默认 `UNRELATED`）。想让一篇材料进精选，必须有人在 `tooling/fixtures/scores.jsonl` 里写下过线分数。
- 所以**精选只随人新写的判断增长**，不随抓取量增长。这是设计选择，不是缺陷：每一条编辑判断都能追到人，读者看到的立场是编辑部的，不是某个模型当天的。
- 想换成真模型：改 `.env` 里那三行，代码一行都不用动（`MODEL_CALLS_ENABLED` 打开后才会真的发请求）。
- 界面上那颗分数徽标仍写作「AI 评分」（沿用上游措辞），它显示的是两次独立评分的平均值——在本部署里，那两次分数来自人工写下的判断。

### 📊 现状与边界

本机库内实测，**截至 2026-10-01**（这些数字每天都在动，别当承诺读）：

| 收录材料 | 归并成的事件 | 精选 | 启用信源 | 主题 | 日报期数 |
|---:|---:|---:|---:|---:|---:|
| 1051 | 594 | 84 | 45 | 45 | 3 |

（表里的「日报期数」是本机 `reports` 表的行数，含 0 件大事、已被读取层过滤不再列出的空刊。**线上出了几期不写在这里**——直接看 [`/daily/archive`](https://xxc2007.me/geohot/daily/archive) 或 `GET /api/v1/dailies` 的 `count`：每天 08:00 出刊后这个数字就会变，抄进介绍页只会过期。2026-10-03 复核：`count` 为 2，归档列 10-03 与 10-02 两期。）

精选按分类：自然地理 32 · 区域地理 18 · 观点与解读 11 · 地理信息技术 9 · 人文地理 5 · 野外与考察 3（合计 78，其余条目没有分类字段）。

**信源数量的唯一说法在这里**（其余文档一律指向本段，别再抄一份数字）：登记在 [`industry/sources.json`](industry/sources.json) 的是 **58 条**（`node -e "console.log(require('./industry/sources.json').sources.length)"` 当场可数），本机库里 `sources` 表是 **59 行**——多出的那一行是投递接口在运维校验时自动建的 `external` 占位源 `ext-opscheck-ingest-probe`（站上不可见，清理 SQL 在 `scripts/README-ingest.md` 末尾），所以顶上那枚徽标写「58+1」。这 58 条里 **50 条真在轮询**（39 `rss` + 8 `web_list` + 3 `json_list`）、**8 条 `external`** 是给人工投递预留的通道（`participation_mode=isolated`，站上暂不可见）。可轮询那 50 条横跨中英两种语言与机构、媒体、期刊、软件发布四类来源：国际机构（USGS、NASA Science、NOAA、GDACS、UN OCHA、Copernicus）× 国际媒体与智库（The Diplomat、World Politics Review、Foreign Affairs、Crisis Group、对话地球、The Conversation）× 软件与标准（OGC、QGIS releases）× 历史与地图（国会图书馆地图部、Public Domain Review、欧洲环境史学会）× 国内一手层 9 条（中国地震台网中心、中央气象台、国家统计局、水利部两条、应急管理部、澎湃新闻、《地理研究》当期目录、研招网政策与规定）。本站没有任何 `x_search`/`mp_account`/按次计费的信源（现值 0 条），采集不产生账单。**50 条轮询源里 14 条声明了 `defaultCategory`**，把条目直接归到它所属的板块（见上）；其余按模型/人工判断归类。

**已部署**：[`xxc2007.me/geohot/`](https://xxc2007.me/geohot/)（2026-10-01）。四个常驻单元只监听回环、各自带内存上限，装在同一台跑着主站与 Artalk 的机器上，主站首页逐字节未变（`51432` 字节 / `4edf0fc53636a680…`，2026-10-03 又用 `curl -s https://xxc2007.me/ | wc -c` 与 `sha256sum` 复核过一遍）。怎么装的、验证命令、以及部署时踩过的坑（那张「症状 → 真正原因」表），都在 [`deploy/geohot/DEPLOYMENT.md`](deploy/geohot/DEPLOYMENT.md)。**日报已出刊**：`/daily` 给的是**最新一期**（这一句不写期号与日期，每天 08:00 它都会变），下面那张图是 **2026-10-02 第 1 期**（`/daily/2026-10-02`）：21 件大事、14 个来源、12 件一手发布、约 10 分钟读完——这四个数字属于那一期，不属于"今天"。上线首日（10-01）`/daily` 确实是诚实的空态——worker 在当天 08:00 档期之后才起，那份日报本来就属于第二天，原因与空刊怎么被读取层过滤，写在 [`docs/known-issues.md`](docs/known-issues.md)。

还没做好的地方单独列了一份 [`docs/known-issues.md`](docs/known-issues.md)：被撤下的综述溯源校验器（会误删忠实内容）、GDACS 绿色通报的英文模板标题进了公开池、摘要质量闸门、以及上游文档与本站不符之处。这份清单不是免责声明，是待办列表。

<p align="center">
  <img src="docs/shots/hot-light.png" alt="地理热点榜：那一刻的空状态——「暂时没有热点 · 还没有足够多来源共同讨论的事件」，页头写着更新时间" width="100%">
</p>
<p align="center"><sub>
  ▲ 热点榜 `/hot` · 截图摄于 **2026-10-03 19:35（+0800）**，路由 `/geohot/hot`，视口 1440×900，浅色主题；那一刻榜是**空**的，页面自己写着「10月3日 19:35 更新 · 按讨论热度排序」与「暂时没有热点 · 还没有足够多来源共同讨论的事件」。这不是故障：上线的当天下午起，48 小时窗口里没有任何事件达到「至少两个独立参与方且至少一个是编辑类信源」这条门槛——当时窗口内 2639 个事件、24 个参与方，几乎每个预警各自成一个单来源事件；同一台库往前推 48–96 小时的那个窗口里有 6 个合格事件，所以榜在前一天是满的。榜单每 5 分钟重排，**这一屏以线上为准**：`https://xxc2007.me/geohot/hot`（或 `GET /api/v1/hot-topics`）。
</sub></p>

<p align="center">
  <img src="docs/shots/daily-light.png" alt="地理日报头版（2026-10-03 第 2 期）：报头字、期号卡、导读与分节正文" width="100%">
</p>
<p align="center"><sub>
  ▲ `/daily` · 截图摄于 **2026-10-03 19:37（+0800）**，视口 1440×900，浅色主题；拍的是**那一刻的最新一期**（`/daily` 每天都换，这一版是 **2026-10-03 第 2 期**，固定地址 `/daily/2026-10-03`，左侧「往期」里 10月3日 高亮）。这一期 **1 件大事、1 个来源、0 件一手发布，约 1 分钟读完**，头条是《「像照顾宠物一样」：一款提醒你街区里的树是否缺水的应用》，本期版面只有一节：野外与考察 · 观点与解读，1 件。报头字「地理日报」是本站自己生成的 SVG（`scripts/nameplates.ts` 按 `SITE.subject` 出图）。**最新一期每天都换，线上才是事实来源**：`https://xxc2007.me/geohot/daily`。
</sub></p>

## 🗂 站点结构

读者侧真正服务的路由（核对自 `apps/web/app/routes.ts`）：

| 路由 | 页面 |
|---|---|
| `/` · `/all` | 精选 · 全部地理动态（含搜索） |
| `/hot` | 地理热点榜（按事件排，不是按条目） |
| `/daily` · `/daily/archive` · `/daily/:key` | 最新一期 · 存档 · 单期；`/weekly`、`/monthly` 同构 |
| `/topics` · `/topics/:slug` | 主题目录（条数以 `industry/topics.json` 为准；2026-10-03 实测文件与站上都是 45）· 单个主题页 |
| `/story/:publicId` · `/items/:id` | 事件页（多方报道并成一条）· 条目页，另有 `/items/:id/original` 原文跳转 |
| `/about` · `/agent` · `/changelog` · `/feedback` · `/terms` · `/privacy` · `/more` | 关于 · Agent 接入 · 更新日志 · 反馈 · 条款 · 隐私 · 更多 |
| `/starred` | 我的收藏——只存在这台设备的浏览器里，`noindex` |
| `/admin/*` | 后台，**要登录**（密码是 `.env` 里 `npm run env:init` 生成的 `ADMIN_PASSWORD`） |

`/leaderboard` 与 `/codex-reset` 还留在路由表里，但这两个 AI 专属模块被关掉了，接口不注册，实际是 404。**这件事的唯一依据是 [`industry/features.ts`](industry/features.ts) 里那两个布尔值**（`leaderboard: false`、`codexResetMonitor: false`）；完整影响面——哪些端点不注册、后台还剩什么、底表搬去了哪里——只写在 [`docs/manual.md` 第 9 节](docs/manual.md) `docs/leaderboard.md` 那一行，其余文档一律指向它，不再各抄一遍。

机器可读出口读的都是 `packages/backend/src/publication/` 这一个只读层，所以内容一致：RSS（`/feed.xml`、`/feed/full.xml`、`/feed/all.xml`、`/feed/daily.xml`、`/feed/weekly.xml`、`/feed/monthly.xml`、按分类的 `/feed/category/<key>.xml`）、公开 API（`/api/v1/*` 一组只读端点，`/api/v1` 本身不是路由；规范 `/openapi-v1.json`，说明页 `/agent`）、`/llms.txt`、`/sitemap.xml`、`/robots.txt`，以及 MCP（`/api/mcp`，**7 个只读工具**：`geohot_get_latest`、`geohot_search`、`geohot_get_hot_topics`、`geohot_get_story`、`geohot_get_daily`、`geohot_get_weekly`、`geohot_get_monthly`；2026-10-03 用 `tools/list` 实测就是这 7 个，后两个是 10-02 那轮接上的）。

`/.well-known/security.txt` 是**注册了但按设计返回 404** 的那一个：路由存在，只有当 `industry/site.ts` 的 `contactEmail` 有值时才渲染，现在它是 `null`（`site.ts:38`），所以线上 404——宁可不发布，也不挂一个没人看的地址。填上真实地址它就出现；子路径部署还有一层限制（RFC 8615 的 `/.well-known/` 只在域名根生效），写在 [`docs/known-issues.md`](docs/known-issues.md)。读者打开页面不触发任何模型调用。

```text
GEOHOT/
├── apps/
│   ├── api/          # Fastify：读者接口、后台接口、RSS/OpenAPI/llms.txt/MCP/sitemap
│   ├── worker/       # pg-boss 队列与定时任务：采集、分析、归组、成刊（不监听端口）
│   └── web/          # React Router 8 服务端渲染 + Tailwind v4
├── packages/
│   ├── backend/      # 引擎：采集/预筛/打分/归组/热度/日报/公开只读层/回执与预算熔断
│   └── contracts/    # 跨进程契约与 HTTP 策略
├── industry/         # ★ 行业层：换行业只动这里（见下面那节）
├── database/         # 迁移（只做向后兼容的增量，35 个）
├── scripts/          # env:init · dev-db · migrate · seed · seed:curated · smoke · shoot（重拍本页配图）· collect · eval-selection
├── tooling/          # brain-stub.ts（编辑大脑 stub）· fixtures/（人工判断）· corpus/（人工语料）· ci-check.yml（CI 正本，见下面那节）
├── tests/            # node --test，串行、共享一个 *_test 库，不碰任何外部服务
├── docs/             # manual.md（操作手册）· migration.md（搬家清单）· runbook/selection/customize/… · shots/（本页配图）
└── LICENSE · NOTICE · AGENTS.md
```

## 技术栈

| 层 | 选型 | 为什么 |
|---|---|---|
| 运行时 | **Node 24**（`engines: >=24.11`）直接执行 TypeScript | 后端没有构建步骤，改完即跑，少一层会撒谎的产物 |
| 组织 | **npm workspaces**：`apps/*`、`packages/*`、`industry` | 一处改动全仓可见，不需要发版协调 |
| 前端 | **React Router 8** SSR + React 19 + **Tailwind v4** | 服务端渲染，爬虫和阅读器拿到的是完整 HTML |
| 接口 | **Fastify 5** | 公开读接口要能压量，后台写接口要能加校验 |
| 任务 | **pg-boss 12** | 队列就建在 Postgres 里，少一个要运维的中间件 |
| 数据 | **PostgreSQL 17** + `pg_trgm` | 事件归并要相似度检索；本机用 `embedded-postgres`，不依赖 Docker |
| 编辑判断 | 本地 OpenAI 兼容 stub + `tooling/fixtures/*.jsonl` | **无 LLM Key**，见上面那一节 |

## 🔁 换成你的行业

`industry/` 是这棵树里和"地理"有关的东西该待的地方，其余是通用引擎——**换一个垂直领域，正常只需要动这一个目录**。这是本仓库最值得抄走的一点。

诚实补一句：目前**有两处例外**，是这轮改版新加的界面文案留下的——`apps/web/app/routes/topics.tsx` 与 `apps/web/app/features/report/format.ts` 里写死了几句中文地理词（主题页的说明文字、日报分页标题的拼接）。它们应该回到 `industry/`，列在 [`docs/known-issues.md`](docs/known-issues.md) 里。

| 文件 | 管什么 |
|---|---|
| `site.ts` | 站名、行业词 `subject`（拼进"地理日报""全部地理动态"）、首页与关于页文案、MCP 工具名前缀、`contactEmail`、`icp` |
| `taxonomy.ts` | 九个分类、七种内容类型、三个标签词表、机构名录、防张冠李戴的身份词典 |
| `topics.json` | 主题页目录（`/topics`）；条数以这个文件为准，别抄进文档（2026-10-03 文件与站上都是 45） |
| `sources.json` | 首次启动导入的信源（`ON CONFLICT DO NOTHING`，只增不改，之后在后台增删） |
| `prompts/` | 27 个文件：精选标准、写作要求、噪声例子——**行业 KnowHow 就写在这里**，改标准不用改代码 |
| `selection.ts` | 门槛与 `understandFloor`，文件头注释是它的算式与"未校准"声明 |
| `features.ts` | `leaderboard: false`、`codexResetMonitor: false`：两个 AI 专属模块，别的行业站都关了 |
| `brand/` | 图标与日报报头字（`nameplates/*.svg` 由 `scripts/nameplates.ts` 按 `SITE.subject` 生成，改了 `subject` 要重跑） |
| `pages/` | `terms.md`、`privacy.md`，目前是模板，上线前要主办者本人确认 |

按顺序四步：改 `site.ts` 与 `taxonomy.ts` 的文案和分类 → 换成你自己行业的 `sources.json`（先在后台 `/admin/sources/new` 点"预览抓取"验证真能取到）→ 把 `prompts/` 里"什么算重要、什么算噪声"换成你的行业的例子（结构别动：内容类型、五轴权重、噪声压制、安全边界都保留）→ 用你自己标注的样本重跑 `scripts/eval-selection.ts` 定门槛。`apps/` 与 `packages/` 基本不用动；真遇到写死的行业词，只改面向用户的那段字符串，不动评分、归组、成刊和读取层的逻辑。完整步骤在 [`docs/customize.md`](docs/customize.md)（步骤成立，数字以代码为准）。

## 🚀 本地运行

Node 24 + Git Bash。**不需要 Docker、不需要管理员权限、不需要自己装 PostgreSQL**——数据库由脚本自带。下面每条命令都在 `package.json` 或 `docs/geohot-runbook.md` 里逐项核对过。

```bash
git clone https://github.com/xxc2007/GeoHot.git && cd GeoHot
npm ci

npm run env:init            # ★ 关键第一步：写出 .env 与 .env.pipeline，五个键是真随机值，且拒绝覆盖已存在的文件
npm run db:up -- --daemon   # embedded PostgreSQL 17，127.0.0.1:5433（前台跑法去掉 --daemon；停止 npm run db:down）

npm run db:migrate          # 建表（35 个迁移）
node --env-file-if-exists=.env scripts/seed.ts              # 导入分类、主题、信源（这条没有 npm 别名）
npm run seed:curated -- --dry-run --enforce-source          # 先看人工语料会不会落进未登记信源
npm run seed:curated -- --enforce-source                    # 导入人工策划的语料
```

然后三个进程，各占一个终端，顺序无所谓：

```bash
npm run brain                                                        # 编辑大脑 stub，127.0.0.1:3055
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts    # 接口，默认 127.0.0.1:3001
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts # 采集、分析步骤、定时任务
npm run dev:web                                                      # http://localhost:3000
```

验证：`npm run typecheck`（六个工程，无输出即通过），构建后 `npm run build -w @aihot/web && node scripts/smoke.ts --base http://localhost:3000`（**17 个页面 + 18 个机器可读出口**，逐条列在 `scripts/smoke.ts:12` 与 `:13-32` 的 `PAGES` / `MACHINE` 两张表里，只读不写；模型榜开着时它还会再追加三页，本站那两个模块是关的所以不追加）。

**CI 的正本在 [`tooling/ci-check.yml`](tooling/ci-check.yml)，不在 `.github/`**——所以你在 GitHub 上看到的 Actions 页是空的，这不是没配检查。原因写在 `publish-excludes` 与那份文件自己的头部注释里：发布用的令牌没有 `workflow` 作用域，GitHub 拒绝它创建或更新 `.github/workflows/*`，把文件留在 `.github/` 下就永远进不了公开仓库，"仓库与源码同步"这句话就要打折。要跑 GitHub Actions 的人复制回去即可：

```bash
mkdir -p .github/workflows && cp tooling/ci-check.yml .github/workflows/check.yml   # 这一步需要带 workflow 作用域的 token
```

它跑的是：安装、typecheck、web 构建、web 与后端测试（全新的 PostgreSQL）、构建产物的 smoke，以及 Docker 镜像起一遍。

> **`env:init` 为什么不能跳**：`.env` 与 `.env.pipeline` 都被 `.gitignore` 排除，克隆里一个都没有，而上面的启动命令写的是 `--env-file=.env`——文件不存在时 Node 直接以退出码 9 死掉。手工 `cp .env.example .env` 也不是条通路：`ADMIN_PASSWORD`、`SESSION_SECRET`、`INGEST_TOKEN` 等五个键全是空的，后台进不去、投递接口恒 401。
> **`.env.pipeline` 是一次性文件**：`.env` 里四个安全阀一律 `false`（`npm test` 会继承 `.env`），只有叠这第二层才真的抓信源。**永远不要把它的内容合并进 `.env`。**
> **端口不是细节**：3000 / 3001 是最先被撞的两个。`npm run env:init -- --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065` 会把一组端口写进所有相互引用的键；对照表在 `docs/manual.md` 第 3.7 节。
> **干净库里看到的精选就是人工语料那部分**：新采回来的材料没有对应的人工判断，只会进"全部动态"，进不了精选——那是上面那个设计的直接后果，不是坏了。

## 📝 设计笔记

- **视觉语言刻意继承上游，但不是逐字节相同**：[`apps/web/app/app.css`](apps/web/app/app.css) 相对它进仓时的那一份（baseline 提交 `754191b`）有**三处**偏离，`git diff 754191b -- apps/web/app/app.css` 当场可查，逐处都有理由：① `--rank-rest`（第 4 名往后的排名数字，读者看得到的正文而不是装饰）浅色档从 `#6b7684` 调暗到 `#697482`、深色档从 `#7b869a` 到 `#7d889b`，原值实测 4.38:1 / 4.40:1，差在 WCAG AA 4.5:1 之下；② `--daybar` 浅色档从 `#f0f2ee` 提到 `#f2f4f0`（附 4 行注释说明为什么），这是 2026-10-02 那一轮对比度整改的一部分——手机日栏把 `--ink-4` 画在 `--daybar` 上实测 4.46:1，Lighthouse 的移动端 colour-contrast 审计因此失败，把底色提亮两档到 4.54:1 就能过，而不用去动任何文字令牌；③ 文件末尾**整段 `@media print` 是上游没有的**，本站把日报当报纸版式，取舍写在注释里：打印时收起侧栏与底部导航、去掉画布网点（它是内容不是背景，"关闭背景图形"管不住它）、卡片改白底灰框、标题不许落在页尾。除这三处之外一字未改。
- **无障碍是照着审计做的**：每个视口宽度下恰好一个 `<h1>`（首页那个与视口无关，侧栏标题在源码顺序上排到它之后）；主题切换与"就地切换状态"的筛选器是 `role="radiogroup"` + roving tabindex，一组只有一个 Tab 停靠点，方向键与 `Home`/`End` 直接改选（它们的面板属于页面不属于控件，所以没用 `tablist`）；被辅助技术丢弃的 `aria-label` 换成真实名字——分数徽标补 `role="img"`，更新圆点标 `aria-hidden` 并配一句 `sr-only` 文字（颜色不能单独承载信息，WCAG 1.4.1）；移动端底部标签栏 54px 高、四等分，明显高于 44px 的最小热区，桌面侧栏行高 40px 走鼠标面。
- **品牌是原创的，且刻意不像上游**：站点标记「经纬之交」——墨色地球切一条经线三条纬线，唯一的青色热点正落在北纬与经线的交点上（`industry/brand/logo.svg`，文件头写着几何与配色的理由）。不用上游的名字与 Logo。
- **空状态是设计的一部分**：`野外与考察` 几乎没有供给（可轮询的 36 条信源里没有科考队——科考航次与国家预警那几条登记为 `external`，要人工投递才可见），主题页里有一堆"0 条精选"的主题，日报薄的时候它就写着"本期共 1 条"。分类的 `key` 进 URL 所以不能删，空状态因此被当成页面认真做，而不是当成 bug。
- **读者要行动的地方就有免责声明**：命中灾害标签的条目页直接渲染"本站不是预警信息的发布机构，本页内容不构成预警依据……"，不是只在 `/terms` 里藏着。
- **门槛是经验护栏，不是证明**：`industry/selection.ts` 的头注释自己算给你看——12 条噪声硬上限只封住一到两轴，五轴从不回传代码，按字面算营销稿的天花板是 92–93 分，任何可用门槛都关不住它；真在下限拦噪声的是预筛的 `BLOCK` 与信源分级摆放。把 56/59/62 读成"营销稿数学上不可能入选"就是误读了这份文档。

## 📄 License

代码按 **MIT** 许可：[`LICENSE`](LICENSE) 原样保留上游文本、一个字没改，版权声明仍是上游框架 [AIHOT](https://github.com/KKKKhazix/AIHOT) 的作者（数字生命卡兹克）——本站没有往里面加自己的版权行。[`NOTICE`](NOTICE) 的上游部分同样原样保留，只在末尾**追加**了一段 "Derivative notice - GEOHOT"，说清这棵树是上游框架的修改衍生、改了什么、没用什么名字。

两点必须说明白：上游 `NOTICE` 写明 **"The name "AIHOT" and the AIHOT logo are not licensed under the MIT License"**，所以本站不复用它的名字与 Logo，只用文字声明衍生关系，这也不意味着上游认可或背书本站。第三方素材各自受自己的条款约束：`assets/og-fonts/`（Noto Sans SC，SIL OFL 1.1）、`assets/model-providers/` 与 `assets/leaderboard-sources/`（机构与评测方标识，只被本站已关闭的两个模块引用，商标归各自所有者）——`NOTICE` 不替你授权这些。`industry/sources.json` 里是各发布方的公开 feed，内容版权归他们，本站默认只显示摘要加原文链接（`site_fulltext` 对每个源都关着）。

顺带一句：根 `package.json` 的 `name` 仍是 `aihot` 且 `"private": true`，工作区包名 `@aihot/*`、目录名 `industry/`、浏览器存储键 `aihot-*` 都是代码内部标识，不对读者显示；改名要动 100 多处 import 和 5 处硬编码路径，本站决定不改。

---

<div align="center">
  <sub>献给每一条有坐标、有数据、有人回去核对的消息。<br><a href="docs/manual.md">docs/manual.md</a> · <a href="docs/geohot-runbook.md">docs/geohot-runbook.md</a> · 已上线 <a href="https://xxc2007.me/geohot/">xxc2007.me/geohot/</a></sub>
</div>
