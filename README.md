<sub>🌐 <b>中文</b> · <a href="README.en.md">English</a> · 完整手册见 <a href="docs/manual.md">docs/manual.md</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="经纬之交：墨色地球被一条经线与三条纬线切开，青色热点落在北纬与经线的交点上" width="72">

<p><sub>GEOGRAPHY · HOTSPOT · DAILY &nbsp;—&nbsp; 按空间显著性筛选 · 每条留原文地址 · 不做预测</sub></p>

# GEOHOT · 地理热点

> *「关于这片土地的消息每天都有，有依据、值得写的，只有几条。」*

[![线上访问](https://img.shields.io/badge/%F0%9F%8C%90_线上访问-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![仓库](https://img.shields.io/badge/GitHub-GeoHot-1F1E1D)](https://github.com/xxc2007/GeoHot)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![零注册](https://img.shields.io/badge/读者侧-零注册_·_零Cookie-1F1E1D)](#贰--site-map-站点结构)
[![分类](https://img.shields.io/badge/分类-七个-D97757)](#其一--taxonomy-七个分类一条标准)
[![运行时](https://img.shields.io/badge/运行时-Node_24_·_后端无构建-1F1E1D)](#叁--stack-技术栈)
[![行业层](https://img.shields.io/badge/行业层-全在_industry%2F-1F1E1D)](#肆--reuse-换成你的行业)
[![GitHub](https://img.shields.io/badge/GitHub-@xxc2007-1F1E1D)](https://github.com/xxc2007)

<br>

**每天把地理这件事读一遍，只留下有依据、值得写的几条。**

盯住台站、卫星机构、统计与区划部门的信源，按**空间显著性**筛出少数几条，写成中文标题与摘要，
把同一件事的多方报道并成一个事件，每天早上 08:00（Asia/Shanghai）出一份日报。
免费、不用注册，每条都留着原文地址。

它建在开源框架 [AIHOT](https://github.com/KKKKhazix/AIHOT)（MIT）之上，行业层换成了地理：
引擎在 `apps/` 与 `packages/`，地理的一切——站名、分类、主题、信源、评分标准、门槛、品牌、条款页——
都在 [`industry/`](industry/) 这一个文件夹里。

<br>

[🎬 宣传片](#-宣传片展示) · [壹 特色](#壹--highlights-特色) · [贰 站点结构](#贰--site-map-站点结构) · [叁 技术栈](#叁--stack-技术栈) · [肆 换成你的行业](#肆--reuse-换成你的行业) · [伍 本地运行](#伍--local-本地运行) · [陆 边界与笔记](#陆--notes-边界与设计笔记) · [柒 授权](#柒--license-授权与出处) · [捌 星际历史](#捌--star-history-星际历史) · [完整手册](docs/manual.md)

<br>

> **这一页只讲"它是什么"，不讲"现在有多少"。**
> 信源条数、收录量、精选数、日报期数、门槛分值都是每天在变的量，抄在这里第二天就过期，
> 所以本页一律**只给端点与文件名**，不给数字：线上现状看 [`/api/site/stats`](https://xxc2007.me/geohot/api/site/stats)，
> 信源口径看 [`industry/sources.json`](industry/sources.json)，门槛现值看 [`industry/selection.ts`](industry/selection.ts)。
> 操作口径（本机跑法、端口对照、检查命令、上线前清单）在 [`docs/manual.md`](docs/manual.md)；
> 哪份文档该打折、逐条打到什么程度，看它第 9 节那张「文档 × 状态」表。

</div>

---

<p align="center">
  <a href="https://xxc2007.me/geohot/"><img src="docs/shots/home-light.png" alt="GEOHOT 首页：顶部是当前热点条，下面是按时间排开的精选列表，侧栏是主题与日报入口" width="820"></a>
</p>

<details>
<summary>▲ 展一 · HOME 首页「精选」· 展开看这张图里有什么，以及为什么可能不是这个样子</summary>

画面顶部那块是**当前热点**，而这张截图拍到的正是它的**空状态**：热榜的成立条件是"两家以上独立信源同时讨论同一件事"，
凑不满时这里不把版面抹空，而是照实写一行「过去 48 小时还没有两家以上信源同时讨论的事件。」再给一个去 `/all` 的入口。
有榜的时段，同一位置换成前几条事件：名次、标题、正在讨论它的信源头像、热度数值与一个走势箭头；
标题旁可能跟着一个「截至 …」，那是这块榜的截止时间，不是页面写坏了。
**这一屏每天在变，线上地址才是事实来源**：<https://xxc2007.me/geohot/>。

</details>

---


---

## 🎬 宣传片展示

从精选资讯出发，经过七个分类、事件综述与报道时间线、地理日报、主题和 Agent 接入。真实读者页面组成 35.4 秒的产品宣传片；资讯画面为 2026-10-08 拍摄快照。

点击下方播放器即可在线播放。

https://github.com/user-attachments/assets/0f0d31b0-eaf2-4155-833e-5155f7391110

▶️ [打开 1080p 高清播放器](https://xxc2007.me/assets/promo/geohot/) · [直接打开 1080p 源视频](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo.mp4)

<sub>使用 Video Shotcraft 制作，运镜与展示结构参考[青山湖畔的纪念册](https://github.com/xxc2007/In-memory-of-Nanchang-No.-15-Middle-School#-宣传片展示)。</sub>

README 原生预览保持 1920×1080 分辨率；独立播放器与源视频链接继续使用仓库中的 1080p 完整片。

---

## 壹 · HIGHLIGHTS 特色

### 其一 · TAXONOMY 七个分类，一条标准

分类是这站的骨架（`industry/taxonomy.ts`，`key` 直接进 URL，上线后不再改）。
七个分类共用同一条入选标准——**空间显著性优先**：影响尺度大、多方独立报道、有数据／图件／影像支撑，三件同时成立才排得靠前。

| `key` | 分类 | 管什么 |
|---|---|---|
| `physical` | 自然地理 | 地貌、气候、水文、土壤、植被与灾害事件，须有观测数据、图件或影像 |
| `human` | 人文地理 | 人口与迁移、城市化、产业与交通区位、行政区划调整、城乡与区域政策 |
| `regional` | 区域地理 | 以区域或流域为单位的整体性变化：极地、青藏高原、三角洲、城市群、跨境河流 |
| `geopolitics` | 政治地理 | 主权、边界与领土的划定与争议，地缘格局、战略通道、跨境河流与海洋权益 |
| `histgeo` | 历史地理 | 历史时期的地理变迁与古今对照：河道海岸线、政区疆域沿革、城址兴废、古地图 |
| `geotech` | 地理信息系统 | 遥感与影像、导航定位、观测数据集与标准的发布，GIS 软件与平台、开源生态与许可变更 |
| `geoedu` | 考研 | 地理学科的招生政策与专业目录、学科与学位点、考试大纲与分数线、招考数据 |

**「板块」这一层不存在。** 它曾经有四个跨类别方向页（`/boards`），后来按站长要求整块删掉——判重：
主题页与筛选栏的分类做的是同一件事。删的只是视图，条目、`category` 字段、分类词表与公开门槛一行都没动；
`/boards` 现在返回 404，四个方向的入口在分类层（`/all?category=<key>`）与主题页。

### 其二 · PIPELINE 一条资料进站的七步

**采集 → 预筛 → 两次独立打分 → 门槛 → 归并成事件 → 热度 → 日报**

- **预筛**（`industry/prompts/prefilter.md`）：是不是地理的事、有没有实在信息。被 `BLOCK` 的材料不出现在任何公开页面。
- **两次独立打分**：同一份评分标准串行调用两次，**两次之和过线才入选**，卡片显示两次的平均（向下取整数）。
- **门槛按信源分级**：信源分 `T1` / `T1_5` / `T2` 三档，档位越低门槛越高（同一份内容，媒体转述要比官方一手更严才入选）；另有一条"没入选但值得读"的下限。
  **现值与算式只写在 [`industry/selection.ts`](industry/selection.ts) 的文件头注释里**，那里同时写明这组数仍未被 gold 集校准过。
- **归并成事件**：多家报道同一件事并成一个事件，事件页有综述。入选材料要等归组完成才出现在精选里，避免同一件事先冒出好几条。
- **热度**：一个滚动时间窗、按时间衰减、每个独立来源只投一票，参与方不足就是空榜——空榜是诚实状态，不是故障。
  三个参数（时间窗、半衰期、最少参与方）写在 `packages/backend/src/events/hot.ts`。
- **成刊**：日报、周报、月报按固定时刻生成，条目按热度排、按学科与技术分节。

### 其三 · BRAIN 标准是人定的，逐条判断交给模型

这条边界写进条款，不靠默契：分类表、重要性口径、噪声清单、门槛分数、提示词全部由站长逐条确认并写在 `industry/` 里；
模型按这套标准出逐条结论，站长在后台抽查并覆盖，读者也能通过「反馈」指出错误。

面向读者的每一句话都要和实际执行者一致：**机器写的摘要不许说成编辑部签署的立场**。
宁可少一条精选，不可错一条灾害数据。

---

## 贰 · SITE MAP 站点结构

| 路由 | 内容 |
|---|---|
| `/` · `/all` | 精选 · 全部动态（含搜索） |
| `/hot` | 热点榜（按事件排，不是按条目） |
| `/daily` · `/daily/archive` · `/daily/:key` | 最新一期 · 存档 · 单期；`/weekly`、`/monthly` 同构 |
| `/topics` · `/topics/:slug` | 主题目录与单个主题页（主题数以 `industry/topics.json` 为准） |
| `/story/:publicId` · `/items/:id` | 事件页（多方报道并成一条）· 条目页，另有 `/items/:id/original` 原文跳转 |
| `/about` · `/agent` · `/changelog` · `/feedback` · `/terms` · `/privacy` · `/more` | 关于 · Agent 接入 · 更新日志 · 反馈 · 条款 · 隐私 · 更多 |
| `/starred` | 我的收藏——只存在这台设备的浏览器里，`noindex` |
| `/admin/*` | 后台，**要登录**（密码是 `.env` 里 `npm run env:init` 生成的 `ADMIN_PASSWORD`） |

**机器可读出口**都从同一个只读层 `packages/backend/src/publication/` 读，所以网页与接口给的是同一批条目：

- RSS：`/feed.xml`（精选摘要）、`/feed/full.xml`（精选带正文）、`/feed/all.xml`、`/feed/daily.xml`、`/feed/weekly.xml`、`/feed/monthly.xml`，以及按分类的 `/feed/category/<key>.xml` 与 `/feed/full/category/<key>.xml`
- 公开 API：`/api/v1/*` 一组只读端点，规范在 `/openapi-v1.json`，说明页 `/agent`
- 给 Agent 的：MCP 端点与 `/llms.txt`
- 索引：`/sitemap.xml`、`/robots.txt`

读者侧没有登录、没有 Cookie、没有埋点；收藏存在本地浏览器里。管理员和访客看到的内容一样。

---

## 叁 · STACK 技术栈

每一层挑的都是「在本机一条命令就能跑起来、并且不需要额外中间件」的那一个。具体版本号以 `package.json` 为准，不抄在这里。

| 层 | 选型 | 为什么 |
|---|---|---|
| 运行时 | **Node 24** 直接执行 TypeScript | 后端没有构建步骤，改完即跑，少一层会撒谎的产物 |
| 组织 | **npm workspaces**：`apps/*`、`packages/*`、`industry` | 一处改动全仓可见，不需要发版协调 |
| 前端 | **React Router**（SSR）+ React + Tailwind | 服务端渲染，爬虫和阅读器拿到的是完整 HTML |
| 接口 | **Fastify** | 公开读接口要能压量，后台写接口要能加校验 |
| 任务 | **pg-boss** | 队列就建在 Postgres 里，少一个要运维的中间件 |
| 数据 | **PostgreSQL** | 条目、事件、日报、会话、队列都在同一个关系库里；本机用 `embedded-postgres`，不依赖 Docker |
| 编辑判断 | 线上用真实模型；本机与 CI 用本地 stub + `tooling/fixtures/*.jsonl` | 付费调用一律过回执与预算熔断；测试不访问任何外部服务 |

---

## 肆 · REUSE 换成你的行业

`industry/` 是这棵树里和"地理"有关的东西该待的地方，其余是通用引擎——**换一个垂直领域，正常只需要动这一个目录**。
这是本仓库最值得抄走的一点。步骤在 [`docs/customize.md`](docs/customize.md)（那份文档的**步骤**成立、**数字**不成立）。

| 文件 | 管什么 |
|---|---|
| `site.ts` | 站名、行业词 `subject`（拼进日报名与列表名）、首页与关于页文案、MCP 工具名前缀、联系邮箱 |
| `taxonomy.ts` | 分类、内容类型、标签词表、机构名录、防张冠李戴的身份词典 |
| `topics.json` | 主题页目录（`/topics`）；主题数以这个文件为准，别抄进文档 |
| `sources.json` | 首次启动导入的信源（`ON CONFLICT DO NOTHING`，只增不改，之后在后台增删） |
| `prompts/` | 精选标准、写作要求、噪声例子——**行业 KnowHow 就写在这里**，改标准不用改代码 |
| `selection.ts` | 门槛与下限，文件头注释就是它的算式与"未校准"声明 |
| `features.ts` | 与本行业无关的模块在这里关掉 |
| `brand/` | 图标与日报报头字（报头由脚本按 `SITE.subject` 生成，改了行业词要重跑） |
| `pages/` | `terms.md`、`privacy.md`，目前是模板，上线前要主办者本人确认 |

要问使用者本人的，不要替他决定：站名；盯哪些信源；什么算重要、什么是噪声；分类怎么分；条款和隐私说明的内容。

---

## 伍 · LOCAL 本地运行

**干净克隆的第一步是 `npm run env:init`，不是 `npm ci` 之后直接起栈。**
`.env` 全被 `.gitignore` 排除，克隆里一个都没有；启动命令写的是 `node --env-file=.env …`，
文件不存在时 Node 会报 `.env: not found` 并以退出码 9 死掉。`scripts/init-env.ts` 会写出这几个文件、
为各个密钥生成真随机值，并**拒绝覆盖已存在的文件**。

本机跑法、端口对照表、起栈顺序、以及"默认端口在这台机器上保不住"的处置，都在
**[`docs/manual.md` 第 3 节](docs/manual.md)**——那份是操作口径，`docs/deploy.md` 是上游的 Docker 路线，本机没有 Docker。

改完至少跑这几样（细节与本机差异见 `docs/manual.md` 第 3.7 节与第 11 节）：

```bash
npm run typecheck
npm test                        # 测试库名必须以 _test / _ci 结尾，setup 会拒别的名字
npm run build -w @aihot/web
node scripts/smoke.ts --base http://localhost:3000
```

安全阀默认一律关闭（采集、模型调用、 embeddings、飞书、IndexNow）。
需要真跑管道时**叠一个一次性 env 文件**（`--env-file=.env --env-file=.env.pipeline`），不要把里面的开关合并进 `.env`——
那等于让测试去打外部服务。

---

## 陆 · NOTES 边界与设计笔记

- **不抄会动的数。** 本页与 `docs/` 里凡是"当场可数"的量都改成指针。上一版抄过一组线上快照并据此断言"落后再本机"，
  两句都不成立——靠抄录追一个会动的数是追不住的。这是规则，不是疏忽。
- **空状态是设计的一部分。** 主题页允许"0 条精选"，日报薄的时候它就照实写有多薄；热榜达不到门槛就是空榜。
  把空状态认真做成一个页面，而不是当成 bug 藏起来。
- **读者要行动的地方就有免责声明。** 命中灾害标签的条目页直接渲染"本站不是预警信息的发布机构，本页内容不构成预警依据"，
  不是只在 `/terms` 里藏着。
- **门槛是经验护栏，不是证明。** `industry/selection.ts` 的头注释自己算给你看：硬上限只封住一到两轴，
  把现行门槛读成"营销稿数学上不可能入选"就是误读了那份文档。真正在下限拦噪声的是预筛与信源分级。
- **信源默认只显示摘要加原文链接**（`site_fulltext` 关）；只有来源明确允许时才打开全文。
- 包名 `@aihot/*`、目录名 `industry/`、浏览器存储键是本仓库的内部标识，不对读者显示；
  按决定**不改名**——改名要动的量级用 `grep` 当场数，不抄在这里。

---

## 柒 · LICENSE 授权与出处

代码按 **MIT** 许可：[`LICENSE`](LICENSE) 原样保留上游文本、一个字没改，版权声明仍是上游框架
[AIHOT](https://github.com/KKKKhazix/AIHOT) 的作者——本站没有往里面加自己的版权行。
[`NOTICE`](NOTICE) 的上游部分同样原样保留，只在末尾**追加**一段衍生声明，说清这棵树是上游框架的修改衍生、
改了什么、没用什么名字。

两点必须说明白：上游 `NOTICE` 写明 **"The name "AIHOT" and the AIHOT logo are not licensed under the MIT License"**，
所以本站不复用它的名字与 Logo，只用文字声明衍生关系，这也不意味着上游认可或背书本站。
第三方素材各自受自己的条款约束（字体按 SIL OFL、机构标识归各自所有者），`NOTICE` 不替你授权这些；
`industry/sources.json` 里是各发布方的公开 feed，内容版权归他们。

---

## 捌 · STAR HISTORY 星际历史

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="Star History 星际历史：本仓库 GitHub Stars 随时间增长的曲线" width="100%">
</p>

▲ 曲线由 <a href="https://star-history.com">star-history.com</a> 动态生成，星数一变曲线就跟着长（GitHub 走图片代理缓存，更新会有几小时延迟）；仓库还年轻，这条线会从第一个星标开始有内容。

---

<div align="center">
  <sub>献给每一条有坐标、有数据、有人回去核对的消息。<br>编辑标准与代码 · 熊鑫晨 &nbsp;|&nbsp; 逐条判断由模型执行，标准写在 <code>industry/prompts/</code> &nbsp;|&nbsp; 2026<br><a href="docs/manual.md">docs/manual.md</a> · <a href="docs/geohot-runbook.md">docs/geohot-runbook.md</a> · 已上线 <a href="https://xxc2007.me/geohot/">xxc2007.me/geohot/</a></sub>
</div>
