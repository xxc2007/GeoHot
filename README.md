<sub>🌐 <b>中文</b> · <a href="README.en.md">English</a> · <a href="docs/manual.md">运营与开发手册</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="GEOHOT 标志：经纬线交汇处的一点青色热点" width="72">

# GEOHOT · 地理热点

**每天把地理读一遍。**

> 一场地震的震波、一座城市的边界微调、一幅刚刚回传的遥感影像——大地每天都在写下新的注脚。<br>
> GEOHOT 持续巡检全球 **1,000** 个公开地理信源，以**空间显著性**为尺，把同一事件的多方报道归并成脉络清晰的事件综述，在每个清晨编成一份便于回望的地理日报。

**读到要点，看到证据，也能回到原文。**

[![线上访问](https://img.shields.io/badge/线上访问-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![English](https://img.shields.io/badge/English-xxc2007.me%2Fgeohot%2Fen-176B75)](https://xxc2007.me/geohot/en/)
[![技术栈](https://img.shields.io/badge/技术栈-TypeScript_·_React_·_PostgreSQL-1F1E1D)](#技术架构)
[![MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

免费、免注册即读，现已全面支持**中英双语原生界面**（[中文版](https://xxc2007.me/geohot/) · [English](https://xxc2007.me/geohot/en/)），<br>
提供全文检索、学科筛选、本地收藏与 RSS 订阅；开发者与 AI Agent 可通过公开 API 与 **MCP** 接入同一套数据口径。

[宣传片](#-宣传片展示) · [阅读体验](#阅读体验) · [筛选流程](#信息如何成为精选) · [技术架构](#技术架构) · [开放接口](#站点与开放接口) · [可靠性与观测](#可靠性与观测) · [本地运行](#本地运行与二次开发) · [License](#-license) · [Star History](#star-history)

</div>

<p align="center">
  <a href="https://xxc2007.me/geohot/"><img src="docs/shots/home-light.png?v=5f0d9fbb01ca" alt="GEOHOT 精选首页：七个分类、搜索、当前热点与按时间排列的资讯卡片" width="820"></a>
</p>
<p align="center"><sub>精选首页 · 学科分类、当前热点与时间线资讯流 · 同步提供亮色纸感与深色遥测双主题</sub></p>

## 🎬 宣传片展示

全新 **72 秒 · 1080p 60fps** 官方宣传片（同步提供中文版与原生英文界面版）：以九幕高密度动态图形走完 GEOHOT 的完整脉络——从「经纬之交」标志亮相、3D 经纬球与全球信源网出发，进入真实官网 3D 镜头巡游、深色遥测空间显著性评分引擎、多源事件归并与 24h 半衰期热度曲线、早八点地理日报与主题墙，最后抵达 RSS / API / AI Agent MCP 全出口生态。配以原创 124 BPM 立体声配乐与帧级卡点音效。

点击下方播放器即可在本页观看：

https://github.com/user-attachments/assets/513b0a5a-def1-49a8-96c2-74c2d2497ffb

[▶ 打开 1080p 高清播放器](https://xxc2007.me/assets/promo/geohot/?v=20261016) · [直接打开中文版 MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo.mp4) · [英文版 MP4](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/promo/geohot-promo-en.mp4)

<sub>影片规格 1920 × 1080 · 60fps · 立体声 AAC。片中资讯为制作时的真实站点快照，最新动态请以线上页面为准。</sub>

## 阅读体验

### 从一条消息，读到一个完整事件

信息流中的每一张卡片都提供标题、摘要、推荐理由、信源出处与入选评分，让你在点开之前先判断价值。多方机构围绕同一场灾害、公报或发现持续发声时，系统将其归并至独立的**事件页**，以综述与报道时间线串联脉络；每一条线索底部始终保留原始链接，方便回到源头核对。

### 中英双语，以学科定方向、以日报作回望

除中文主站（`/geohot/`）外，站内已上线完整的**原生英文阅读版**（`/geohot/en/`），覆盖精选流、热点榜、主题页、关于页与双语成刊管线。每日 **08:00（Asia/Shanghai）** 准时出版地理日报，同步归档周报与月报（已累计出版 **320+** 期日报、收录 **134,000+** 条地理材料、精选 **7,190+** 条）。

| 分类 | 关注疆域 |
|---|---|
| **自然地理** | 地貌、气候、水文、土壤、植被与自然灾害事件 |
| **人文地理** | 人口、城市、产业、交通区位与城乡区域发展 |
| **区域地理** | 流域、极地、高原、三角洲与城市群的综合演变 |
| **政治地理** | 边界、领土、战略通道与海洋权益的空间格局 |
| **历史地理** | 河道与海岸变迁、政区沿革、历史城址与古地图考证 |
| **前沿地理** | 地理学与地球系统科学的新证据、新方法与学术突破 |
| **地理信息系统** | 遥感影像、导航定位、空间数据、GIS 平台与开源生态 |

完整分类词表与归类规范见 [`industry/taxonomy.ts`](industry/taxonomy.ts)。本地收藏仅存于当前浏览器；RSS、公开 API 与 MCP 让这套内容无缝融入订阅器与自动化工作流。

## 信息如何成为精选

**采集与判重 → 地理预筛 → 两次独立评分 → 分级门槛 → 事件归并 → 热度计算 → 定时成刊**

| 环节 | 运行机制 |
|---|---|
| **信源与预筛** | 持续采集已登记的 1,000 个公开信源（RSS / Web / JSON），规范化 URL 判重后先检验地理相关性与信息密度，拦截文旅软文与招生通稿。详见 [`industry/sources.json`](industry/sources.json) 与 [`prefilter.md`](industry/prompts/prefilter.md)。 |
| **评分与入选** | 依据统一空间显著性标准进行**两次独立评分**，以两次分数之和对比对应信源等级的入选门槛（官方一手宽容，媒体与个人更严），卡片展示平均分。细则见 [`industry/selection.ts`](industry/selection.ts)。 |
| **事件与热度** | 自动将同一事件的多方报道归并成章；热度依据独立信源覆盖与时间衰减（48 小时窗口、24 小时半衰期）计算，未达条件时宁可留白，绝不凑数。 |
| **写作与发布** | 生成双语标题、摘要、推荐理由、事件综述及定期刊物。所有对外出口统一经 [`publication/`](packages/backend/src/publication/) 读取，确保多端口径一致。 |

> **标准由人制定，逐条分析由模型执行。** 分类、信源、提示词与门槛沉淀在 [`industry/`](industry/) 目录中；后台支持人工抽查与修正，读者也可随时反馈纠偏。评分仅用于筛选排序，不表示事实真伪概率。

## 技术架构

GEOHOT 基于开源框架 [AIHOT](https://github.com/KKKKhazix/AIHOT) 构建，并将全部地理学科逻辑抽离至独立的行业配置层：`apps/` 与 `packages/` 负责通用应用与管线，`industry/` 集中存放地理分类、信源、提示词、品牌与页面文案。

| 层面 | 技术选型与职责 |
|---|---|
| **运行时与组织** | Node.js 24 原生执行后端 TypeScript，npm workspaces 统筹应用、共享包与行业配置（[`package.json`](package.json)）。 |
| **前端页面** | React Router 服务端渲染（SSR）+ React + Tailwind CSS，支持中英双语与亮暗双主题。 |
| **服务接口** | Fastify 提供公开只读 API 与需认证的管理接口，前后端经 HTTP 清晰解耦。 |
| **数据与队列** | PostgreSQL 存储条目、事件、刊物与会话，pg-boss 复用数据库管理异步任务与定时调度。 |
| **模型管线** | Worker 异步执行理解、翻译与写作，调用受[回执与预算护栏](packages/backend/src/providers/receipts.ts)约束；公开页面只读已生成内容，读者访问零模型开销。 |
| **出口一致性** | 网页、RSS、公开 API 与 MCP 共享统一发布读取层，消除多端内容口径偏差。 |

### 底层原理与运行流程

[![GEOHOT · 从公开信源到读者](docs/architecture/flow.zh.16901a4b8fe5.png)](https://raw.githubusercontent.com/xxc2007/GeoHot/main/docs/architecture/flow.zh.16901a4b8fe5.png)

<sub>点击打开 3600px 高清原图 · [可编辑 SVG 源文件](docs/architecture/flow.zh.svg) · 目录地图见 [PROJECT-MAP.md](docs/PROJECT-MAP.md)，演进史与审计台账见 [docs/history/](docs/history/README.md)。</sub>

## 站点与开放接口

以下路径相对于线上前缀 `/geohot/`（英文版位于 `/geohot/en/`）：

| 入口 | 用途 |
|---|---|
| `/` · `/en/` · `/all` | 中英双语精选信息流与全部动态，支持搜索与学科筛选 |
| `/story/:publicId` · `/items/:id` | 事件综述、多源报道时间线与单条资讯详情 |
| `/hot` · `/topics` | 实时热点榜与地理主题追踪页 |
| `/daily` · `/weekly` · `/monthly` | 地理日报、周报、月报与完整历史存档 |
| `/starred` · `/agent` · `/feedback` | 浏览器本地收藏、开发者 / MCP 接入说明与读者反馈 |

- **RSS**：精选 [`/feed.xml`](https://xxc2007.me/geohot/feed.xml)、全部 `/feed/all.xml`、日报 `/feed/daily.xml` 及分类订阅。
- **公开 API**：只读端点 `/api/v1/`，规范见 [`openapi-v1.json`](https://xxc2007.me/geohot/openapi-v1.json)。
- **AI Agent 接入**：原生 MCP 端点 `/api/mcp` 配套 `/llms.txt`，详见[接入页面](https://xxc2007.me/geohot/agent)；实时规模见[站点统计](https://xxc2007.me/geohot/api/site/stats)。

## 可靠性与观测

- **预计算统计快照**：后台用量总览与逐日统计基于 24 小时落盘快照每 30 秒自动刷新，避免重复重算，过期时先展示上次成功读数并后台平滑更新（口径见[官方费用折算](docs/admin-official-pricing.md)）。
- **公开健康探针**：`/api/health` 区分瞬时压力（`gate_busy` / `query_timeout`）与真实库故障（`conn_error` / `db_unavailable`）。
- **读者优先原则**：读者面连接池下限（DB ≥ 8、队列 ≥ 3）由服务器环境文件统一下发；读者可用性始终高于回填、清理与诊断任务。

## 本地运行与二次开发

需 **Node.js 24.11+**（以下以 Git Bash / WSL / POSIX shell 为准，完整手册见 [`docs/manual.md`](docs/manual.md)）：

```bash
npm ci
mv .env .env.bak 2>/dev/null; mv .env.pipeline .env.pipeline.bak 2>/dev/null
npm run env:init -- --db-port=5455 --api-port=3299 --web-port=3099 --brain-port=3065

npm run db:up -- --foreground --port=5455
npm run db:migrate
node --env-file-if-exists=.env scripts/seed.ts
node --env-file=.env --env-file=.env.pipeline tooling/brain-stub.ts
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts
npm run build -w @aihot/web && node --env-file=.env apps/web/server.ts
npm run smoke -- --base http://127.0.0.1:3099
```

> **后台起库（脚本 / Git Bash 自动化）**：不要用 `nohup npm run db:up`——Git Bash 里的 `npm` 是 `.cmd` 壳，`nohup` 会直接报错退出；请直接调 node 入口 `node scripts/dev-db.ts --daemon --port=5455`，日志位于 `%TEMP%/geohot-dev-db.log`，看到 `ready to accept connections` 或 TCP 探测通畅即表示就绪。`db:up --foreground` 与 `apps/web/server.ts` 是常驻前台进程，切勿套 `timeout`。

> **迁移条数以 `ls database/migrations/*.sql | wc -l` 现查**，不在文档里抄录固定数字；同理，门槛、信源数与命令一律以代码为准。

跑测试请使用以 `_test` 或 `_ci` 结尾的独立临时库，并仅传入 `DATABASE_URL`（勿叠加 `.env`）：

```bash
node --input-type=module -e "import postgres from 'postgres'; const s = postgres('postgres://geohot:geohot@127.0.0.1:5455/postgres'); await s.unsafe('CREATE DATABASE geohot_test'); await s.end();"
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5455/geohot_test npm run db:migrate
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5455/geohot_test npm test
```

> 如需迁移至其他垂直领域，从 `industry/` 入手配置站名、分类、信源与提示词即可（见[行业定制指南](docs/customize.md)与[运行手册](docs/geohot-runbook.md)）。

## 内容边界与开源许可

摘要、评分与事件综述仅作辅助阅读，重要数据请核对原始出处；灾害类内容不构成官方预警依据。

## 📄 License

[MIT](LICENSE) © 2026 数字生命卡兹克（上游框架）· GEOHOT 地理配置、双语演进与品牌维护：熊鑫晨。保留上游版权及 [NOTICE](NOTICE) 衍生说明。

## Star History

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="GEOHOT 仓库的 GitHub Star 历史" width="100%">
</p>

---

<div align="center">
  <sub>从一条消息出发，回到真实的大地。<br>编辑标准与代码 · 熊鑫晨 · <a href="https://xxc2007.me/geohot/">中文版</a> · <a href="https://xxc2007.me/geohot/en/">English</a></sub>
</div>
