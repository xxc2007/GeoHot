# 第九十七轮：恢复完整性、单元加固、一处白读的消除（2026-10-15 07:30–08:10 CST 生产实测）

站长的话：「按照你说的做，全面升级迭代网站，可以暂时出现 503，但是任务完成之后一定要确保网站的运行正常和安全，
进行多轮审查后三端同步，确保可以随时迁移，**通过服务器或者 github 仓库都可以随时迁移**」。
最后半句是新要求，所以本轮的主线不是内容量，而是"这个站到底能不能被复现"。

## 一、量出来的四个真相（都不是读代码读出来的）

1. **`/opt/geohot/app` 根本不是 git 仓库**（`git rev-parse` 直接 `not a git repository`）。
   所以"生产 == HEAD"这句话只能逐文件比哈希，`install-units.sh` 之类的脚本在这台机器上也没有 git 可用。
2. **装机的单元与仓库里的单元不是一份东西**（去掉注释与空行后逐单元比对）：
   - `api` / `brain` / `web` / `worker`：仓库那一份带加固块（`NoNewPrivileges`、`PrivateTmp`、
     `ProtectSystem=strict`、`ReadWritePaths=/opt/geohot/app/.data`、`ProtectKernel*`、`RestrictSUIDSGID`、
     `LockPersonality`）与 `Wants=postgresql.service`、`KillMode=mixed`（worker），**装着的这一份全没有**；
   - `workbuddy-cn`：**装着的这一份有** `Environment=WORKBUDDY_VARIANT=workbuddy` 与 `WORKBUDDY_BRIDGE_PORT=3066`，
     仓库那一份没有 ⇒ 照 `git clone` + 装单元恢复出来的机器会用**国际版变体**去连中国版凭据、并和另一条抢 3065，
     那扇门静默死掉。这是本轮最值钱的一条发现——它不会让任何测试变红。
   - `archive.service` / `archive.timer` / `workbuddy`：行为一致。
   这正是工单 #194 第二条（"四个主应用单元零沙箱"）与它自己的成因：**同一个单元在仓库里有两份真相**
   （`install-units.sh` 内联生成的无加固版，与 `systemd/` 模板的有加固版），文档还写着"一台机器只选一条路线"。
3. **`.env.example` 只有 23 个键，生产 `.env` 用 53 个**。而 `bootstrap-server.sh:439` 与新机流程都写着
   `cp .env.example .env` ⇒ 照仓库恢复的新机**一扇模型门都不会有**（`MODEL_POOL`、`DOTS_*`、`AGNES_CN_*`、
   `WORKBUDDY_*` 全不在模板里），并且站点照样起、照样 200——静默降级，最难查的那一类。
4. **`/etc/geohot/archive-cycle.conf` 只存在于机器上**，仓库里没有任何样例；新机器没有它，归档周期根本不会跑。
   （值本身没有秘密：`APPLY/MAX_ITEMS/SLICES/PER_MONTH/FROM` 五个数字。）

## 二、这一轮修掉的

- **单元只留一份真相**：`install-units.sh` 默认路径下改为**安装 `systemd/` 里的 8 个模板**（带加固），
  只有 `GEOHOT_APP_ROOT` 指到别处才退回内联生成，并且明说"退回的这一份不带加固块"；
  覆盖前逐个 `cp -a` 留底 `*.pre-units-<UTC>.bak`，装完跑 `verify-config-drift.sh` 复核。
- **仓库 CN 模板补上那两行**（与生产对齐），其余四个模板把 `TimeoutStopSec` 对齐到生产实际值 285、
  `RestartSec` 对齐到 5。
- **`.env.example` 补到覆盖生产全部键名**（值一律留空，一个值都没抄），并写清哪些是模型门、哪些是桥的凭据路径。
- **新增 `deploy/geohot/archive-cycle.conf.example`**（只有数字）。
- **新增 `deploy/geohot/verify-config-drift.sh`**（只读；键名与路径直说，比对单元的那一节先脱敏，见下面第七节）：
  ① 装着的单元 vs 仓库单元（去注释后逐字节）；② `.env` 键名是否都在模板里；
  ③ 单元引用的 `EnvironmentFile` 是"仓库里有"还是"机器侧清单"；④ `ExecStart` 指向的代码入口在不在；
  ⑤ 归档阀门键形 vs 样例。装之前它当场报出 api/brain/web/worker 四处漂移，装之后 **八个全 SAME**。
- **迁移 0067：一条部分索引**（见第四节）。
- **判定并发 4 → 8**（站长批准，代价是那段时间读者可能撞 503）。

## 三、加固上线后的实测（不是"应该没问题"）

四个单元重启后全部 `active`；`verify-deploy.sh` **ALL CHECKS PASSED**（含邻站基线与九个读者面"都有中文标题"）；
`/geohot/` 0.78 s、`/geohot/daily` 0.27 s、`api/site/stats` 0.16 s。
`ProtectSystem=strict` 会不会打断写盘——用三条独立证据回答，而不是推理：
`.data/ogcache` 目录 mtime 就是重启之后的 07:49；`.data/imgcache` 近 24 小时落了 **620** 个文件；
`.data/sitemap-last.xml` 与 `backfill-news-state.json` 近 4 小时内都有更新；
四个单元日志里 `EROFS|read-only file system|EPERM|Operation not permitted` **0 行**。
（我自己的两个 404 是路数写错：精选 RSS 是 `/geohot/feed.xml`，图片代理不是 `/api/media/image`。）

## 四、那处白读：从 1.17 秒到 0.13 秒

`content.ts:266-269` 的"分析过了但没投影 ⇒ 免费补一次"这半段，在生产**匹配 0 行**，
计划却是 `Parallel Index Scan Backward using articles_discovered_idx` + Filter。同一查询同一数据的现场对比：

| | 实测 | shared buffers |
| --- | --- | --- |
| 加索引前 | `actual time=1154.8..1166.2 rows=0` | `hit=152,379 read=2,533` |
| 加索引后（`articles_analyzed_discovered_idx`，partial `WHERE processing_state='analyzed'`） | `actual time=118.4..127.4 rows=0`，计划改用新索引 | `hit=141,420 read=378` |

**约 9.2 倍、真读盘 2,533 → 378 页。** 为什么这台机器要在意：读者面 503 的链条是
"891 MB 下 page cache 被打穿 ⇒ 读查询真读盘、`WALWrite` 排队 ⇒ 读者列表查询超过 `api.server.ts:43` 的 15 秒"，
而这条查询每十分钟就来一次、代价还随 `analyzed` 行数线性增长。它不是唯一的因，但它是**唯一能消掉的白读**。
查询语义一个字没改——它该问的还是那个问题，缺的只是能便宜地回答"没有"。

## 五、GitHub-only 恢复演练（真跑，不是文档）

`git clone --depth 1` → `npm ci` → 新建空库 → `npm run db:migrate`（**64 个迁移全过**；当时 GitHub 上是 63 个，`git pull` 后补上本轮的 0067）→ `scripts/seed.ts`
（**sources 668 added, 0 already there；topics 43**）→ `BASE_PATH=/geohot npm run build -w @aihot/web` → 起 api 与 web。
十一个读者面全部 200，且是**有内容的页面**：`/` 29,559 B、`/daily` 23,292 B、`/weekly` 22,813 B、`/monthly` 22,820 B、
`/all` 40,259 B、`/changelog` 210,424 B、`/about` 44,355 B、`/feed.xml` 683 B、`/sitemap.xml` 1,950 B（13 个 `<loc>`）、
`/api/site/stats` 14,902 B（`sources:666`，即 668 里启用那批）、`/llms.txt` 3,500 B；
每页都有中文眉标与真实结构（`<nav aria-label="主导航">`、`<main id="main">`），空历史时读者读到的是"**还没有**"，
api 与 web 日志错误行 **0**。

演练本身值回票价，抓到三条只会在恢复时出现的坑（已写进 `docs/migration.md` 第 6.5 节）：
1. `AIHOT_ENVIRONMENT=production` + localhost 的 `SITE_URL` 被 `config.ts:106` **拒绝启动**——这是设计
   （canonical/OG/RSS/sitemap 会把 localhost 印出去），所以搬家清单里"手工改 SITE_URL"是硬前置不是建议；
2. web 转给 api 的地址来自 `API_BASE_URL`，缺省 `127.0.0.1:3001`（`apps/web/server.ts:14`）——
   api 换端口而不写这一条，表现是**整站 502/503 而 api 自己 200**，极易误判成代码坏了；
3. Windows 的 Git Bash 会把 `BASE_PATH=/geohot` 改写成 `/C:/Program Files/Git/geohot` 烤进构建产物，
   web 只 warn 一句 basename 不一致，然后全站 404。加 `MSYS_NO_PATHCONV=1` 才对（Linux 生产不受影响）。

## 六、主动不要的一条（免得下轮重探）

官方测绘/地理机构新闻室这一族 21 扇门（BKG、PDOK、GA、NOAA、USGS、IGN、韩国 NGII、GSI、Kadaster、OS、SoI、
Rosreestr、NRCan…）实测**无一达标**：最好的三扇也只有 9/8、4/4、5/4 条候选，其余是"整页读不出日期"、
405+captcha、403 或本机不可达；另有两把量具坑值得记：**NOAA 软 404 会返 200**、
**swisstopo 的日期只存在于页面内嵌 JSON**（选择器拿不到）。

## 七、没做、或做了但只到"取证"为止的

- `unattended-upgrades` 的 `Allowed-Origins` 仍不含 `jammy-updates`（12 个待更新因此永远修不到）+ 内核欠一次计划内重启；
- 源站可被直连（绕开 Cloudflare 的 WAF/限流）与无 CSP / 无 X-Frame-Options：CSP 要配一轮真实浏览器回归，
  只信 CF 回源段要防把自己锁在门外，两条都留给站长择窗；
- rclone 管理界面听 `*:8080`（公网 filtered）：这是站长自己的工具，改绑定会打到他的用法，不动；
- 生产库口令曾被打印进过会话输出两次（#192）：轮换归站长。
