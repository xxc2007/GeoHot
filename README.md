<sub>🌐 <b>中文</b> · <a href="README.en.md">English</a> · <a href="docs/manual.md">运营与开发手册</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="GEOHOT 标志：经纬线交汇处的一点青色热点" width="72">

# GEOHOT · 地理热点

**每天把地理读一遍。**

从一场地震、一座城市的变化，到一幅新的遥感影像，世界的变化每天都在留下新的地理线索。GEOHOT 持续采集公开信源，以空间显著性组织精选资讯，将同一事件的多方报道汇集起来，再编成便于回顾的地理日报。

**读到要点，看到证据，也能回到原文。**

[![线上访问](https://img.shields.io/badge/线上访问-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![技术栈](https://img.shields.io/badge/技术栈-TypeScript_·_React_·_PostgreSQL-1F1E1D)](#技术架构)
[![MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

无需注册即可阅读，支持搜索、分类筛选、本地收藏与 RSS 订阅；开发者也可以通过公开 API 和 MCP 接入同一套内容。

[宣传片](#-宣传片展示) · [阅读体验](#阅读体验) · [筛选流程](#信息如何成为精选) · [技术架构](#技术架构) · [开放接口](#站点与开放接口) · [本地运行](#本地运行与二次开发) · [内容与许可](#内容边界与许可) · [Star History](#star-history)

</div>

<p align="center">
  <a href="https://xxc2007.me/geohot/"><img src="docs/shots/home-light.png?v=5f0d9fbb01ca" alt="GEOHOT 精选首页：七个分类、搜索、当前热点与按时间排列的资讯卡片" width="820"></a>
</p>
<p align="center"><sub>精选首页 · 分类、热点与信息流 · 2026 年 10 月 16 日线上截图</sub></p>

## 🎬 宣传片展示

用 42 秒走过 GEOHOT 的主要阅读路径：浏览精选、按分类寻找内容、进入事件综述与报道时间线，再打开地理日报和主题页。画面取自真实网站，配以柔和钢琴与自然转场。

点击下方播放器即可在本页观看。

https://github.com/user-attachments/assets/d85128b8-810d-48b8-a6eb-3e032e81011a

[▶ 打开 1080p 高清播放器](https://xxc2007.me/assets/promo/geohot/?v=20261016) · [直接打开 MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo.mp4?v=20261016)

<sub>影片为 1920 × 1080，使用 Video Shotcraft 制作。截图与影片中的资讯为拍摄时的内容快照，最新动态请以网站为准。</sub>

## 阅读体验

### 从一条消息，读到一个事件

资讯卡片提供中文标题、摘要、推荐理由、来源与评分，便于先判断是否值得展开。同一事件的相关报道会归并到事件页，通过综述与时间线连接起来，让后续进展有迹可循。原文链接始终保留，方便进一步阅读和核对。

### 用分类找到方向，用日报形成回顾

首页精选适合快速浏览，「全部动态」提供更完整的检索入口；热点榜展示满足参与条件的事件，主题页帮助持续追踪。每日 08:00（Asia/Shanghai）排期生成地理日报，另提供周报、月报与存档。

| 分类 | 关注内容 |
|---|---|
| 自然地理 | 地貌、气候、水文、土壤、植被与灾害事件 |
| 人文地理 | 人口、城市、产业、交通与城乡发展 |
| 区域地理 | 流域、极地、高原、三角洲与城市群的综合变化 |
| 政治地理 | 边界、领土、战略通道与海洋权益 |
| 历史地理 | 河道与海岸变迁、政区沿革、历史城址与古地图 |
| 前沿地理 | 新的研究证据、方法、成果与学术进展 |
| 地理信息系统 | 遥感、导航定位、空间数据、GIS 软件与开源生态 |

分类定义集中在 [`industry/taxonomy.ts`](industry/taxonomy.ts)。收藏保存在当前设备的浏览器中；RSS、公开 API 与 MCP 则让内容可以进入个人订阅和自动化阅读流程。

## 信息如何成为精选

**采集与判重 → 地理预筛 → 两次评分 → 分级门槛 → 事件归并 → 热度计算 → 定时成刊**

| 环节 | 处理方式 |
|---|---|
| 信源与预筛 | 从登记的公开信源采集材料，规范化 URL 判重，再判断地理相关性与信息含量。信源配置见 [`industry/sources.json`](industry/sources.json)，预筛标准见 [`prefilter.md`](industry/prompts/prefilter.md)。 |
| 评分与入选 | 依据统一标准进行两次评分，以两次分数之和判断是否达到对应信源等级的入选门槛；卡片展示平均分。门槛与计算说明集中在 [`industry/selection.ts`](industry/selection.ts)。 |
| 事件与热点 | 将同一事件的多方报道归并；热度按独立来源覆盖与时间衰减计算，未满足参与条件时保留空榜。 |
| 写作与发布 | 生成中文标题、摘要及推荐理由，组织事件综述与定期刊物。公开内容统一经 [`publication/`](packages/backend/src/publication/) 读取。 |

**标准由人制定，逐条分析由模型执行。** 分类、信源、提示词与筛选规则保存在 [`industry/`](industry/)；后台支持抽查与修正，读者也可通过反馈入口指出问题。评分用于内容筛选，不表示事实正确的概率；现行门槛仍是经验参数，尚未通过人工标注集完成校准。

## 技术架构

GEOHOT 基于开源框架 [AIHOT](https://github.com/KKKKhazix/AIHOT) 构建，以地理行业配置组织内容。应用与通用处理逻辑位于 `apps/`、`packages/`，地理相关的分类、信源、提示词、品牌和页面配置集中在 `industry/`。

| 层面 | 选型与职责 |
|---|---|
| 运行时与组织 | Node.js 24 直接执行后端 TypeScript，npm workspaces 管理应用、共享包与行业配置。版本要求见 [`package.json`](package.json)。 |
| 页面 | React Router 服务端渲染、React 与 Tailwind CSS，提供信息流、事件、刊物与主题页面。 |
| 接口 | Fastify 提供公开只读接口与需要认证的管理接口。前端通过 HTTP 访问后端。 |
| 数据与任务 | PostgreSQL 存储条目、事件、刊物与会话；pg-boss 复用数据库管理队列与定时任务。 |
| 模型处理 | worker 执行分析与写作任务，调用经过[回执与预算控制](packages/backend/src/providers/receipts.ts)；公开页面读取已生成内容，阅读本身不触发模型调用。 |
| 一致性 | 网页、RSS、API 与 MCP 共享发布读取层，减少不同出口的内容口径差异。 |

## 站点与开放接口

以下路径均相对于线上站点的 `/geohot/` 前缀。

| 入口 | 用途 |
|---|---|
| `/` · `/all` | 精选与全部动态，支持搜索和分类筛选 |
| `/story/:publicId` · `/items/:id` | 事件综述、报道时间线与单条资讯 |
| `/hot` · `/topics` | 事件热点榜与主题追踪 |
| `/daily` · `/weekly` · `/monthly` | 日报、周报、月报及对应存档 |
| `/starred` | 当前浏览器中的本地收藏 |
| `/agent` · `/feedback` | 开发者接入说明与读者反馈 |

- **RSS**：精选摘要 [`/feed.xml`](https://xxc2007.me/geohot/feed.xml)、全部动态 `/feed/all.xml`、日报 `/feed/daily.xml`，另有周报、月报及分类订阅。
- **公开 API**：只读端点位于 `/api/v1/`，接口规范见 [`openapi-v1.json`](https://xxc2007.me/geohot/openapi-v1.json)。
- **Agent 接入**：MCP 端点 `/api/mcp`，配套 `/llms.txt`；使用说明见[接入页面](https://xxc2007.me/geohot/agent)。
- **当前数据**：信源与内容规模以[站点统计](https://xxc2007.me/geohot/api/site/stats)及线上页面为准。

## 本地运行与二次开发

需要 Node.js 24.11 或更高版本。安装依赖后，先初始化本地配置：

```bash
npm ci
npm run env:init
```

初始化脚本会生成本地环境文件和所需随机密钥，并拒绝覆盖已有配置。数据库、API、worker 与网页服务的启动顺序、端口设置和检查命令见[运营与开发手册](docs/manual.md)；仓库提供本地模型 stub 和固定夹具，用于开发与 CI 验证。

默认保持采集、模型调用等外部访问开关关闭。需要运行真实管道时，按手册叠加独立环境配置，保留开发与测试环境的隔离。

希望用于其他垂直领域，可从 `industry/` 入手配置站名、分类、信源、提示词与品牌。目录职责和迁移步骤见[行业定制指南](docs/customize.md)，实际配置值以代码为准；部署说明见[运行手册](docs/geohot-runbook.md)。

## 内容边界与许可

摘要、评分和事件综述用于辅助阅读，重要信息仍应核对原始来源。涉及灾害与预警的内容不构成预警发布或行动依据。信源默认展示摘要与原文链接，全文展示须遵循来源授权。

代码采用 [MIT 许可](LICENSE)，保留上游版权及 [NOTICE](NOTICE) 中的衍生说明。GEOHOT 使用自己的站名与标志，上游名称和标志不随代码许可一并授权；第三方素材与信源内容遵循各自条款。完整说明见站内条款与隐私页面。

## Star History

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="GEOHOT 仓库的 GitHub Star 历史" width="100%">
</p>

---

<div align="center">
  <sub>从消息出发，回到地理。<br>编辑标准与代码 · 熊鑫晨 · <a href="https://xxc2007.me/geohot/">在线阅读</a></sub>
</div>
