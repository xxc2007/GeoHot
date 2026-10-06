<sub>🌐 <b>中文</b> · English（暂无英文版） · 完整手册见 <a href="docs/manual.md">docs/manual.md</a></sub>

<div align="center">

<img src="https://raw.githubusercontent.com/xxc2007/GeoHot/main/industry/brand/logo.svg?v=2" alt="经纬之交：墨色地球被一条经线与三条纬线切开，青色热点落在北纬与经线的交点上" width="72">

# GEOHOT · 地理热点

> *「关于这片土地的消息每天都有，有依据、值得写的，只有几条。」*

[![Status](https://img.shields.io/badge/%F0%9F%8C%90_线上访问-xxc2007.me%2Fgeohot-D97757)](https://xxc2007.me/geohot/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Derived from AIHOT](https://img.shields.io/badge/派生自-AIHOT_框架-1F1E1D)](NOTICE)
[![Node](https://img.shields.io/badge/运行时-Node_24-1F1E1D)](#技术栈)
[![Categories](https://img.shields.io/badge/分类-七个-D97757)](#-七个分类一条标准)
[![Sources](https://img.shields.io/badge/信源-98%2B1_个-D97757)](#-现状与边界)
[![Editorial brain](https://img.shields.io/badge/%E7%BC%96%E8%BE%91%E5%A4%A7%E8%84%91-Agnes%203.0%20flash%20%C2%B7%20%E6%A0%87%E5%87%86%E7%94%B1%E4%BA%BA%E5%AE%9A-1F1E1D)](#-编辑大脑标准是人定的逐条判断交给模型这一点写进条款)
[![GitHub](https://img.shields.io/badge/GitHub-@xxc2007-1F1E1D)](https://github.com/xxc2007)

<br>

**每天把地理这件事读一遍，只留下有依据、值得写的几条。**

<br>

盯住台站、卫星机构、统计与区划部门、期刊和研究者的信源，按**空间显著性**筛出少数几条，写成中文标题与摘要，把同一件事的多方报道并成一个事件，每天早上 08:00（Asia/Shanghai）出一份日报。免费、不用注册，每条都留着原文地址。

它建在开源框架 [AIHOT](https://github.com/KKKKhazix/AIHOT)（MIT）之上，行业层换成了地理：引擎在 `apps/` 与 `packages/`，地理的一切——站名、分类、主题、信源、评分标准、门槛、品牌、条款页——都在 [`industry/`](industry/) 这一个文件夹里。

[特色](#-特色) · [七个分类](#-七个分类一条标准) · [站点结构](#-站点结构) · [技术栈](#技术栈) · [换成你的行业](#-换成你的行业) · [本地运行](#-本地运行) · [设计笔记](#-设计笔记) · [License](#-license) · [星际历史](#-star-history) · [完整手册](docs/manual.md)

<br>

> 这一页是介绍页。**操作手册**（本机跑法、端口对照、检查命令、已知边界、上线前清单）在 [`docs/manual.md`](docs/manual.md)——它就是这棵树原来的 README，内容一字未删地搬了过去。日常运营读 [`docs/geohot-runbook.md`](docs/geohot-runbook.md)，精选与校准读 [`docs/selection.md`](docs/selection.md)，换行业读 [`docs/customize.md`](docs/customize.md)，信源怎么配读 [`docs/sources.md`](docs/sources.md)，部署读 [`docs/deploy.md`](docs/deploy.md)，**换域名或换服务器**读 [`docs/migration.md`](docs/migration.md)，进程与目录读 [`docs/architecture.md`](docs/architecture.md)。这份清单里只有 `README.md`、`docs/manual.md`、`docs/geohot-runbook.md`、`docs/migration.md` 与 `docs/known-issues.md`（那份按轮次追记的待办清单，下面多次引用）是本站写的，其余（`customize/selection/sources/architecture/leaderboard/deploy`）都还是上游参考文档，若干命令与数字在本站不成立——**哪份文档该打折、逐条打到什么程度，看 [`docs/manual.md` 第 9 节那张"文档 × 状态"表](docs/manual.md)**（那张表是本仓库的反腐烂装置：它按文档逐条写明哪些说法已经不成立、哪些只是抄录）。

</div>

---

<p align="center">
  <img src="docs/shots/home-light.png" alt="首页精选：顶部是「当前热点」四条（名次、标题、信源头像、热度与走势），左侧导航，筛选栏含七个分类，下面是按日期分组的精选卡片" width="100%">
</p>

▲ 首页「精选」· 截图摄于 **2026-10-04 22:08（+0800）**，路由 `/geohot/`，视口 1440×900，浅色主题 · 画面顶部那一块是**当前热点**：四条事件按热度排开，每行是名次、标题、正在讨论它的信源头像（精选组，最多三枚 +N）、热度数值与走势箭头，右上角「完整榜单」进 `/hot`。标题旁边写着 **截至 10月3日 14:55**——这一张榜不是这一小时的。热榜每 5 分钟重算一次，某一轮算出空榜时不再把首页抹掉：`packages/backend/src/events/hot.ts` 只在有事件时把那一张发布出去，读侧 `packages/backend/src/events/hot-read.ts` 于是回落到最近一张有事件的榜（最长 24 小时），其中事件已被归并到别处的条目先掉出榜、名次接着排。榜不老于两小时时这里不写时刻，只有一颗跳动的红点。**如果打开首页看到的是另一行字**——「过去 48 小时还没有两家以上信源同时讨论的事件。」加一个 `/all` 入口——那不是故障，是这张榜已经老过一天，页面改说实话；两种样子的取舍写在 `apps/web/app/features/feed/HotTopics.tsx` 顶部的注释里。侧栏**没有**「板块」那一格：那一层 2026-10-04 整块删除，`/geohot/boards` 现在返回 404。时间线是 10月2日 1 条、10月1日 49 条，第一条是 The Guardian·环境、入选分 83 的《「像照顾宠物一样」：一款提醒你街区里的树是否缺水的应用》。筛选栏 **8 格**：`全部` 加**七个分类**，末尾两格是「地理信息系统」「考研」——2026-10-03 把这两格换位、并删掉了「野外与考察」与「观点与解读」；2026-10-04 晚又删掉 `一手` 那一格（它是 `first_party` 数据字段的渠道别名，和「全部 + 分类」这一行做的是同一件事；`first_party` 字段本身照旧在评分、日报「件一手发布」与事件页「官方一手」里用着）。（这一张图的上一版说明把"画面里没有当前热点条"归因于"热点榜是空的"，那时真正的原因是旧代码在榜少于 3 条时把整块隐藏——归因错了，错记留在 `docs/known-issues.md`，不抹掉。）**这一屏每天在变，线上地址才是事实来源**：`https://xxc2007.me/geohot/`。

---

## ✨ 特色

### 🧭 七个分类，一条标准

分类是这个站的骨架（`industry/taxonomy.ts`，`key` 直接进 URL，上线后不再改）：

| key | 分类 | 收什么 |
|---|---|---|
| `physical` | 自然地理 | 地貌、气候、水文、土壤、植被与灾害事件，须有观测数据、图件或影像 |
| `human` | 人文地理 | 人口与迁移、城市化、产业与交通区位、行政区划调整、城乡与区域政策 |
| `regional` | 区域地理 | 以区域或流域为单位的整体性变化：极地、青藏高原、三角洲、城市群、跨境河流 |
| `geopolitics` | 地理与政治 | 主权、边界与领土的划定与争议，地缘格局、战略通道、跨境河流与海洋权益 |
| `histgeo` | 地理与历史 | 历史时期的地理变迁与古今对照：河道海岸线、政区疆域沿革、城址兴废、古地图 |
| `geotech` | 地理信息系统 | 遥感与影像、导航定位、观测数据集与标准的发布，以及 GIS 软件与平台、空间数据库与标准、WebGIS 与三维引擎、开源生态与许可变更 |
| `geoedu` | 考研 | 地理学科的招生政策与专业目录、学科与学位点、考试大纲与分数线、招考数据 |

> 2026-10-03 一天里改了两次，都是站长看首页筛选栏提出的。**先是合并**：「地理信息技术」与「地理信息系统」并成一个区域，名字用「地理信息系统」，分类 `key` 保留 `geotech`——它已经在网址与库里，词表头部写着上线后不可改；另一个 key `gis` 只活了几个小时，名下的行由迁移 `0040` 并到 `geotech`。**接着是删两个分类**：`fieldwork` 野外与考察、`comment` 观点与解读**彻底删掉**，不是改名也不是隐藏——筛选栏、卡片角标、日报分节、RSS 分类订阅、公开 API 与 MCP 的枚举、提示词里的分类清单一起消失。这两个 key 名下的行（线上 21 行，其中精选 8 条）由迁移 `0041` 逐条改归到剩下的五个学科分类，`selectbench_results` 那张基准表**不动**——它是历史模型的答题存档，改写等于伪造记录。
>
> 删掉的两个分类原本共用日报的第三节「实践」。**兜底分节从那一节挪到了「未归类」**：没有类别的资料进日报时落在 `DEFAULT_SECTION` 这一节，它是 `packages/backend/src/reports/compose.ts:26` 的一个显式常量（`:28` 的 `REPORT_SECTIONS = [...SECTION_ORDER, DEFAULT_SECTION]`），不是"分类数组的末位"——早先的版本按末位推导，删一次分类就会把全站没归类的资料整体搬到别的一节去。这条不变量由 `tests/report-default-section.test.ts` 与 `tests/exit-category-parity.test.ts` 两处钉住。

**没有单独的「板块」页。** 这一层曾经存在过：2026-10-03 上线的四个跨类别方向页（`/boards`：地理信息系统 / 考研 / 地理与政治 / 地理与历史，当时与筛选栏同序）在 **2026-10-04 按站长要求整块删掉**——站长看着那一页说「这个板块功能有点重复了」，它按学科与用途把条目归到一处（页面文案当时写的是"当天"，而它其实不设时间窗——按时间倒序取最近的若干条），而主题页与筛选栏的分类已经在做同一件事。现在 `/boards` 与 `/boards/<slug>` 都是 404。四个方向**没有丢入口**：它们本来就是首页筛选栏里的四个分类（`/all?category=geotech` / `geoedu` / `geopolitics` / `histgeo`），未精选的信源原文在「全部动态」里同样列得出来；主题页（`/topics`）继续按区域、机构与领域串联同一件事的来龙去脉。**删的只是视图**——条目、`category` 字段、分类词表与公开门槛一行都没动，`industry/sources.json` 里那 46 条 `defaultCategory` 照旧把条目归到它所属的分类。

**入选标准只有一条：空间显著性优先**——影响尺度大、多方独立报道、有数据/图件/影像支撑，三件同时成立才排得靠前。这条既写进评分提示词，也写进五轴权重表，还写进热度算法（"多方独立报道 = 热"）。

**明确压制的噪声**：旅游软文、研学与营地招生、教研培训与课件推销、景区宣传通稿；此外还有无数据的泛泛地方介绍、未经核实的地理传闻、纯机关公文与会议通报、多主题盘点汇编。这些在**预筛**阶段就被 `BLOCK`，到不了评分那一步。

### 🚪 一条资料进站的七步

**采集 → 预筛 → 两次独立打分 → 门槛 → 归并成事件 → 热度 → 日报**

- **预筛**（`industry/prompts/prefilter.md`）：是不是地理的事、有没有实在信息。`BLOCK` 的材料不出现在任何公开页面。
- **两次独立打分**：同一份评分标准串行调用两次（0–100），**两次之和 ≥ 2 × 门槛**才入选，卡片显示两次的平均（向下取整）。
- **门槛按信源分级**：`T1` 56 / `T1_5` 59 / `T2` 62（入选线之和 112 / 118 / 124），另有 `understandFloor` 46——没入选但过这条线的也用精选的写法出中文标题与摘要。现值只写在 [`industry/selection.ts`](industry/selection.ts)，那个文件的头注释就是它的算式，也写着**这组数是推出来的、还没被 gold 集校准过**。
- **归并成事件**：多家报道同一件事并成一个事件，事件页有综述；入选的材料要等归组完成才出现在精选里，避免同一件事先冒出好几条。
- **热度**：48 小时窗口、24 小时半衰期、每个独立来源只投一票，至少 2 位参与者且至少 1 位是编辑类信源。
- **成刊**：日报每天 08:00，周报周一 10:00，月报每月 1 日 10:30；条目按热度排，分节是学科 / 技术两节（2026-10-03 删掉「实践」一节，见上面分类那节的说明）。

### 🖋 编辑大脑：标准是人定的，逐条判断交给模型，这一点写进条款

**线上跑的是真模型**：2026-10-06 起，本站接入第三方大模型服务（Agnes AI 的 `agnes-3.0-flash`，OpenAI 兼容接口），由它完成预筛、两次独立打分、中文标题与摘要、事件归并。框架只在真要调模型的那一刻读 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，所以换服务商是改 `.env` 那三行，代码一行都不用动；`MODEL_CALLS_ENABLED` 是总闸，每一次付费调用都过回执表与每分钟/每小时/每天的预算熔断（现值 40 / 1500 / 12000，超了就暂停，不会一夜刷爆）。

- **标准仍然是人定的**：分类表、重要性口径（空间显著性）、噪声清单、门槛分数、提示词全部写在 `industry/` 里，由站长逐条确认；模型按这套标准出逐条结论，站长在后台抽查并覆盖（`editorial_overrides`），读者也能通过「反馈」指出错误。
- 闸门是真的：预筛、两次独立打分、门槛、归组的三值关系、48 小时历史闸门、日报分节、公开读取层，**全部走真实代码，一句都没被绕过**。
- **本机开发与 CI 不花钱也不外发**：仓库保留一个只听 127.0.0.1 的本地 stub（[`tooling/brain-stub.ts`](tooling/brain-stub.ts)），它按"这条材料是哪一步、是哪一篇"回放 `tooling/fixtures/*.jsonl` 里人工写定的判断；没有 fixture 的材料落在确定性默认值上（打分 20，两次之和 40，过不了任何一档的 2× 线）。测试永远不访问任何外部服务，靠的就是这一层。
- 中文一手信源有一条兜底：模型没给中文摘要时，摘要退回**来源自己那段话的开头**（同一处长度口径，不是改写；英文材料一律不给）。这条是 2026-10-05 那次"全站停更"的教训——反造假的闸门一旦没有稿子可回放，就会把本来就是中文的条目一起扣住。
- 界面上那颗分数徽标仍写作「AI 评分」（沿用上游措辞），它显示的是两次独立评分的平均值——在本部署里，那两次分数来自人工写下的判断。

### 📊 现状与边界

本机开发库内实测，**截至 2026-10-06 上午**（这些数字每天都在动，别当承诺读）：

| 收录材料 | 归并成的事件 | 精选 | 启用信源 | 主题 | 日报期数 |
|---:|---:|---:|---:|---:|---:|
| 2842 | 1627 | 48 | 87 | 43 | 4 |

（「收录材料」是本机 `publications` 表里 `visibility <> 'withdrawn'` 的行数，「归并成的事件」是 `facts` 表的行数。「精选」这一列数是**读者真正看得到的**那些，算式与读取层同一份（`packages/backend/src/publication/items.ts` 的 `selectedCondition()`：公开、已选中、过释放时间、标题含中文）；库里 `selected` 标记为真的更多（本机 59 条），差的那部分是标题还没有中文副本、按设计先待在后台的条目。表里的「日报期数」是本机 `reports` 表里 `kind = 'daily'` 的行数（算式就是 `packages/backend/src/site/stats.ts` 里 `AS dailies` 那一行的 `WHERE kind = 'daily'`；同一张表现有 7 行 = 4 份日报 + 1 份周报 + 2 份月报，`SELECT kind, count(*) FROM reports GROUP BY kind` 当场可查），含 0 件大事、已被读取层过滤不再列出的空刊。）

**线上出了几期、有多少条精选，都不写在这里**——那是每天在变的量，抄进介绍页只会过期。**这一版原先在这里抄过一组线上快照（`items` 5371、`sources` 58）并断言"线上这套数字落后于本机，因为那 27 条新信源与主题层删除还没随整包升上去"——两句都不成立**：2026-10-04 实测线上 `/api/site/stats` 的 `sources` 已是 **85**，按 kind 的分布（`rss` 51 / `web_list` 23 / `external` 8 / `json_list` 3）与 `industry/sources.json` 逐档相同；`/topics` 页面上的主题链接数与 `industry/topics.json` 一样是 **43**，被 0042 删掉的两页 `/topics/fieldwork`、`/topics/opinion-analysis` 现在都返回 404——整包早就升上去了。而 `items` 那一格在同一天两小时里就从 5371 漂到 5792（`curl -s https://xxc2007.me/geohot/api/site/stats` 现查），抄进介绍页必然过期；那句自指"下面第 108 行"当时也已经指错了行。所以这里只留端点：`https://xxc2007.me/geohot/api/site/stats` 一次给全（`items` / `selected` / `dailies` / `sources` 与按 kind 的分布），归档期数看 [`/daily/archive`](https://xxc2007.me/geohot/daily/archive) 或 `GET /api/v1/dailies` 的 `items` 长度（这个接口**没有** `page.count` 字段，别看错）。本机那一列不一样：`.env` 里 `COLLECT_ENABLED=false`，开发库是静态的，所以上面那张表当场可复算。

精选按分类的**分布不在这里抄**——那是线上每天在变的量（上一版抄的"53 条：自然地理 28 · 区域地理 12 · 人文地理 6 · 地理信息系统 5 + 2 条无分类"恰好在 2026-10-04 13:35 又对了回来，但那是巧合不是维护，靠抄录追一个会动的数是追不住的）。现查：`curl -s "https://xxc2007.me/geohot/api/v1/selected/snapshot?limit=200"` 按 `items[].category` 数一遍，它应与 `/api/site/stats` 的 `selected` 相等（2026-10-04 实测两边都是 53；不一致就是出口之间又裂开了，见下面「站点结构」那一节讲的同一份门槛）。**删掉的两类名下的行没有消失**，是按内容逐条改归到剩下的分类里——迁移 `0041` 的映射表把每条都写明了理由，不是一刀切进某个桶；`fieldwork` 与 `comment` 这两个 key 现在库里一行都不剩（`SELECT category, count(*) FROM publications GROUP BY category` 可查，本机开发库实测只剩**六个** key 与 NULL——七个分类里的 `geoedu` 在库里一行都没有，`GROUP BY` 不会把零行的那一档列出来，所以"七个 key"是数词表不是数查询结果）。

**信源数量的唯一说法在这里**（其余文档一律指向本段，别再抄一份数字）：登记在 [`industry/sources.json`](industry/sources.json) 的是 **98 条**（`node -e "console.log(require('./industry/sources.json').sources.length)"` 当场可数；2026-10-04 下午从 85 加到 87——中新网·即时新闻与 BBC 中文（简体），两家都是在采集那台机器上用采集器自己的 UA 实测过、第一次抓取各入库 30 条才算数。当晚又从 87 加到 90，三条都是中文 `web_list`：**教育部·新闻发布**（分类「考研」，那一类此前只有一条源）、**中国科技网（科技日报）要闻**、**国家发展改革委·新闻动态**——每条都在部署后用 `scripts/collect.ts` 在生产库真抓过（首次入库 15 / 15 / 20 条）。同一批试过的**地理学报·当期目录**又退回了：本机能抓（15 条）、**采集器那台机器两次都 `fetch failed`**，接不进生产就不是信源；它原先的人工投递通道（`ext-acta-geographica-toc`）原样留着。同一批还试过人民网·时政/国际/科技三个 RSS，**又退回了**：feed 本身活着（200、`text/xml`、各 100 个 `<item>`），可里面最新一条分别是 2025-06-03 / 2025-06-04 / 2021-02-01——那是一个不再更新的快照，"200 加 100 条"骗过了探测，是第一次抓取入库 0 条才把它暴露出来）。第二十四轮（2026-10-05）把出口试到了平台层：**8 个 X 官方账号**（`x_search`，账号存在性用 x.com 的页面标题逐个核过）登记在内、全部停用；**3 个 YouTube 官方频道**（USGS / NASA / NOAA）当轮实测通了又按要求撤下——视频文件从不下载，库里只存元数据，但条目页那张封面会和站内其它图片一起被签名代理渲染成小文件写进本地缓存目录，站长要的是本地磁盘不涨，所以信源包是 90 → 98。频道 id 与逐条实测记录留在 [`docs/sources.md`](docs/sources.md) 的「平台信源」一节，接回来照那一节做。本机库里 `sources` 表是 **100 行**——多出的两行都不在信源包里：一行是投递接口在运维校验时自动建的 `external` 占位源 `ext-opscheck-ingest-probe`（站上不可见，清理 SQL 在 `scripts/README-ingest.md` 末尾），另一行是试接地理学报时登记的 `cn-web-geog-toc`（包里已经把它退回，而 `scripts/seed.ts` 是 `ON CONFLICT (id) DO NOTHING` 只增不改，所以那行还留在库里、`enabled=true`；要清走用 `scripts/delete-sources.ts`，不要去改 `stats.ts` 让数字看起来对齐），所以顶上那枚徽标写「98+1」。这 98 条里 **82 条是可轮询的那一族**（53 `rss` + 26 `web_list` + 3 `json_list`）、**8 条 `external`** 是给人工投递预留的通道（`participation_mode=isolated`，站上暂不可见）。可轮询那 82 条里 **77 条真的在轮询**，另外 5 条第三十轮（2026-10-06）改成了 `enabled=false`：`intl-unocha` 的订阅口对所有非浏览器客户端回 406 并挂着「Blocked due to bot activity」的告示（本站不伪造浏览器指纹去绕它），`web-thepaper-topnews` / `web-cea-fzjzyw` / `web-mnr-ywbb` / `web-cjw-cjyw` 四条境内官方站从境外的采集出口取不到（本机 curl 全 200，采集机上分别是 403、403、DNS 无应答、TCP 连不上）——逐条实测与「采集出口搬到境内就改回来」的话写在 [`docs/sources.md`](docs/sources.md) 的「第三十轮」一节。轮询那 82 条按分级是 `T1` 48 / `T1_5` 15 / `T2` 19，按语种是中文 29 / 英文 53，其中 **53 条标了 `first_party`**（自己就是发布方，不是转述别家），中文一手层 23 条；只算在轮询的 77 条则是 `T1` 44 / `T1_5` 15 / `T2` 18、中文 25 / 英文 52、`first_party` 50、中文一手 20。可轮询的来源横跨中英两种语言与机构、媒体、期刊、软件发布四类：国际机构（USGS、NASA Science、NOAA、GDACS、Copernicus、WMO、ESA；UN OCHA 登记着但本轮起停用，理由见上）× 国际媒体与智库（The Diplomat、World Politics Review、Foreign Affairs、Crisis Group、对话地球、The Conversation）× 软件与标准（OGC、QGIS releases）× 历史与地图（国会图书馆地图部、Public Domain Review、欧洲环境史学会）× 国内部委与科研院所 20 条（中国地震台网中心、中央气象台、国家气候中心、国家统计局、自然资源部、中国地质调查局、生态环境部、国家林业和草原局、中国地震局、应急管理部、水利部本部及黄河/长江水利委员会、中科院地理科学与资源研究所两条、中国极地研究中心、澎湃新闻、《地理研究》当期目录等；这一族里 16 条在轮询，自然资源部、中国地震局、长江水利委员会、澎湃新闻那四条是境外出口取不到的）。本站唯一的按次计费出口是那 8 条 `x_search`：本部署没有 `SOCIALDATA_API_KEY`，它们全部登记为 `enabled=false`（`tests/industry-pack-sources.test.ts` 把「按请求计费必须登记为停用」钉成断言），所以轮询侧不产生账单。**98 条里 54 条声明了 `defaultCategory`**，把条目直接归到它所属的分类（见上）；其余按模型/人工判断归类。

**已部署**：[`xxc2007.me/geohot/`](https://xxc2007.me/geohot/)（2026-10-01）。四个常驻单元只监听回环、各自带内存上限，装在同一台跑着主站与 Artalk 的机器上，主站首页逐字节未变（`51432` 字节 / `4edf0fc53636a680…`，2026-10-03 又用 `curl -s https://xxc2007.me/ | wc -c` 与 `sha256sum` 复核过一遍）。怎么装的、验证命令、以及部署时踩过的坑（那张「症状 → 真正原因」表），都在 [`deploy/geohot/DEPLOYMENT.md`](deploy/geohot/DEPLOYMENT.md)。**日报已出刊**：`/daily` 给的是**最新一期**（这一句不写期号与日期，每天 08:00 它都会变），下面那张图拍的是 **2026-10-03 第 2 期**（`/daily/2026-10-03`，与那张图自己的说明同一期——上一版这里写成"2026-10-02 第 1 期"，与图说明对不上，同一张图给了两期）。另一期 `/daily/2026-10-02` 是 2026-10-02 第 1 期，线上现查的报眼五个指标是 **21 件大事、14 个来源、12 件一手发布、5 项技术与数据发布、约 9 分钟读完**（2026-10-04 实测 `curl -s https://xxc2007.me/geohot/daily/2026-10-02` 去标签即得；上一版这里写的"约 10 分钟"是错的，还漏了"技术与数据发布"那一格）——这些数字属于那一期，不属于"今天"。上线首日（10-01）`/daily` 确实是诚实的空态——worker 在当天 08:00 档期之后才起，那份日报本来就属于第二天，原因与空刊怎么被读取层过滤，写在 [`docs/known-issues.md`](docs/known-issues.md)。

还没做好的地方单独列了一份 [`docs/known-issues.md`](docs/known-issues.md)：被撤下的综述溯源校验器（会误删忠实内容）、GDACS 绿色通报的英文模板标题进了公开池、摘要质量闸门、以及上游文档与本站不符之处。这份清单不是免责声明，是待办列表。

<p align="center">
  <img src="docs/shots/hot-light.png" alt="地理热点榜满榜的样子：NO.01 大卡带事件正文、最新进展与热度指数，右侧两张小卡各带 24 小时走势，页头同一行写着「过去 48 小时，讨论最多的 4 个地理事件」与更新时间" width="100%">
</p>

▲ 热点榜 `/hot` · 截图摄于 **2026-10-04 22:08（+0800）**，路由 `/geohot/hot`，视口 1440×900，浅色主题 · 画面里是**满榜**的样子：页头「过去 48 小时，讨论最多的 4 个地理事件」，同一行右边写着 **10月3日 14:55 更新 · 按讨论热度排序**——这一张榜不是这一小时算的，那行时刻就是它的截止时间（读侧最长保留 24 小时，超过就换成空态，与首页那张是同一张榜）。NO.01 是四川宜宾高县 M4.5 地震：三方测定读数不齐的正文、一行「最新进展」、「中国地震台网中心 CENC 地震速报目录、USGS 全球地震目录 M4.5+（近一周）等 3 个来源 · 3 位参与者」、热度指数 8 与 ↓15%；NO.02、NO.03 两张小卡各带 24 小时走势（2 个来源 · 2 位参与者），「继续看 No.04–04」下面是第 4 条洛亚蒂群岛海域 M6.6 地震，页脚有「热度是怎么算的？」入口。**热度门槛**：48 小时窗口内至少两个独立参与方、其中至少一家是编辑类信源（四个参数写在 `packages/backend/src/events/hot.ts`），达不到就是空榜。2026-10-03 上线当晚线上实测：窗口内 2639 个事件只有 24 个参与方，几乎每条预警各自成一个单来源事件；往前 48–96 小时那个窗口里有 6 个合格事件，所以榜更早的时候是满的（原始记录在 [`docs/known-issues.md`](docs/known-issues.md) 第八轮第 5 条）。**别拿本机复现那些数**：本机开发库的收录材料比线上少一半以上，按同一窗口口径复算对不上属正常。榜单每 5 分钟重排，**这一屏以线上为准**：`https://xxc2007.me/geohot/hot`（或 `GET /api/v1/hot-topics`）。
<p align="center">
  <img src="docs/shots/daily-light.png" alt="地理日报头版（2026-10-03 第 2 期）：报头字、期号卡、导读与分节正文" width="100%">
</p>

▲ `/daily` · 截图摄于 **2026-10-04 22:08（+0800）**，视口 1440×900，浅色主题；拍的是**那一刻的最新一期**（`/daily` 每天都换，这一版是 **2026-10-03 第 2 期**，固定地址 `/daily/2026-10-03`，左侧「往期」里 10月3日 高亮）。这一期 **1 件大事、1 个来源、0 件一手发布，约 1 分钟读完**，头条是《「像照顾宠物一样」：一款提醒你街区里的树是否缺水的应用》，本期版面只有一节：**实践**，1 件——这一节是 2026-10-03 删除两个分类之前成的刊，日报分节名是**写死的历史快照**，不随词表回改（这一期唯一那条资料在库里没有分类，旧词表下按兜底分节落进「实践」；新刊不会再出现这一节）。顺便说清一件事，**并且写清是哪一边的库**：线上那期 **10-04 的日报确实生成了，但一个分节都没有**，读取层会跳过没有内容的期，所以当天 `/daily` 回落到 10-03。这一条当场可查：`curl -s -o /dev/null -w '%{http_code}' https://xxc2007.me/geohot/daily/2026-10-04` → **200**，页面上写着「本期没有入选内容」（指名一期空刊给 200 的空态而不是 404，是既有决定，记在 [`docs/known-issues.md`](docs/known-issues.md)），而 `/api/site/stats` 的 `dailies` 是 10、`GET /api/v1/dailies` 只列 2 期——差的就被这道过滤挡着。**本机库不是这样**：那里到 10-03 为止只有 4 份日报，没有 10-04 这一行（`SELECT key, jsonb_array_length(content->'sections') FROM reports WHERE kind='daily'` → 3/1/1/1）。报头字「地理日报」是本站自己生成的 SVG（`scripts/nameplates.ts` 按 `SITE.subject` 出图）。这张图的侧栏与首页那张一样，已经没有「板块」那一格（那一层 2026-10-04 整块删除）。**最新一期每天都换，线上才是事实来源**：`https://xxc2007.me/geohot/daily`。
## 🗂 站点结构

读者侧真正服务的路由（核对自 `apps/web/app/routes.ts`）：

| 路由 | 页面 |
|---|---|
| `/` · `/all` | 精选 · 全部地理动态（含搜索） |
| `/hot` | 地理热点榜（按事件排，不是按条目） |
| `/daily` · `/daily/archive` · `/daily/:key` | 最新一期 · 存档 · 单期；`/weekly`、`/monthly` 同构 |
| `/topics` · `/topics/:slug` | 主题目录（条数以 `industry/topics.json` 为准；2026-10-04 实测文件与站上都是 43）· 单个主题页 |
| `/story/:publicId` · `/items/:id` | 事件页（多方报道并成一条）· 条目页，另有 `/items/:id/original` 原文跳转 |
| `/about` · `/agent` · `/changelog` · `/feedback` · `/terms` · `/privacy` · `/more` | 关于 · Agent 接入 · 更新日志 · 反馈 · 条款 · 隐私 · 更多 |
| `/starred` | 我的收藏——只存在这台设备的浏览器里，`noindex` |
| `/admin/*` | 后台，**要登录**（密码是 `.env` 里 `npm run env:init` 生成的 `ADMIN_PASSWORD`） |

`/leaderboard` 与 `/codex-reset` 还留在路由表里，但这两个 AI 专属模块被关掉了，接口不注册，实际是 404。**这件事的唯一依据是 [`industry/features.ts`](industry/features.ts) 里那两个布尔值**（`leaderboard: false`、`codexResetMonitor: false`）；完整影响面——哪些端点不注册、后台还剩什么、底表搬去了哪里——只写在 [`docs/manual.md` 第 9 节](docs/manual.md) `docs/leaderboard.md` 那一行，其余文档一律指向它，不再各抄一遍。

机器可读出口读的都是 `packages/backend/src/publication/` 这一个只读层——**"所以内容一致"这句要分成两段说**：网页、RSS、`/api/v1/items`、MCP 用的是同一份 `selectedCondition()`（公开、已选中、过了释放时间、标题含中文，`packages/backend/src/publication/items.ts` 里那个导出），这一段是真的同源。**`/api/v1/selected/{snapshot,changes}` 那对同步账本曾经不是**：它读 `selected_ledger`，而写入时没套中文门槛这道门——2026-10-04 实测线上 snapshot 57 条、其余出口 53 条，多出的 4 条是读者在任何列表里都找不到的英文标题条目。`12849a3` 把同一道门槛补进了账本的入集条件（`packages/backend/src/publication/publish.ts` 里那句 `const inSet = selected && visibility === "public" && /[\u4e00-\u9fff]/…`），部署后 13:35 复测两边都是 53、snapshot 里无中文标题的条目 0 条。**仍然要知道的一条差别**：账本给的是**写入时的快照**，条目后来改了标题或换了分类不会自动回改（迁移 `0043` 就是为这类漂移补的一次修理），所以做跨出口对账要按 id 取交集，别把它的 `count` 当成"精选总数"。出口清单：RSS（`/feed.xml`、`/feed/full.xml`、`/feed/all.xml`、`/feed/daily.xml`、`/feed/weekly.xml`、`/feed/monthly.xml`、按分类的 `/feed/category/<key>.xml`）、公开 API（`/api/v1/*` 一组只读端点，`/api/v1` 本身不是路由；规范 `/openapi-v1.json`，说明页 `/agent`）、`/llms.txt`、`/sitemap.xml`、`/robots.txt`，以及 MCP（`/api/mcp`，**7 个只读工具**：`geohot_get_latest`、`geohot_search`、`geohot_get_hot_topics`、`geohot_get_story`、`geohot_get_daily`、`geohot_get_weekly`、`geohot_get_monthly`；2026-10-04 用 `tools/list` 打线上实测就是这 7 个，后两个是 10-02 那轮接上的）。**线上 `/agent` 那页的文案还写着"五个工具"，与这 7 个不符**——那是 `apps/web/app/routes/agent.tsx` 里两处硬编码，属于代码侧的待办，登记在 [`docs/known-issues.md`](docs/known-issues.md)。

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
├── industry/         # ★ 行业层：换行业只动这里（见下面那节）；changelog.json 是 /changelog 的数据源，pages/ 是条款与说明页正文
├── database/         # 迁移（只做向后兼容的增量，新迁移按编号加在末尾；2026-10-05 深夜现值 42 个，条数用 ls database/migrations/*.sql | wc -l 现查；编号有跳号不等于漏跑）
├── deploy/geohot/    # 上线与搬家：systemd 单元、nginx 片段、DEPLOYMENT.md、publish-to-github.sh、verify-deploy.sh
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
| 编辑判断 | 线上：Agnes AI `agnes-3.0-flash`（OpenAI 兼容）；本机与 CI：本地 stub + `tooling/fixtures/*.jsonl` | 见上面那一节：付费调用过回执与预算熔断 |

## 🔁 换成你的行业

`industry/` 是这棵树里和"地理"有关的东西该待的地方，其余是通用引擎——**换一个垂直领域，正常只需要动这一个目录**。这是本仓库最值得抄走的一点。

诚实补一句：目前**有两处例外**，是这轮改版新加的界面文案留下的——`apps/web/app/routes/topics.tsx` 与 `apps/web/app/features/report/format.ts` 里写死了几句中文地理词（主题页的说明文字、日报分页标题的拼接）。它们应该回到 `industry/`，列在 [`docs/known-issues.md`](docs/known-issues.md) 里。

| 文件 | 管什么 |
|---|---|
| `site.ts` | 站名、行业词 `subject`（拼进"地理日报""全部地理动态"）、首页与关于页文案、MCP 工具名前缀、`contactEmail`、`icp` |
| `taxonomy.ts` | 七个分类、七种内容类型、三个标签词表、机构名录、防张冠李戴的身份词典 |
| `topics.json` | 主题页目录（`/topics`）；条数以这个文件为准，别抄进文档（2026-10-03 删掉「野外考察」与「观点与解读」两个主题页，现在是 43） |
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

npm run db:migrate          # 建表（迁移条数以 database/migrations/ 现查为准，上面那棵目录树里给的是 2026-10-05 的现值；跑完用 SELECT count(*) FROM schema_migrations 对账，本机实测 42 = 42）
node --env-file-if-exists=.env scripts/seed.ts              # 导入分类、主题、信源（这条没有 npm 别名）
npm run seed:curated -- --dry-run --enforce-source          # 先看人工语料会不会落进未登记信源
npm run seed:curated -- --enforce-source                    # 导入人工策划的语料
```

**跑到这里还不等于站点有内容。** `scripts/seed.ts` 只导入信源与主题，`seed:curated` 只把 117 行人工语料写成 `articles` 并投进分析队列——从「材料」到「精选 / 事件 / 日报」必须过模型那一步，而 `npm run env:init` 写出的 `.env` 里 `MODEL_CALLS_ENABLED=false`。干净克隆上的实测（2026-10-04）：到此为止库里有 117 篇材料、`publications=0`、`selected=0`——站点起得来，但处处是诚实的空态。要让内容当天长出来，worker 要带着模型阀启动（`node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts`，`.env.pipeline` 把 `MODEL_CALLS_ENABLED` 与 `COLLECT_ENABLED` 一起打开），或者在自己的 `.env` 里显式写 `true`；同一套材料在阀打开后跑完是 **113 篇出版物 / 50 篇入选 / 81 个事件**。

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

- **视觉语言刻意继承上游，但不是逐字节相同**：[`apps/web/app/app.css`](apps/web/app/app.css) 相对它进仓时的那一份（baseline 提交 `754191b`）有 **12 处改动**（`git diff --stat 754191b -- apps/web/app/app.css` → `94 insertions(+), 12 deletions(-)`；`git diff 754191b -- apps/web/app/app.css | grep -c "^@@"` → **12**）。**这一版原先写的是"三处偏离、除这三处之外一字未改"，那句话恰恰在它自己声称"当场可查"的命令下不成立**，现在按"改到读者可见"与"只是扩充"分开说。改到读者可见的是这三组：① 排名数字的对比度——浅色档 `--rank-2` `#a3642f→#8d5522`、`--rank-3` `#96702e→#7f5a1e`、`--rank-rest` `#6b7684→#5c6774`（旧说明只报了 `--rank-rest`，而且报的是中间值 `#697482`，现值又往暗走了一档），深色档只有 `--rank-rest` `#7b869a→#7d889b`；文件里那段注释给的就是这组数的实测比值（原值 4.12–4.34:1，改后这组最差 5.20:1，AA 线是 4.5:1）。② `--daybar` 浅色档从 `#f0f2ee` 提到 `#f2f4f0`（附 4 行注释说明为什么），这是 2026-10-02 那一轮对比度整改的一部分——手机日栏把 `--ink-4` 画在 `--daybar` 上实测 4.46:1，Lighthouse 的移动端 colour-contrast 审计因此失败，把底色提亮两档到 4.54:1 就能过，而不用去动任何文字令牌。③ 文件末尾**整段 `@media print` 是上游没有的**（`git show 754191b:apps/web/app/app.css | grep -c "@media print"` = 0，现版 = 1），本站把日报当报纸版式，取舍写在注释里：打印时收起侧栏与底部导航、去掉画布网点（它是内容不是背景，"关闭背景图形"管不住它）、卡片改白底灰框、标题不许落在页尾。剩下的 hunk 是**扩充而不是改道**：文件头注释整段重写（AIHOT → GEOHOT）、`--font-display`（五条 CJK 衬线栈）、**14 个 `--text-*` 字阶令牌**（`--text-micro` 10px 一路到 `--text-display-xl` 48px）、`--measure-cjk: 42em`、`--hot-ink`，以及若干注释与 `@theme` 接线。
- **无障碍是照着审计做的**：每个视口宽度下恰好一个 `<h1>`（首页那个与视口无关，侧栏标题在源码顺序上排到它之后）；主题切换与"就地切换状态"的筛选器是 `role="radiogroup"` + roving tabindex，一组只有一个 Tab 停靠点，方向键与 `Home`/`End` 直接改选（它们的面板属于页面不属于控件，所以没用 `tablist`）；被辅助技术丢弃的 `aria-label` 换成真实名字——分数徽标补 `role="img"`，更新圆点标 `aria-hidden` 并配一句 `sr-only` 文字（颜色不能单独承载信息，WCAG 1.4.1）；移动端底部标签栏 54px 高、四等分，明显高于 44px 的最小热区，桌面侧栏行高 40px 走鼠标面。
- **品牌是原创的，且刻意不像上游**：站点标记「经纬之交」——墨色地球切一条经线三条纬线，唯一的青色热点正落在北纬与经线的交点上（`industry/brand/logo.svg`，文件头写着几何与配色的理由）。不用上游的名字与 Logo。
- **空状态是设计的一部分**：主题页里有一堆"0 条精选"的主题，日报薄的时候它就写着"本期共 1 条"。2026-10-03 删掉「野外与考察」与「观点与解读」两个分类时，**空状态也是这次决策的一部分**：前者几乎没有供给（可轮询的信源里没有科考队——科考航次与国家预警那几条登记为 `external`，要人工投递才可见），后者则是"评论与解读"这类内容在公开 feed 里长期与新闻正文混在一起、边界划不干净。分类的 `key` 进 URL，所以**删分类要配迁移**（`0041`），不能只是从数组里拿掉一行——那会让库里的旧 key 变成"不在词表里"的行，读者看到的是角标空着、筛选栏点不到它。空状态因此被当成页面认真做，而不是当成 bug。
- **读者要行动的地方就有免责声明**：命中灾害标签的条目页直接渲染"本站不是预警信息的发布机构，本页内容不构成预警依据……"，不是只在 `/terms` 里藏着。
- **门槛是经验护栏，不是证明**：`industry/selection.ts` 的头注释自己算给你看——12 条噪声硬上限只封住一到两轴，五轴从不回传代码，按字面算营销稿的天花板是 92–93 分，任何可用门槛都关不住它；真在下限拦噪声的是预筛的 `BLOCK` 与信源分级摆放。把 56/59/62 读成"营销稿数学上不可能入选"就是误读了这份文档。

## 📄 License

代码按 **MIT** 许可：[`LICENSE`](LICENSE) 原样保留上游文本、一个字没改，版权声明仍是上游框架 [AIHOT](https://github.com/KKKKhazix/AIHOT) 的作者（数字生命卡兹克）——本站没有往里面加自己的版权行。[`NOTICE`](NOTICE) 的上游部分同样原样保留，只在末尾**追加**了一段 "Derivative notice - GEOHOT"，说清这棵树是上游框架的修改衍生、改了什么、没用什么名字。

两点必须说明白：上游 `NOTICE` 写明 **"The name "AIHOT" and the AIHOT logo are not licensed under the MIT License"**，所以本站不复用它的名字与 Logo，只用文字声明衍生关系，这也不意味着上游认可或背书本站。第三方素材各自受自己的条款约束：`assets/og-fonts/`（Noto Sans SC，SIL OFL 1.1）、`assets/model-providers/` 与 `assets/leaderboard-sources/`（机构与评测方标识，只被本站已关闭的两个模块引用，商标归各自所有者）——`NOTICE` 不替你授权这些。`industry/sources.json` 里是各发布方的公开 feed，内容版权归他们，本站默认只显示摘要加原文链接（`site_fulltext` 对每个源都关着）。

顺带一句：根 `package.json` 的 `name` 仍是 `aihot` 且 `"private": true`，工作区包名 `@aihot/*`、目录名 `industry/`、浏览器存储键 `aihot-*` 都是代码内部标识，不对读者显示；改名要动的量级是**当场可数**的：`grep -rho "@aihot/[a-z-]*" --include=*.ts --include=*.tsx apps packages industry tests scripts tooling | wc -l` 给说明符处数，同一口径把 `-o` 换成 `-l` 给文件数（**这两个数每加一个测试文件就变，所以这里不抄死**——上一版抄的 635/218 在本轮加完四个测试文件后当场复算就成了 646/222，正是本段决定不再抄数的原因），另有 `package.json` 的脚本名、`Dockerfile:21`、`docker-compose.yml` 与 `apps/web/package.json` 里写死的包名——本站决定不改（改名要动多少处，以上面那条 `grep` 当场数的为准，别抄数）。

## 📈 Star History

<p align="center">
  <img src="https://api.star-history.com/svg?repos=xxc2007/GeoHot&type=Date" alt="Star History 星际历史：本仓库 GitHub Stars 随时间增长的曲线" width="100%">
</p>

▲ 曲线由 <a href="https://star-history.com">star-history.com</a> 动态生成，星数一变曲线就跟着长（GitHub 走图片代理缓存，更新会有几小时延迟）；仓库还年轻，这条线会从第一个星标开始有内容。

---

<div align="center">
  <sub>献给每一条有坐标、有数据、有人回去核对的消息。<br><a href="docs/manual.md">docs/manual.md</a> · <a href="docs/geohot-runbook.md">docs/geohot-runbook.md</a> · 已上线 <a href="https://xxc2007.me/geohot/">xxc2007.me/geohot/</a></sub>
</div>
