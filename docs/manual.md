# GEOHOT 运营手册

> 这份文档原来就是仓库根的 `README.md`。2026-10-01 仓库根的 README 换成了面向读者的介绍页，这份操作手册整体搬到这里，内容一字未删。
> **本机跑法、检查命令、已知边界、上线前清单仍以本文为准**；介绍页只给入口，不重复这些细节。介绍页在 [`../README.md`](../README.md)。

地理垂直领域的热点网站：每天从固定的信源收资料，按"空间显著性"挑出少数几条，写成中文标题和摘要，把同一件事的多方报道并成一个事件，每天早上出一份日报。

这份文档只讲这台机器上真实跑起来的东西。每条命令都是敲过、跑过的；没跑过的我会写清楚。

---

## 1. 这是什么

GEOHOT（中文站名 **地理热点**）建在开源框架 AIHOT 之上，行业层换成了地理。一条资料进站后的路径是固定的：

**采集**（44 个信源：RSS、网页列表、JSON 接口、外部推送）→ **判重入库**（规范化 URL 做身份，同一篇只留一份）→ **预筛**（是不是地理的事，`BLOCK` 的直接不进任何公开页面）→ **两次独立打分**（同一份评分标准串行调用两次，两次之和 ≥ 2 × 门槛才入选）→ **中文标题与摘要**（答案先行的摘要 + 推荐理由 + 标签，外文有全文翻译）→ **归组成事件**（多家报道同一件事并成一个事件，事件页有综述）→ **热度**（48 小时窗口、24 小时半衰期，每个独立来源只投一票，至少 2 个参与者且至少 1 个是编辑类信源）→ **每日 08:00（Asia/Shanghai）出刊**（周报周一 10:00，月报每月 1 日 10:30）。

对外有四个出口：网站、RSS（`/feed.xml`、`/feed/all.xml`、`/feed/full.xml`、`/feed/daily.xml`、按分类的 `/feed/category/<key>.xml`）、公开 API（`/api/v1/`，文档 `/openapi-v1.json`，说明页 `/agent`）、MCP（`/api/mcp`）。四个出口读的都是 `packages/backend/src/publication/` 这一个读取层，所以内容一致。读者打开页面不触发任何模型调用；模型调用只发生在 worker 的任务里，并且每一次都走回执与预算熔断（`packages/backend/src/providers/receipts.ts`）。

进程形状：api（Fastify，`API_PORT`，默认 127.0.0.1:3001）、worker（pg-boss 队列与定时任务）、web（React Router 服务端渲染，`WEB_PORT`，默认 localhost:3000）、编辑大脑 stub（`BRAIN_PORT`，默认 127.0.0.1:3055）、PostgreSQL 17（`DATABASE_URL`，默认 127.0.0.1:5433）。四个端口在这台机器上全都能改、也全都得改——早期 3001 被无关进程占着，本站的 api 就固定跑在 3199（**2026-10-02 实测 3001 已空闲**，但 3199 是沿用下来的惯例，`.env.ports` 里写的就是它）；细节与并排跑法见 3.7。后端没有构建步骤，Node 24 直接跑 TypeScript。

---

## 2. 上游与许可

- 框架：[AIHOT](https://github.com/KKKKhazix/AIHOT)，作者 数字生命卡兹克，**MIT 许可证**。`LICENSE`（MIT，版权仍是他）原样保留、一个字没改。`NOTICE` 的**上游那 16 行也原样保留**，只在文件末尾**追加**了一段 "Derivative notice - GEOHOT"，说清这棵树是上游框架的修改衍生、改了什么、没用什么名字——这是为了不让别人误以为这份交付还由上游署名或背书，不改变、也不削弱任何许可。
- `NOTICE` 第 4–5 行写明：**"The name "AIHOT" and the AIHOT logo are not licensed under the MIT License."** 所以本站不复用 AIHOT 的名字，也不复用它的 Logo：
  - 站名与全部面向读者的文案：`industry/site.ts`（`name: "GEOHOT"`、`subject: "地理"`）。
  - 站点标记是原创的**经纬之交**（`industry/brand/logo.svg`，文件头注释写着概念：墨色地球切一条经线三条纬线，青色热点正落在北纬与经线交点上），配套 `icon.png`、`icon-192.png`、`apple-icon.png`、`favicon.ico`。
  - 日报/周报/月报/存档页的报头字是本站自己生成的（`industry/brand/nameplates/*.svg`，由 `scripts/nameplates.ts` 按 `SITE.subject` 把"地理日报"等四字排成 SVG 路径——不是文字，所以改了 `subject` 必须重跑那个脚本才会变）。
- 仓库里仍然存在的 `@aihot/*` 是 npm 工作区包名，`aihot-*` 是浏览器本地存储的键名。它们是代码内部标识、不对读者显示；改名要动 100 多处 import 和 5 处硬编码路径，本站决定不改。
- `docs/` 下曾经有几张 banner 与宣传图（`docs/assets/*.png`）是上游 AIHOT 的物料，本手册与仓库根的介绍页都不引用它们——2026-10-02 已删除。介绍页现在只用 `docs/shots/` 里 README 真引用的那几张实机截图，而且有一条守卫（`node scripts/check-shots.ts`）：没被引用、两两重字节、或者名字叫 dark 而像素是亮的，都会让检查失败。
- 字体与厂商标志各有许可，见 `NOTICE`。`industry/sources.json` 里是各发布方的公开 feed，内容版权归他们，本站默认只显示摘要加原文链接。

---

## 3. 怎么跑起来

### 3.1 前置

- Node 24（`package.json` 的 `engines` 要求 `>=24.11`；这台机器实测 **v24.19.0**，npm **11.17.0**）。
- Git Bash。数据库只在 127.0.0.1，不对外。
- **不需要 Docker，不需要管理员权限，不需要自己安装 PostgreSQL。** 这台机器上三条都不满足（`docker` 命令不存在，装系统服务要提权），所以下面用 `embedded-postgres`。

### 3.2 一次性准备

```bash
npm ci

# 生成两个 env 文件（干净克隆里它们不存在：见下面"为什么必须有这一步"）
npm run env:init
#   已经有人在这台机器上跑过一整套了？换一组空闲端口，两个人并肩跑（见 3.7）：
#   npm run env:init -- --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065

# 起数据库（第一次要 initdb，机械盘上可能要几分钟；端口要和 .env 的 DATABASE_URL 一致）
npm run db:up -- --daemon
# 前台跑法：npm run db:up    （Ctrl-C 就停；后台跑法停止用 npm run db:down）
# 用了 --db-port 的话这里要重复一次：npm run db:up -- --daemon --port=5455

# 建表 + 导入行业包（分类、主题、信源）
node --env-file-if-exists=.env scripts/migrate.ts     # 等价于 npm run db:migrate
node --env-file-if-exists=.env scripts/seed.ts

# 导入人工策划的语料（走框架自己的入库入口，不是直接写表）
npm run seed:curated -- --dry-run --enforce-source    # 先看会不会落进未登记信源
npm run seed:curated -- --enforce-source

# 跑一遍检查
npm run typecheck
```

**为什么必须有 `npm run env:init` 这一步（独立审计的 BLOCKER，已修）。** `.env`、`.env.pipeline`、`.env.ports` 都被 `.gitignore` 的 `.env` / `.env.*` 规则排除，所以 `git clone` 出来的仓库里一个都没有；而下面所有启动命令写的都是 `node --env-file=.env --env-file=.env.pipeline …`，文件不存在时 Node 直接退出：

```
$ node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts
D:\node.exe: .env: not found
D:\node.exe: .env.pipeline: not found          # 退出码 9
```

`npm run env:init`（`scripts/init-env.ts`）从 `.env.example` 与 `.env.pipeline.example` 写出这两个文件（写入时申请权限 600——注意这台 Windows 上权限位只是名义的，`statSync` 实测回 666；真正保护它们的是 `.gitignore` 第 1–2 行的 `.env` / `.env.*` 规则，`git check-ignore -v .env .env.pipeline` 可当场验证，所以**别把仓库放进别人可读的共享目录**），并且**给五个键生成真随机值而不是留空**：`ADMIN_PASSWORD`（16 位 base64url，在终端打印一次）、`SESSION_SECRET` 与 `IMG_PROXY_SIGN_SECRET`（各 64 位十六进制）、`POSTGRES_PASSWORD`（36 位十六进制）、`INGEST_TOKEN`（48 位十六进制）。留空的话后台根本进不去、投递接口一律 401，所以"复制模板再手工填"不是一条能跑通的路径。它**拒绝覆盖已存在的文件**（实测 `env:init: .env 和 .env.pipeline 已经存在，没有覆盖。` + 退出码 1），要重来就自己改名。带 `--db-port/--api-port/--web-port/--brain-port` 时它会把端口写进所有相互引用的地方：`DATABASE_URL`、`SITE_URL`、`API_PORT`、`WEB_PORT`、`API_BASE_URL`、`BRAIN_PORT`、`LLM_BASE_URL`（`.env.pipeline` 里的 `LLM_BASE_URL` 也一起改），于是上面那四条命令一个字都不用动。

**这条路径今天（2026-10-01）在仓库外的临时克隆里从头到尾又复跑了一遍**：`git clone` → `npm ci`（exit 0）→ `node scripts/init-env.ts --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065`（五个随机密钥落盘、四个端口七处键一次写齐、第二次运行拒绝覆盖 exit 1）→ `npm run db:up -- --daemon --port=5455` → 上面那条 migrate 命令（`35 migration(s) applied`，退出码 0）→ `scripts/seed.ts`（`topics: 45 / sources: 44 added`）→ `npm run seed:curated -- --dry-run --enforce-source`（`117 material line(s)`、`34/34 registered`）→ `node --env-file=.env apps/api/src/main.ts` 起在 3288：`/api/health` 200、`/api/admin/sources` 无会话 401、投递接口无 token 401 / 带 env:init 生成的 token 200 `{"ok":true,"created":1}` / 重投同 URL `created:0`。**克隆里没有跑的**：worker、web、`npm test`、smoke（第 11 节的另一轮克隆验证跑过 web 与登录链路）。验完即 `npm run db:down` 停库、克隆整体删除。

`scripts/seed.ts` 没有对应的 npm 脚本，只能用上面那条完整命令（`node --env-file-if-exists=.env scripts/seed.ts`）。`scripts/seed-curated.ts` 有脚本，叫 `npm run seed:curated`。语料在仓库里（`tooling/corpus/`），所以克隆下来就能重建演示数据；行数不要抄文档，那条 dry-run 会打印 `117 material line(s)`（2026-10-01 本机实测），条目数以第 7 节第 8 条给的命令为准。

### 3.3 每天开机后

三个进程各占一个终端，顺序无所谓：

```bash
npm run brain                                                   # 编辑大脑 stub，127.0.0.1:3055
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts    # 接口，默认 127.0.0.1:3001
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts # 采集、模型步骤、定时任务
npm run dev:web                                                 # 网页，http://localhost:3000
```

`--env-file` 出现两次是刻意的，见 3.5。想省事也可以只跑 `npm run dev:api`、`npm run dev:worker`（它们只读 `.env`，安全阀是关的，管道不会动，只能看站）。
**这两条默认端口（3001、3000）在多人共用的机器上是最先被撞的**——本机 3001 现在就躺在一个跟本站无关的进程手里。要换端口看 3.7：api 改 `API_PORT`、web 改 `WEB_PORT`（`npm run dev:web` 的端口是写死在 `apps/web/package.json` 里的，换端口得用下面 3.7 那条 `apps/web/server.ts` 的跑法）。

构建后再验证：

```bash
npm run build -w @aihot/web
node scripts/smoke.ts --base http://localhost:3000
```

`smoke.ts` 会打开一批页面和机器可读出口（含 MCP 握手与几条跨出口不变量），全部应当 ✓。**条数以 `scripts/smoke.ts` 里的 `PAGES` 与 `MACHINE` 两张表为准**（2026-10-03 是 17 + 18，另加 2 项不变量）——不要把数字抄进文档再抄回来，那是这一条以前腐烂的原因。最近一次实跑的逐条输出在第 8 节末尾。

### 3.4 访问地址

左列是 `npm run env:init` 不带端口参数时的默认值；右列是**这台机器现在实际在跑的那一套**——env:init 之后又被 `--env-file=.env.ports` 第三层覆盖过一次，因为默认端口全被占了（3.7）。

| 用途 | 默认地址 | 本机实际 |
|---|---|---|
| 网站 | <http://localhost:3000> | <http://localhost:3000>（3000 被本站占着） |
| 后台 | <http://localhost:3000/admin>——**要登录**：`/admin` 未登录时 302 跳到 `/admin/login`，密码是 `.env` 里的 `ADMIN_PASSWORD`（`npm run env:init` 生成并打印一次）。旧的 `DEV_AUTH_ROLE=admin` 免登录后门已经摘掉了，别再装回去，理由与实测见第 11 节 | 同一个 |
| 接口 | <http://127.0.0.1:3001>（`API_PORT`，`API_BASE_URL` 指过来） | <http://127.0.0.1:3199>（本机惯例；3001 早期被占过，2026-10-02 已空闲） |
| 编辑大脑 stub | <http://127.0.0.1:3055/v1>，审计日志 `GET /__brain/log`，自检 `GET /healthz` | 3055 |
| 数据库 | `postgres://geohot:geohot@127.0.0.1:5433/geohot`（`.env` 的 `DATABASE_URL`） | 5433 |

`.env` 里已经有 `SESSION_SECRET`、`ADMIN_PASSWORD`、`IMG_PROXY_SIGN_SECRET`、`INGEST_TOKEN`、`POSTGRES_PASSWORD` 五个随机真值（`.env` 被 `.gitignore` 排除，不要提交）。手工 `cp .env.example .env` 的话这五个键全是空的，后果写在 3.2。

### 3.5 一次性文件 `.env.pipeline`，以及为什么 `.env` 里的阀必须是 false

`.env` 里这四个开关一律是 `false`：

```
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
```

**这是故意的，不是忘了开。** 上游 `AGENTS.md` 的开发纪律是"开发和测试时保持安全阀关闭"，而 `npm test` 会继承 `.env`：一旦在这里打开 `COLLECT_ENABLED`，测试就可能真的去访问外部服务。所以真要让管道动（抓信源、跑预筛与打分、出日报）时，用第二个一次性文件 `.env.pipeline`（模板 `.env.pipeline.example` 在仓库里；`npm run env:init` 把它和 `.env` 一起生成，内容只多开了 `COLLECT_ENABLED=true`、`MODEL_CALLS_ENABLED=true`，加上 `TZ=Asia/Shanghai` 与 `FETCH_SCHEDULE_BATCH=1`），像 3.3 那样 `--env-file` 叠两次。**永远不要把 `.env.pipeline` 的内容合并进 `.env`。**

采集本身不花钱（免费的 RSS/网页），模型这一步在本站也不花钱（模型是本地 stub，见第 4 节），所以打开这两个阀在本机没有账单风险。

### 3.6 两个 Windows 坑（为什么数据库不能随手起）

**坑一：PostgreSQL 的二进制文件不能放在中文路径下。**
`initdb` / `postgres` 会把 argv 与 CWD 的字节按集群编码解成文本，GBK 字节撞上 UTF8 就直接 `FATAL: invalid byte sequence for encoding "UTF8": 0xb5`。本项目目录是 `D:\地理热点网站\GEOHOT`，`node_modules` 里那 100 MB 二进制就在中文路径下。
解法写在 `scripts/dev-db.ts:63-90`：把 `@embedded-postgres/windows-x64` 镜像到一个纯 ASCII 目录 `D:\geohot-embedded-postgres\windows-x64-<版本>`（JS 文件真复制、`native` 用 junction），再在 `node_modules/embedded-postgres/node_modules/@embedded-postgres/` 下建一个同名 junction 把它接回来——Node 从内向外查找依赖，这个 junction 会赢。**数据目录 `.pgdata` 留在中文路径下没问题，只有二进制路径必须 ASCII。**
要注意的两件事：`npm ci` 会删掉那个 junction（`scripts/dev-db.ts:14` 写明了），下次 `npm run db:up` 会自己重建；如果你手动删了 `D:\geohot-embedded-postgres`，也会被重建。

**坑二：默认 locale 会让中文全文检索静默失效。**
`lc_ctype=C` 下 `similarity('三角洲','河流三角洲')` 恒为 0，`show_trgm('三角洲')` 什么都不返回，于是 `pg_trgm` 的 GIN 索引（`database/migrations/0001_core.sql`、`0014_pool_search.sql`）永远匹配不到中文，搜索和相关检索不报错、只是永远为空。
解法写在 `scripts/dev-db.ts:167`：集群用 `--locale-provider=icu --icu-locale=zh-CN --encoding=UTF8` 创建，`authMethod` 用 `scram-sha-256`。脚本还会在编码不是 UTF8 时直接失败退出。
副作用要记住：**集群一旦建好，initdb 参数不会重跑**。如果你改了这几个参数，得停库、删 `.pgdata`（105 MB，全部数据在里面）、重新 `npm run db:up`。

顺带三条：`--daemon` 的日志在 `%TEMP%\geohot-dev-db.log`，PID 在 `.pgdata/dev-db.pid`；`npm run db:down` 用 `pg_ctl stop -m fast`，只收自己 PID 文件指向的进程，停止时会打印它停的是哪个端口；这台机器上的 embedded bundle **只有 `initdb.exe`、`pg_ctl.exe`、`postgres.exe`，没有 `psql.exe` 也没有 `pg_dump.exe`**（要连库执行 SQL 就用 `node --input-type=module -e "import p from 'postgres'; ..."`，`postgres` 这个包已经在依赖里）。

### 3.7 端口：这台机器的现实，以及两个人并肩跑的办法

四个默认端口（数据库 5433、stub 3055、api 3001、web 3000）在一个已经有人在跑的机器上**一个都保不住**。本机实测：3000 是本站的 web、3055 是本站的 stub、5433 是本站的库、3199 是本站现在真正在用的 api 端口，而默认值 `3001` 被一个跟本站无关的 Node 进程占着（`netstat` 里 `0.0.0.0:3001 LISTENING`，命令行读不到，本站从来没有起过它）。本轮做干净克隆验证时撞上的就是这个：先按 3299 起 api，直接撞死在另一个 api 实例手里，最后落到 3288——真实输出长这样：

```
$ node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts
Error: listen EADDRINUSE: address already in use 127.0.0.1:3299
  code: 'EADDRINUSE', errno: -4091, syscall: 'listen', address: '127.0.0.1', port: 3299
```

**结论：端口不是细节，是这台机器上第一种常见的失败。** 所以四个端口全都能改，而且改一处不够、要改一组：

| 进程 | 端口键 | 改法 |
|---|---|---|
| embedded PostgreSQL | `scripts/dev-db.ts` 的 `--port`（或环境变量 `DEV_DB_PORT`），默认 5433 | `npm run db:up -- --daemon --port=5455` |
| 数据库连接串 | `.env` 的 `DATABASE_URL`（必须和上面一致） | `npm run env:init -- --db-port=5455` 一次写对两处 |
| api | `API_PORT`（`packages/backend/src/config.ts:72`），web 侧要跟着改 `API_BASE_URL` | `npm run env:init -- --api-port=3288`，或第三个 env 文件 |
| web | `WEB_PORT`（`apps/web/server.ts:12`） | 见下面第二条命令；`npm run dev:web` 的 `--port 3000` 写在 `apps/web/package.json` 里，换端口别用它 |
| stub | `BRAIN_PORT`（`tooling/brain-stub.ts:26`），api/worker 侧要跟着改 `LLM_BASE_URL` | `BRAIN_PORT=3065 npm run brain`，或 `node --env-file=.env tooling/brain-stub.ts`（`npm run brain` 本身不读任何 env 文件） |

两条能直接抄的路：

```bash
# A. 让 env:init 把这一组端口写进 .env 的所有相关键（推荐；它同时改 DATABASE_URL / SITE_URL /
#    API_PORT / API_BASE_URL / WEB_PORT / BRAIN_PORT / LLM_BASE_URL，两个 env 文件都改）
npm run env:init -- --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065
npm run db:up -- --daemon --port=5455
node --env-file=.env tooling/brain-stub.ts                        # 3065
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts    # 3288
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts
npm run build -w @aihot/web && node --env-file=.env apps/web/server.ts   # 3090

# ★ 2026-10-02 实测补充两条，都会安静地骗过状态码：
#   1) 重建 web（`npm run build -w @aihot/web`）之后**必须重启 web**：server.ts 启动时把构建 import 进内存，
#      静态资源却按请求读盘——只重建不重启，页面 200 而它引用的 assets 哈希全是旧的（实测 12 个里 10 个 404）。
#   2) 在子路径形态本地跑，`SITE_URL` 必须带前缀（`SITE_URL=http://127.0.0.1:3000/geohot`）：不带时
#      canonical / og:url / 图片代理会逃出 `/geohot`，smoke 会红 61 项（web 启动日志只有一行 warn）。

# B. 端口单独记在第三个 env 文件里（本机现在用的就是这个办法，.env.ports 同样被 gitignore 排除）
printf 'API_PORT=3199\nAPI_HOST=127.0.0.1\nWEB_PORT=3000\nWEB_HOST=127.0.0.1\nAPI_BASE_URL=http://127.0.0.1:3199\n' > .env.ports
node --env-file=.env --env-file=.env.pipeline --env-file=.env.ports apps/api/src/main.ts
```

`--env-file` 叠多次时**后面那个覆盖前面的**，所以办法 B 能把 `.env` 里的值临时压下去而不改 `.env`。两种办法别混用（`.env` 里写了一套端口、`.env.ports` 又写一套，出了问题很难一眼看出哪个生效）。`dev-db` 在 `.env` 的 `DATABASE_URL` 端口和实际 `--port` 不一致时会打印 WARNING 并告诉你怎么修：

```
dev-db: WARNING — .env DATABASE_URL points at port 5455, not 5433. Start on 5455, or regenerate: npm run env:init -- --db-port=5433
```

数据目录不用换：`.pgdata` 是每个检出（checkout）自己的，端口才是共享的；两个克隆各自 initdb、各自跑在自己的端口上互不影响，本轮实测就是"live 栈在 5433/3055/3199/3000、克隆在 5455/3065/3288/3090"同时跑。


---

## 4. 内容是怎么来的（没有 API Key 是怎么跑起来的）

这一节是本站最需要读懂的部分。

**设计。** 框架只在真正要调模型的那一刻才读 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`（`packages/backend/src/providers/llm.ts:34-35`、`:160`）。本机没有任何真模型的 Key（`.env` 里 `LLM_API_KEY=local-brain` 是个占位值，只为了满足"非空"这一条检查），于是把这三个指向一个本机的 OpenAI 兼容假服务：`tooling/brain-stub.ts`（`npm run brain`，只听 127.0.0.1:3055）。它不调模型，而是按"这条材料是哪一步、是哪一篇"返回**人工撰写的地理编辑判断**，判断存在 `tooling/fixtures/*.jsonl`（13 个能力文件）。

**判断条数不要抄进文档再抄回来——这一版手册就抄错过一次（写着 325 条，独立审计抓到现场已是 546 条；2026-10-01 当天下午再数变成 548——它只会随补稿继续变，唯一正确做法是跑下面这条命令）。** 用命令现场数：

```bash
curl -s http://127.0.0.1:3055/healthz | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s).fixtures;console.log('能力',f.length,'条 fixture',f.reduce((a,b)=>a+b.fixtures,0),'条 问题',f.reduce((a,b)=>a+b.fixtureErrors,0))})"
# 2026-10-01 本机实测（当天下午同一命令两次读数）：能力 13 / fixture 546 → 548 / fixtureErrors 0；
# 一天之内就涨过 2 条——这正是不要把这条数抄进任何文档的原因。stub 启动行同一口径：能力 13、锚点 215。
npm run brain -- --lint      # 同一批数据的离线版，不需要 stub 在跑
```

这个数字别用 `wc -l` 去数——文件里还有 `#`/`//` 注释行，`readFixtureFile`（`tooling/brain-stub.ts:413-437`）会把注释跳过去，`wc -l` 只会给你一个偏大的数。补稿在进行中，它会继续涨。

于是 `prefilter → 两次独立打分 → understand → structure → group → digest → report` **全部走真实代码和真实门槛**：五维权重表、`sum ≥ 2 × 门槛`、归组的三值关系、`isHistorical` 的 48 小时闸门、日报分节、公开读取层，一句都没有被绕过。被替换掉的只有"模型今天怎么想"，没有"系统怎么裁决"。

**这句话要说明白：今天你在这个站上看到的精选，是人工策划的，机器是一个 fixture。** 站上的精选有多少，取决于 `tooling/fixtures/` 里有多少人写过的判断，而不取决于信源抓回来多少篇。没有 fixture 的材料会落到确定性默认值上：预筛默认 `PASS`、打分默认 `attentionScore=20`（两次之和 40，任何门槛的 2 倍线都过不了）、归组默认 `UNRELATED`、翻译默认原样返回。**结构上产不出假精选**——想让一篇材料进精选，必须有人在 `scores.jsonl` 里写下 ≥ 门槛的分数。

**怎么换成真模型。** 改 `.env` 里那三行就行，代码一行都不用动：

```ini
LLM_BASE_URL=<OpenAI 兼容接口地址>   # 例如 https://api.deepseek.com/v1
LLM_API_KEY=<你的 Key>
LLM_MODEL=<模型名>
```

`MODEL_CALLS_ENABLED=false` 时管道根本不发请求（`llm.ts:157` 直接抛错），所以换完 Key 还要用 `.env.pipeline` 那套启动方式。想让某一步用不同模型，用 `PREFILTER_MODEL / SCORE_MODEL / …`（`packages/backend/src/editorial/models.ts`），或在后台 `/admin/models` 里切。反过来，真模型上线后 stub 仍然值得留着当回归基准：同一批 fixture 可以对比模型判断与人工判断的差距。

**工具与自查。**

```bash
npm run brain                     # 前台起服务
npm run brain -- --lint           # 只检查 fixture，不起服务；改完稿必跑（2026-10-01 本机重跑：fixturesWithProblems: 0、anchorProblems: []）
npm run brain -- --schema         # 打印每个能力必须返回的 JSON 契约
npm run brain -- --anchors        # 打印它是怎么从 industry/prompts/*.md 认出"这一步是谁"的（2026-10-01 本机：problems: []；锚点总数看 stub 启动那一行"能力 13 个，锚点 215 条"，改提示词它会变）
curl -s http://127.0.0.1:3055/healthz                       # 能力数、锚点数、词表、fixture 数、默认策略
curl -s "http://127.0.0.1:3055/__brain/log?limit=20"       # 最近 20 次：认出哪一步、命中哪条 fixture、谁写的、答了什么
```

三条会咬人的规矩（细节在 `tooling/brain-README.md`）：

1. **摘要里的机构写法必须和原文一致。** 原文写 `USGS`，摘要写"美国地质调查局"会被 `enforceIdentity` 判成张冠李戴，**整段摘要丢掉**。`--lint` 会替你撞这条。
2. **标签必须是 `industry/taxonomy.ts` 三个词表里的写法**，不在词表里的会被 `normalizeTags` 静默丢弃。
3. **回执按 `logical_key` 缓存**（`receipts.ts:71,110-116`）：同一 `revision` 重跑分析会复用已存的回答，**不会再打到 stub**。键里hashed 的是 `{model, promptVersion, system, user, temperature, maxTokens}`（`providers/llm.ts:185`）——所以改提示词/换模型/改正文会真重问，而**改门槛或改源的 tier 不会**。要让旧材料按新门槛重新判一次：`scripts/enqueue-analysis.ts --all`（复用答案、零新请求）；要真重问单条：后台 `/admin/content/<id>` 的"重跑分析"（带 `attemptTag`）。三条路径写在 `docs/geohot-runbook.md` 第 4.1 节。

stub 是开发工具，不是站点的一部分：不在 `docker-compose.yml` 里、不写数据库、不含密钥、不进公开出口、不鉴权（所以只听 127.0.0.1，别放到公网）。审计日志只在内存里（默认 500 条），重启就没。

---

## 5. 怎么改成你的行业 / 怎么运营

行业相关的一切都在 `industry/` 这一个文件夹，`apps/` 和 `packages/` 基本不用动：

| 文件 | 管什么 |
|---|---|
| `site.ts` | 站名、行业词（`subject`）、首页与关于页文案、MCP 工具名前缀、`contactEmail`、`icp` |
| `taxonomy.ts` | 6 个分类（`key` 进 URL，上线后不可改）、7 个内容类型、三个标签词表、机构名录 `ENTITIES`、防张冠李戴的 `IDENTITY_LEXICON` |
| `topics.json` | 主题页目录（`/topics`，当前 45 个主题） |
| `sources.json` | 首次启动导入的信源（`ON CONFLICT DO NOTHING`，只增不改，之后在后台增删） |
| `prompts/` | 精选标准与写作要求，**行业 KnowHow 就写在这里**。27 个文件，改提示词不用改代码 |
| `selection.ts` | 入选门槛与 `understandFloor`（见第 6 节，文件里写着算式） |
| `features.ts` | `leaderboard: false`、`codexResetMonitor: false`（两个 AI 专属模块，地理站都关了） |
| `brand/` | 图标与日报报头字 |
| `pages/` | `terms.md`、`privacy.md`，**目前还是模板**，上线前要站长本人确认 |
| `changelog.json` | 更新日志，新条目写最前，并同步 `latestVersion` |

**六种信源**：`rss`、`web_list`（网页列表 + 选择器）、`json_list`（JSON 接口 + 字段路径）、`x_search`（X 账号，要 `SOCIALDATA_API_KEY`）、`mp_account`（微信公众号，要 `DAJIALA_KEY`）、`external`（你自己的脚本推进来）。每种信源认哪些配置键写在 `packages/backend/src/sources/config-keys.ts`，白名单外的键在保存、预览和 seed 时都会被**明确拒绝**，不会悄悄退回通用解析。`industry/sources.json` 当前 44 条：`rss` 26、`web_list` 7、`json_list` 3、`external` 8；后两种付费信源本部署没有 key，一条都没登记。

**后台**（`/admin`，**本机也要登录**：未访问 `/admin` 会被 302 到 `/admin/login`，密码是 `.env` 里的 `ADMIN_PASSWORD`——`npm run env:init` 生成并在终端打印一次，登录以后 30 天不用再来（会话 cookie `aihot_admin`，库里只存令牌哈希）。cookie 按主机绑定，`localhost:3000` 和 `127.0.0.1:3000` 混用会"看起来登录不上"。命令行怎么拿 cookie 见 `scripts/README-ingest.md`）。旧写法说的"`DEV_AUTH_ROLE=admin` 直接进、不用密码"已经作废：那个开关被从 `.env` 与 `.env.pipeline` 双双摘掉，它存在时后台所有写接口等于不鉴权，别再装回去（第 11 节有实测对比）。`industry/features.ts` 两个开关关掉以后，侧栏里剩这几项（`apps/web/app/routes/admin/layout.tsx:26-46`）：`/admin`（概览）、`/admin/content` 内容诊断与可见性、`/admin/sources` 信源（列表按健康度排序、失败的在最前；详情有"预览抓取"（不入库）、"立即采集"、改频率/分级/参与方式；`/admin/sources/new` 新建）、`/admin/feedback` 反馈、`/admin/runs` 定时任务最近结果、`/admin/models` 每一步单独换模型与成功率/token、`/admin/selectbench` 精选评测版本对比、`/admin/settings` 预算熔断与安全项、`/admin/audit` 审计记录。**`/admin/monitor`（Codex 重置）从侧栏消失了**（`layout.tsx:32` 按 `FEATURES.codexResetMonitor` 门掉），而且**路由与接口都真的关着**：`apps/api/src/routes/admin.ts:100-102` 用同一个开关包住了七个 monitor 端点（带会话访问 `/api/admin/monitor/events` 实测 404），页面路由本身是死路由（`apps/web/app/routes.ts:48`），直接敲 `/admin/monitor` 得到的是 404 页面（2026-10-02 实测）。底下那几张表已经空了（原来的行在 `monitor_*_bak_20260930`，见第 7 节第 9 条）。`/leaderboard`、`/codex-reset` 也是真的 404。

**人工投递**（野外与考察、采不到的国内官方一手记录就是这样进站的）：`POST /api/ingest/items`，`Authorization: Bearer <INGEST_TOKEN>`，每次最多 50 条（超出 413）、每 IP 每分钟 10 次（超出 429）；正文靠回源抓取，所以一手记录建议同时写进语料文件用 `npm run seed:curated` 带正文入库。完整做法、参数和 48 小时陷阱写在 **`scripts/README-ingest.md`**。`INGEST_TOKEN` 由 `npm run env:init` 生成（48 位十六进制），所以这条路在干净克隆里也是通的；留空、少于 16 位、或写成 `changeme/placeholder/xxx/test/dev/your-token` 这类占位词时接口一律 401（`apps/api/src/routes/ingest.ts:9-19`），改完 `.env` 必须重启 api。2026-10-01 干净克隆实测：不带 `Authorization` → 401，带 env:init 生成的 token → `200 {"ok":true,"created":1}`，同一 URL 重投 → `created:0`。

命令行侧运营工具备着：

```bash
node --env-file=.env --env-file=.env.pipeline scripts/collect.ts json-usgs-quake-m45   # 立刻采这一个源
node --env-file=.env --env-file=.env.pipeline scripts/enqueue-analysis.ts              # 把没分析过的排进队列
node --env-file=.env scripts/delete-sources.ts "<理由>" <source-id>...                 # 删源并撤下它的精选
```

---

## 6. 精选标准是什么（编辑改标准之前再读一遍）

**一句话标准：空间显著性。** 三件同时成立才排得靠前——影响尺度大、多方独立报道、有数据/图件/影像支撑。这条既写进了评分提示词，也写进了权重表，还写进了热度算法（"多方独立报道 = 热"）。

**内容类型与权重**（`industry/prompts/selection-score.md:49-57`；每行五轴权重之和 = 10，所以分数天然落在 0–100）：

| item_type | sig 实质份量 | nov 信息增量 | cred 证据强度 | reson 共振面 | act 可用性 |
|---|---:|---:|---:|---:|---:|
| `disaster_event` 灾害事件 | 3 | 1 | 3 | 3 | 0 |
| `observation_release` 观测与数据发布 | 2 | 2 | 3 | 3 | 0 |
| `policy_planning` 区划规划与政策 | 3 | 2 | 2 | 2 | 1 |
| `research_finding` 研究与科学发现 | 4 | 3 | 2 | 1 | 0 |
| `technology_release` 技术与软件 | 2 | 2 | 1 | 2 | 3 |
| `exploration_report` 考察与发现记 | 2 | 3 | 2 | 2 | 1 |
| `opinion_analysis` 观点与解读 | 1 | 3 | 1 | 3 | 2 |

前两行的 `cred` 是全表唯一最高（3）、`reson` 在最高一档（3），这就是"空间显著性优先"的量化形式。

**门槛与判定规则。** 每篇材料由同一份评分标准**独立打两次分**（`SCORE_CALLS = 2`，`editorial/analyze.ts:46`），判定是 `sum ≥ 2 × 门槛`（`analyze.ts:380`），卡片上显示两次的平均（向下取整）。门槛按信源分级。**现值只有 `industry/selection.ts:84,92` 是依据**（下表抄于 2026-09-30 02:33 那次 Wave 4 重算，抄录一定会落后于代码——要改门槛只改那个文件，不要回来改这里的数字；`docs/selection.md`、`docs/customize.md` 里的数字同样是抄录）：

| 分级 | 门槛（平均分） | 入选线（两次之和） | 放什么 |
|---|---:|---:|---|
| `T1` 官方一手 | **56** | ≥112 | 台站、卫星机构、部委数据发布 |
| `T1_5` 一手出版方与准官方 | **59** | ≥118 | 期刊目录、学会会刊 |
| `T2` 媒体与个人 | **62** | ≥124 | 媒体、刊物、项目频道、转载层 |

另有 `understandFloor = 46`：没入选但两次之和 > 92（`analyze.ts:354` 用的是严格大于 2×46）的材料，也用精选那套写法（标题、摘要、推荐理由、标签），其余走更便宜的标题摘要翻译。分级 `EXCLUDE_MP` 与表里没有的分级不参与精选。

**12 条噪声硬上限**（`selection-score.md:76-87`，逐条是 `sig ≤ n` 这类封顶）：旅游软文与研学招生、景区宣传稿（`sig ≤ 2`）；无数据的泛泛地方介绍（`nov ≤ 3` 且 `sig ≤ 4`）；多主题盘点稿（`sig ≤ 3`）；未经核实的地理传闻（`cred ≤ 2`，且预筛阶段直接 `BLOCK`）；GIS/遥感厂商版本通告（`sig ≤ 3`）；例行数据更新与同一指标复述（`sig ≤ 3`）；只有"即将发布"（`nov ≤ 3` 且 `cred ≤ 4`）；无路线无样品的个人见闻（`nov ≤ 3` 且 `sig ≤ 4`）；厂商绑定 how-to（`sig ≤ 3`）；单一小流域/样地的方法微调（`sig ≤ 4` 且 `reson ≤ 3`）；宏大观点与无后果的规划愿景（明显低分）。

**门槛拦不住什么——这一条必须写明白，别再把它当证明。** 上一版本文件（它当时还是仓库根的 README）在这里写过"营销软文数学上不可能入选（114 < 116）"，**那句话已经被独立审计推翻并且被 Wave 4 撤掉了**（撤掉的说明与新算术就写在 `industry/selection.ts:8-24`）：那 12 条硬上限只封住一到两轴，而**五轴从不回传代码**（`ScoreSchema` 只校验 `attentionScore` 是 0–100，`analyze.ts:71`），未封顶的轴按定义能给到 10。按字面重算，营销与景区稿的天花板是 **92 分**、盘点稿/例行更新/版本通告是 **93 分**、泛泛地方介绍 75、小流域方法微调 74——要关住 93 就得把 T1 抬到 ≥94，而人工语料最高一条（C3S 温度发布，两次之和 173）也进不来，精选会恒空。**所以这组门槛是经验护栏，不是证明。** 真在下限拦噪声的是两层别的东西：① `industry/prompts/prefilter.md` 的 `BLOCK`——Wave 4 把五类噪声（教育与文旅营销与景区宣传、无数据的泛泛介绍、未经核实的地理传闻、纯机关公文与会议通报、多主题盘点汇编）写成"即使带航拍影像、客流数字、坐标与官方图件也照样 BLOCK"（`prefilter.md:3`），它们到不了评分那一步；② 分级摆放——盘点与文旅向的转载层放 **T2**（`web-spacemapper-news` 就是这样登记的），这只决定"这个源的信材用哪一档线量"，**它本身挡不住 92–93 分**。还有一层诚实必须说：stub 的预筛兜底是 `PASS`（`tooling/brain-stub.ts:615`），所以①今天只在有人写过 BLOCK 判断的那些材料上真正成立。门槛的可行区间本身是被实测夹出来的（期刊层 119 不能被锁死、T1 上最高噪声 107 要关住、相邻档余量 ≥3 ⇒ T1 56 / T1_5 59 / T2 62），推演与双向核对全在 `industry/selection.ts:26-68`，那里也写着**这档最薄的一刀在 T1_5**：两条人工分正好压 118，最近的被拦者只差 2 分。

**分类与分节。** 6 个分类（`taxonomy.ts:11-18`）：自然地理 `physical`、人文地理 `human`、区域地理 `regional`、地理信息技术 `geotech`、野外与考察 `fieldwork`、观点与解读 `comment`。日报分节是 3 节：学科（自然/人文/区域）、技术（地理信息技术）、实践（野外与考察/观点与解读）。

**热度模型没改**（`packages/backend/src/events/hot.ts:8-10,93`）：窗口 48 小时、半衰期 24 小时、每个 `participant_key` 只投一票、至少 2 个参与者、其中至少 1 个是编辑类参与者。

---

## 7. 已知边界与待办

这一节不留情面。这份手册如果把这些藏起来，它就是失败的。

1. **国内信源层很薄。** 44 个信源里能真实轮询的 36 个以国际机构与英文媒体为主；国内可轮询的一手层只有 **7 个**：中国地震台网中心速报目录（`json-ceic-earthquake`）、中央气象台预警（`json-nmc-weather-alarm`）、国家统计局最新发布（`web-stats-latest`）、水利部数据（`web-mwr-data`）、水利部水利要闻（`web-mwr-news`）、应急管理部新闻发布会（`web-mem-press`）、《地理研究》当期目录（`web-dlyj-toc`）。**另外 8 个 `external` 源是给人工投递预留的通道，现在全部是 `participation_mode=isolated`（站上不可见）**：12379 国家预警信息发布中心、民政部县级以上行政区划变更公告、自然资源部新闻与地质灾害通报、《地理学报》当期目录、国家地球系统科学数据中心、《中国国家地理》dili360、第二次青藏科考、中国极地考察（雪龙航次）。原因是这些站没有 feed、是 SPA、有反爬或本机不可达——不是我们没试。要它们可见，得有人把条目推进 `/api/ingest/items` 并把该源改成 `editorial`。
2. **语料是人工策划的，不是模型驱动的。** 见第 4 节。目前的"精选"反映的是写 fixture 那几个人的判断，模型能力一点都没有被用到。
3. **门槛仍然是推出来的，不是校准出来的。** `industry/selection.ts:70-75` 自己写着：`.data/gold.jsonl` 不存在，`industry/gold.example.jsonl` 的 12 条是按真实信源形状**编造的示意材料**，不是人工标注；56/59/62 的"实测"来自 fixture 里人工写的两次分数，样本只有四个语料集约 60 条材料，没有查准率/查全率，也不知道把 56 挪到 58 会翻掉几条；文件里还标出了**最薄的一刀在 T1_5**（两条人工分正好压 118，最近的被拦者只差 2 分）。上线前要让读这个站的人标 100–200 条，用 `scripts/eval-selection.ts --gold .data/gold.jsonl` 重跑（方法在 `docs/selection.md`；注意它读的是 `--gold` 指定的文件，默认 `.data/gold.jsonl`，不是那个 example）。
4. **澎湃进不了精选。** 它最好的材料两次之和 105，低于 `T2` 的入选线 124，所以进不来（`industry/selection.ts:55-58` 的 T2 双向核对里它就在"关"的那一列）。**但别把这句话读成"门槛挡得住营销稿"**——第 6 节已经写清按字面算营销类噪声的天花板是 92–93 分、任何可用门槛都关不住它，所以澎湃这条靠的是分级与预筛，不是算术证明。它转载的赣江/韩江洪水由 T1 的水利部通道一手供给（135 ≥ 112，进得来）。
5. **`野外与考察`（fieldwork）靠人工投递，当前几乎没有供给。** 25 个可轮询 feed 里没有任何科考队或航次主办方。分类 `key` 进 URL，不能删，所以它的空状态是设计的一部分。
6. **当前这库里的可见结果就是这样（数字会变，别当稳定态，也不要抄进任何地方）。** 这一条以前写死过一批快照数（`articles` 272、精选 `count`=1……），独立审计时现场已经是 **59 条精选**，抄录再一次落后于事实。改文档这一天里它就漂了两次（`publications` 887→890、`analyses` 1004→1013），worker 一直在采。**所以这里只给查法**（2026-10-01 11:40 本机再跑的那一瞬：articles 890 / publications 890（其中 public 889）/ stories 446 / analyses 1013 / sources 45 / topics 45 / 精选 59；下一秒再看就可能又是别的数）：

```bash
curl -s http://127.0.0.1:3199/api/v1/selected/snapshot | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('精选',JSON.parse(s).count,'条'))"
node --input-type=module -e "import p from 'postgres';const d=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});for (const t of ['articles','publications','stories','analyses','sources','topics']) console.log(t,(await d.unsafe('SELECT count(*)::int c FROM '+t))[0].c);await d.end()"
node --input-type=module -e "import p from 'postgres';const d=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});console.log('按可见性',await d.unsafe('SELECT visibility, count(*)::int c FROM publications GROUP BY 1'));console.log('category 为 NULL 的分析',(await d.unsafe('SELECT count(*)::int c FROM analyses WHERE category IS NULL'))[0].c);await d.end()"
```

`sources` 表比 `industry/sources.json` 的 44 条多出来的那一条是 `ext-opscheck-ingest-probe`（运维校验时投递接口自动建的 `external`/`isolated` 占位源，站上不可见），清理 SQL 在 `scripts/README-ingest.md` 末尾。`/hot`、`/daily/<日期>` 这类页面直接开一下看最快（本机 `daily/2026-10-01` 是 200）。剩下三条原因仍然成立：① 语料的 `discoveredAt` 会被保序重映射到锚点前 45 小时，48 小时窗口一直在往下滑，旧条目会被 `isHistorical()` 判为历史（不给热度、不成事件）；② 门槛在 Wave 4 重算过一轮（第 6 节）；③ 新采回来的材料还没有对应的人工 fixture 判断——`analyses` 里 1013 行有 857 行 `category` 为 NULL（2026-10-01 11:40 实测，就是下面第三条命令的 `catnull`），就是绝大多数材料落在 stub 的确定性默认值上。**这不是"跑起来就长这样"的稳定态**，怎么让它有货见 `docs/geohot-runbook.md` 第 4 节与排查表。
7. **站长本人要填的东西还空着。** `site.ts:38` 的 `contactEmail` 现在是 **`null`**（不是占位地址）：`/.well-known/security.txt` 因此按设计返回 404（`apps/api/src/routes/static.ts:169` 在没有邮箱时直接回 404），`llms.txt` 也省略联系一行——宁可不发布，也不挂一个没人看的地址；填上真实地址后两个出口会自动出现（子路径部署还有一层 RFC 8615 的限制，见 `docs/known-issues.md`）。`site.ts:50` 的 `icp` 是空串，备案号只能由主办者本人申请，页面因而不显示它；`organization.founder` 现在写"地理热点编辑部"，愿意署名再改；**默认地址不在 `site.ts` 里当域名用**——`site.ts:28` 的 `defaultUrl` 是 `http://localhost:3000`，只在没有 `SITE_URL` 时兜底，真实地址一律由环境变量 `SITE_URL` 给（生产下留空或留 localhost 会拒启，`packages/backend/src/config.ts:54-68`）；托管地点与适用法律（境内还是境外）没有决定；`industry/pages/terms.md`、`privacy.md` 还是模板，需要本人确认。
8. **语料已经在仓库里，重建演示数据不再依赖仓库外的东西。** 这一条以前写的是"`seed-curated.ts` 的默认输入是仓库外的 `.brief/curated-materials.jsonl`（99 行），清理研究产物会打断这条命令"——现在不成立了：`scripts/seed-curated.ts:41` 的默认输入是 `tooling/corpus/curated-materials.jsonl`（受版本控制），行数请用命令看（`npm run seed:curated -- --dry-run --enforce-source` 打印 `117 material line(s)`；`wc -l` 会给 118，因为末尾还有一个空行——审计说的"118 条语料"就是这个差一）。同一目录里还有分主题语料 `corpus-*-materials.jsonl` 与配套的 `corpus-*-brain.jsonl`、三行测试夹具 `tooling/corpus/curated-sample-test.jsonl`（用法见 `scripts/README-ingest.md`）。仓库里仍然提到 `.brief/`（那个会被清理的仓库外研究目录）的 tracked 文件，本轮已清掉两个归文档管的：`docs/geohot-runbook.md`、`docs/selection.md`；本文件与 `AGENTS.md`、`scripts/README-ingest.md` 里剩下的都只是叙述性提及（"那个目录要清理/曾在这里留过什么"），`.gitignore` 里的 `.brief*/` 是 ignore 规则本身。仍把仓库外路径写进注释/数据的还剩 5 个：`industry/selection.ts:8`（门槛推演记录的出处）、`industry/brand/logo.svg:31`（构建脚本位置）、`tests/industry-vocabulary.test.ts:2`（前身脚本）、`tooling/corpus/README.md:5` 与 `tooling/corpus/curated-sample-test.jsonl` 头行（都是"删掉 `.brief/` 不影响这里"的历史说明）。**没有任何命令读它们**，但按交付清理纪律它们该在 `.brief/` 删除前改成仓库内表述——各文件 owner 的逐条工单已开（仓库外交付材料，不随仓库走）。
9. **库里留着清理痕迹。** 关掉模型榜与 Codex 监控之后，上游 seed 灌进来的 2184 个 AI 模型和 18 个 AI 信源被整表改名成了 **12 张 `*_bak_20260930` 表**（`lb_*` 7 张、`monitor_*` 4 张、`sources_bak_20260930`）。现行 `lb_models`、`monitor_events` 已经是 0 行，`sources` 里是 44 条地理源。备份表不影响站点，但占地方、也让 `docs/leaderboard.md` 描述的东西看起来还在。确认不再需要就 `DROP TABLE`。
10. **上游 `docs/` 有一批说法已经不成立**（`docs/architecture.md` 的测试命令、`docs/deploy.md` 的 Docker/`init-env.ts`/`pg_dump`/成本口径、`docs/leaderboard.md` 描述的模块、`docs/sources.md:67` 的计费区间）。逐条状态写在第 9 节那张表里。`docs/selection.md`、`docs/customize.md` 的门槛数字已由文档负责人按本站改写，但它们仍是**抄录**——门槛的唯一依据是 `industry/selection.ts`，跑法的唯一依据是本文件第 3 节。
11. **上线相关的决定，如实记录在这里（以及部署包 README-deploy.md 第 0 节，两处必须同步改）：** ① 站点跑在**人工策划的编辑大脑**上（`tooling/brain-stub.ts` + fixture，没有任何 LLM Key）——所以精选不随抓取量增长，**只随人在 `tooling/fixtures/*.jsonl` 里新写的判断增长**，新采材料落默认值（打分 20、归组 UNRELATED），站点会随 48 小时窗口变旧；这不是故障，第 7 节第 6 条与部署包故障表都按这个口径写。② 面向读者的"关于"文案**已经**改成描述真实闸门（预筛 + 两次独立打分 + 人工写的标准），不再声称"用模型写/模型自动评分"——现场核验一行：`grep -n "用模型写" industry/site.ts` 必须为空（2026-10-01 实测为空）。③ 公开仓库的发布走 `deploy/geohot/publish-to-github.sh`：在临时索引里从 HEAD 造发布树、以远端当前 HEAD 为父、快进推送（不 force、不改写线上历史），随后 `verify-github-sync.sh` 逐字节验收——含把每张配图从远端取回比哈希、SVG 走严格 XML 解析、README 的相对引用逐个命中。排除清单只有 `deploy/geohot/publish-excludes` 这一处来源（发布脚本与验收脚本共用），现在是空的：CI 定义搬到 `tooling/ci-check.yml`（发布用的 token 没有 `workflow` 作用域，GitHub 拒绝它创建或更新 `.github/workflows/*`），上游宣传图已删。④ `xxc2007.me/geohot/` **已于 2026-10-01 上线**：四个常驻单元（brain/api/worker/web）各带 `MemoryMax`，只监听回环，nginx 在 `:80` 与 `:443` 两个 vhost 各注入一组 `^~ /geohot` location（`^~` 与"不剥前缀"两条都是承重的，理由写在 `deploy/geohot/geohot.nginx.conf片段` 头部）。装法与逐条验证见 `deploy/geohot/DEPLOYMENT.md`。2026-10-02 那一轮把部署包内部对齐了：安装目录只剩一个变量 `GEOHOT_APP_ROOT`（默认 `/opt/geohot/app`，四个脚本与 `systemd/` 模板共用），前缀只剩一个变量 `GEOHOT_BASE_PATH`（默认 `/geohot`，**构建期**变量——线上单元里那条 `Environment=BASE_PATH=/geohot` 是惰性的，已删；域名根部署显式写 `GEOHOT_BASE_PATH=""`），`systemd/` 补齐了第四个 `geohot-brain.service`（`MODEL_CALLS_ENABLED` 缺省是 `true`，没这个单元又没显式写这一行，分析调用就全打到没人听的 127.0.0.1:3055），恢复与搬家清单写在 `deploy/geohot/README-deploy.md` 第 6.1 与第 10 节。

---

## 8. 检查命令

这四条命令都假设第 3.2 节已经跑过（`npm ci` + `npm run env:init`）。`npm test` 和带 `--env-file-if-exists=.env` 的脚本会读 `.env`：文件不存在时 `--env-file-if-exists` 静默跳过、`npm test` 则只看 shell 里的 `DATABASE_URL`，于是失败信息长得跟真正的原因（缺 env 文件）毫无关系。

```bash
npm run typecheck
```

覆盖 5 个工程 + web（`packages/contracts`、`packages/backend`、`apps/api`、`apps/worker`、`tests`、`@aihot/web`）。干净克隆里也跑过一遍，两边都是退出码 0、无输出。

```bash
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_test npm test
```

**库名必须以 `_test` 或 `_ci` 结尾**，否则 `tests/setup.ts:10` 直接抛错拒绝——这些测试会写库，不允许指着主库 `geohot`。本机没有 `createdb`/`psql`，建这个库用：

```bash
node --input-type=module -e "import p from 'postgres';const a=p('postgres://geohot:geohot@127.0.0.1:5433/postgres',{max:1});await a.unsafe('CREATE DATABASE geohot_test');await a.end()"
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_test node --env-file-if-exists=.env scripts/migrate.ts
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_test npm test
# 用完删掉：DROP DATABASE geohot_test
```

`npm test` 是 `node --test --test-concurrency=1 --test-timeout=120000 "tests/*.test.ts"`（串行跑，测试之间共享这个库）。测试不访问任何外部服务——前提是 `.env` 里那两个阀是 false（第 11 节第 1 条）。

```bash
npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://localhost:3000
```

前者是 web 的构建 + 7 个前端测试文件（`admin-safe-link`、`cache`、`item-toolbar`、`local-state`、`markdown`、`request-cancellation`、`session-cache`）；后者要求站点已经在跑，覆盖页面、RSS、OpenAPI、`llms.txt`、分享图和 MCP。`smoke.ts` 只读，不写任何东西；它检查的条数写在它自己的输出里（`--base` 指哪套栈都行，本机 live 栈在 3000）。
**那条 build 命令不要带 `BASE_PATH`**：这批测试读的是构建产物里的链接，`item-toolbar` 等三条明确断言"这一份构建是根部署，前缀为空"——用 `/geohot` 的构建去跑会得到 7 条假失败（2026-10-03 本机实测：带前缀 23/30，不带前缀 30/30；CI 走的正是不带前缀那条）。线上要验前缀，看 `deploy/geohot/verify-deploy.sh` 第 3 节。本轮改完文档之后的实跑结果（2026-10-01，同一台机器上 live 栈正在跑）：

```
$ npm run typecheck
> tsc -p packages/contracts && tsc -p packages/backend && tsc -p apps/api && tsc -p apps/worker && tsc -p tests && npm run typecheck -w @aihot/web
> react-router typegen && tsc -p .
（无错误输出）                                             exit 0

$ node scripts/smoke.ts --base http://localhost:3000
✓ /   ✓ /all   ✓ /hot   ✓ /daily   ✓ /daily/archive   ✓ /topics   ✓ /starred   ✓ /agent   ✓ /about
✓ /changelog   ✓ /feedback   ✓ /terms   ✓ /privacy   ✓ /more   ✓ /admin/login
✓ /api/health   ✓ /api/v1/items   ✓ /api/v1/hot-topics   ✓ /api/v1/selected/snapshot
✓ /feed.xml   ✓ /feed/all.xml   ✓ /llms.txt   ✓ /robots.txt   ✓ /sitemap.xml   ✓ /manifest.webmanifest
✓ /openapi-v1.json   ✓ /og/site.png   ✓ /icon.png   ✓ /favicon.ico   ✓ /api/mcp initialize
all checks passed                                          exit 0
```

也就是 **`PAGES` + `MACHINE` 两张表里的全部条目（2026-10-03 是 17 + 18）再加两条跨出口不变量，全 ✓**。注意 `/admin/login` 在页面那张表里，而 `/admin` 本身不在——smoke 不测登录态，后台是否锁着要用第 11 节第 3 条那组命令。

### 8.1 CI 说明：上游工作流为什么不在发布树里，以及你自己的 CI 该跑什么

工作区里还留着上游的 `.github/workflows/check.yml`（baseline 提交带进来的），但**公开发布树刻意剔除了整个 `.github/`**，两个原因：① 发布用的 GitHub token 没有 `workflow` 权限范围，带 `.github/*` 的推送会被平台直接拒绝；② 那条流水线是上游 AIHOT 的门禁序列（`postgres:17-alpine` 服务容器、库名 `aihot_ci`、没有 `env:init` 一步），与地理站本机验证的门禁序列不同，与其悄悄跑一条和文档对不上的 CI，不如把它摘出来写明白。要接你自己的 CI，等价序列就是下面这组（数据库给一个空 PostgreSQL，**库名必须 `_test`/`_ci` 结尾**，`tests/setup.ts:10` 会拒别的）：

```bash
npm ci
npm run env:init                                   # 写出 .env 与 .env.pipeline（别先手工 cp——它会拒绝覆盖已存在的 .env）
                                                   # 或者干脆在 CI 里直接注入 DATABASE_URL/SITE_URL/SESSION_SECRET… 环境变量
npm run typecheck
npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
node scripts/migrate.ts && node scripts/seed.ts    # 建表 + 灌分类/主题/信源
DATABASE_URL=postgres://…/aihot_ci npm test        # 安全阀保持 false，测试不碰外部服务
node scripts/smoke.ts --base http://127.0.0.1:3000 # 起 api+web 之后（跑法见 §3.3 / 上游 check.yml 的 smoke 步骤）
```

上游那份 `check.yml` 里的 Docker 构建 job 本站没有采用（本机没有 Docker，交付走 embedded PostgreSQL，见 §3.6）。

---

## 9. 文档

| 文档 | 内容 | 状态 |
|---|---|---|
| `../README.md` | 面向读者的介绍页：这是什么、六个分类、精选标准、技术栈、`industry/` 换行业层、截图 | **本站写的，公开仓库的门面**。三张配图（`docs/shots/`）的说明都写死了拍摄日期、路由与视口，并明说"线上才是事实来源"——它们是 2026-10-02 14:02–14:03 的快照，其中两处英文文案当天 20:10 之后已修（2026-10-03 复核线上为中文）。介绍页里凡是"每天 08:00 就会变"的数字都不再写死：期数指向 `/daily/archive`，信源条数指向 `industry/sources.json`，热度指向 `/hot` |
| 本文件（`docs/manual.md`） | 这是什么、怎么跑、内容从哪来、精选标准、已知边界 | **本站写的，操作口径以它为准** |
| `docs/geohot-runbook.md` | 运营者的日常循环与故障排查表 | **本站写的** |
| `tooling/brain-README.md` | 编辑大脑 stub 的能力契约、fixture 格式、补稿流程 | 本站写的 |
| `scripts/README-ingest.md` | 语料入库与人工投递的两条路线、48 小时陷阱 | 本站写的 |
| `industry/prompts/` | 每一步提示词的原文 | 本站已改成地理 |
| `AGENTS.md` | 给 AI 助手的规则（哪些目录能动、哪些边界要守住） | 本站改过：本机跑法、地理层现状、安全阀用法 |
| `docs/customize.md` | 怎么改成别的行业 | 上游参考，**步骤成立**；门槛那一段本站已按 `industry/selection.ts` 改写过，仍是抄录 |
| `docs/sources.md` | 六种信源怎么配 | 上游参考，基本仍然成立；`:67` 那句"按次计费最长 120–180 分钟"本站已就地改写过（180 属于 `participation_mode=hot_signal`、120 属于 `x_search`/`paid_listing`，依据是 `packages/backend/src/sources/collect.ts` 里 `adaptIntervals` 的 `const max = …` / `const min = …` 两行），而且**本站一条按次计费的信源都没有**（`x_search`/`mp_account`/`paid_listing` 现值 0）。信源条数的唯一说法在 `../README.md` 的「现状与边界」一节，本文件与 `docs/customize.md` 都只指向它 |
| `docs/selection.md` | 精选与校准的方法 | 方法可用；本站已把门槛一段改成指向 `industry/selection.ts` 并抄了现值——**代码是依据，文档是抄录** |
| `docs/architecture.md` | 三个进程、几条不变的规则、目录、对外出口 | 上游参考，`:71-73` 的 `createdb …5432/<名>_test` 本机跑不通（没有 createdb/psql，集群在 5433） |
| `docs/migration.md` | 换域名 + 换服务器的逐条清单（每步都给验证命令） | **本站写的**（2026-10-03 新增）；与 `deploy/geohot/README-deploy.md` 第 10 节同源，那一份偏 nginx/systemd 路线，这一份偏"从公开仓库克隆起来"的读者视角 |
| `docs/deploy.md` | Docker、域名与 HTTPS、备份与恢复、成本 | 上游参考，**但本站已把它改到能照着走完**：本机没有 Docker、bundle 里没有 `pg_dump`（这些仍然只适用于开发机）；它教的"手工 `cp .env.example .env`"这条路走不通（五个密钥键是空的、`.env.pipeline` 根本没有），本机用 `npm run env:init`（第 3.2 节）。**2026-10-03 改掉三处会误导人的地方**：① 第一条命令原本克隆的是上游 `KKKKhazix/AIHOT`——照它做会部署成另一个站，已改成本仓库 `xxc2007/GeoHot`；② 原本写着"起容器一两分钟后开始出现内容"，而 `env:init` 写出的 `.env` 里 `COLLECT_ENABLED=false`（`.env.example:82`，`init-env.ts` 不动这两个阀）、`apps/worker/src/main.ts` 里那句 `if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss)` 就不注册抓取任务，`setup` 也只跑 migrate+seed（不跑 `seed:curated`，人工语料不在这条路线上），已如实写出前置动作；③ 新增「Docker 这条路是域名根部署」一节（`Dockerfile:21` 构建不带 `BASE_PATH`、`docker-compose.yml:78` 直发 3000，复现不了线上 `/geohot`）。"152 条约 930 次模型调用"已标明是上游那个行业的账单口径。装法与恢复仍以 `deploy/geohot/README-deploy.md`（第 6.1、10 节）与 `DEPLOYMENT.md` 为准 |
| `docs/leaderboard.md` | 模型榜与 Codex 重置监控 | 上游参考。**这一行是"这两个模块本站已关"的唯一完整表述**（其余文档一律指回这里或指回代码）：唯一依据是 `industry/features.ts` 里的 `leaderboard: false` 与 `codexResetMonitor: false`；后果是 `/leaderboard`、`/leaderboard/rules`、`/leaderboard/sources`、`/codex-reset` 四条页面路由不渲染、对应接口不注册（`apps/api/src/routes/admin.ts:100-102` 的七个 `/api/admin/monitor/*` 端点由同一个开关门控，带会话实测 404），`hot.rank` 之类与它们无关的任务照跑；`lb_models`/`monitor_events` 现为 0 行，上游 seed 灌进来的行整表改名在 12 张 `*_bak_20260930` 里（第 7 节第 9 条）。要给别人重新打开，先读那份文档开头写的"这只对 AI 行业有意义" |

---

## 10. 上线前必须做的事

这一节是给"要从这台机器搬到公网"那一天用的。**当前这棵树不是可上线状态**：`.env` 是开发配置（`NODE_ENV=development`，密钥是 `npm run env:init` 生成的随机值、只在这台机器上成立），条款与隐私页还是模板，`contactEmail` 是 `null`、`icp` 是空串（现值与后果以第 7 节第 7 条为准，本节不重抄）。逐条做完再对外。开工前先读第 11 节的预检——它给的是"怎么证明现状"，不是"觉得应该没问题"。**要搬去的是新域名 + 新服务器**（而不只是把这台机器暴露出去）时，逐条可验证的清单在 [`docs/migration.md`](migration.md)。

**本节与部署包（README-deploy.md，随交付、不在仓库树内）第 5 节的"生产 env 逐项核对表"逐行对齐（2026-10-01 核对）；那张表是键级细则，本节是动作清单，两处不一致时以对着代码复核后的那处为准并同步改另一处。** 生产必须与本 `.env` 不同的取值，一句话版：`NODE_ENV` 与 `AIHOT_ENVIRONMENT` **两个都是** `production`（第 11 节第 2 条解释了为什么只改一个等于没改）；任何 `DEV_AUTH_*` 整行删除；`SITE_URL=https://xxc2007.me/geohot`（https 前缀让会话 cookie 自动加 `Secure`；路径部分必须等于构建期的前缀。2026-10-02 起生产**不再容忍缺值或 localhost**——`NODE_ENV` 或 `AIHOT_ENVIRONMENT` 有一个是 production 就拒启，`config.ts:54-68`，因为那个安静的回落会把 localhost 写进 canonical/OG/RSS/sitemap/robots/security.txt 并让 MCP 的 host 锁拒掉真域名）；`TRUST_PROXY=true`（**web 与 api 两个进程都读这一行**，写法一致：`server.ts:20` 与 `app.ts:28`；不开就把全体访客的登录/反馈限速算到代理那一个 IP 上。api 侧以前是写死 `trustProxy: true`、与这行无关，所以那时"false 保护 api 限流"并不成立——现在成立了，也意味着**这行漏写会让 api 不再信 XFF**，两个进程都要显式写）；`SESSION_SECRET`/`IMG_PROXY_SIGN_SECRET` 服务器上新生成（Linux 可用 `openssl rand -hex 32`，本机没有才用 node 一行）；`ADMIN_PASSWORD` ≥12；`INGEST_TOKEN` ≥16 或留空（留空=入口关死，比弱值安全，见第 7 条）；`DATABASE_URL` 指向生产的系统 PostgreSQL，**不要搬本机 127.0.0.1:5433 的 embedded 串**（§3.6 那套是 Windows 开发机专用）；`COLLECT_ENABLED=true` 显式写；`MODEL_CALLS_ENABLED` 二选一——生产留 stub 进程则 `true` 且 `LLM_BASE_URL=http://127.0.0.1:3055/v1`（只听回环、绝不公网），不留则 `false` 并接受"新料只进全部、不进精选"；`FEISHU_*` 与 `INDEXNOW_SUBMIT_ENABLED=false`（子路径部署下 IndexNow key 文件落 `/geohot/<key>.txt` 的可达性未确认）；`TZ=Asia/Shanghai`（§11.1 讲过 json_list 不带时区的坑）。注意 `LLM_API_KEY=local-brain` **不在**占位黑名单里（11 字符、不匹配 `config.ts:124` 的正则），代码拦不住它——这一行必须人工核对。

1. **开发登录后门：已经摘掉了，别装回去，并证明它还关着。** 本机 `.env` 与 `.env.pipeline` 都不再有 `DEV_AUTH_ROLE`（旧版这一节写的"删掉 DEV_AUTH_ROLE"已经完成，本文件与 `AGENTS.md` 里"本机免登录后台"那句是当时的旧话，本轮已改正）。剩下的动作是切生产：`NODE_ENV=production`，同时注意 `AIHOT_ENVIRONMENT`（第 11 节第 2 条讲这两者的分工）。代码里有拒启检查（`packages/backend/src/config.ts:127-137`）：任何 `DEV_AUTH_*` 键、`changeme/placeholder/test/xxx/your-*` 这类占位密钥、长度不足 8 的密钥、`ALLOW_PRIVATE_NETWORK_FETCH` 都会让 api/worker 拒绝启动——但它只在真的用 `NODE_ENV=production` 启动时才起作用，所以**验证方式是起进程看不肯起，而不是"觉得应该没问题"**。同一道闸门现在也管 `SITE_URL`（`config.ts:54-68`：生产下缺值或 localhost 直接拒启）。生产密码与密钥重新生成一轮（`SESSION_SECRET`、`ADMIN_PASSWORD` ≥12 位、`IMG_PROXY_SIGN_SECRET`、`INGEST_TOKEN` ≥16 位）：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`（本机 Git Bash 里没有 `openssl`，别照 `docs/deploy.md` 抄那条）。最后 `curl -i https://<host>/api/admin/sources` 必须 401 才算过关。
2. ~~**`/api/admin/monitor/*` 仍挂着。**~~ **2026-10-02 更正：已经关着。** `apps/api/src/routes/admin.ts:100-102` 的七个端点由 `FEATURES.codexResetMonitor` 整体门控（带会话访问实测 404），`/admin/monitor` 是死路由、直接敲 URL 得到 404 页面（`docs/known-issues.md` 里那条"死路由"登记的是 routes.ts:48 的注册本身，不是"仍能渲染"）。底表已空（行在 `monitor_*_bak_20260930`）。
3. **安全阀在生产上要一个个决定，不要整份搬 `.env.pipeline`。** `.env.pipeline` 是本机一次性文件，不是生产模板。`COLLECT_ENABLED=true` 才会真的去抓信源；`MODEL_CALLS_ENABLED=true` 只在你已经给 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 填了真东西之后才打开——本站现在指向 `tooling/brain-stub.ts`（127.0.0.1:3055，无鉴权、只监听回环）。**不要把 stub 暴露到公网**，也不要用它冒充"模型已经在工作"上线。`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED` 按你确实接了哪些外部服务来开。
4. **站长的身份信息只能他本人填。** `industry/site.ts`：`contactEmail`（**现在是 `null`，不是占位地址**——`/.well-known/security.txt` 因而是"注册了但按设计 404"，`static.ts:169` 在没有邮箱时直接回 404，`llms.txt` 也省略联系行；填上真实地址两个出口自动出现。现值与后果的唯一表述在第 7 节第 7 条）、`icp`（`site.ts:50`，空串就不显示；备案号必须由主办者申请，别人不能代填）、`organization.founder`、`SITE_URL`、域名与托管地（境内还是境外决定适用法域）。`industry/pages/terms.md`、`privacy.md` 现在还是模板，需要本人确认措辞。**这一条以前还写着"灾害与预警的安全声明只在 `/terms` 出现、条目页看不到"，那是错的**：`apps/web/app/routes/item.tsx:317` 会在命中灾害标签的条目页上直接渲染"本站不是预警信息的发布机构，本页内容不构成预警依据……"，本机实测 `curl -s http://localhost:3000/items/china-L11 | grep -c 不构成预警依据` → 1（非灾害条目是 0，这是刻意的）。读者要行动的地方就有这句话，别在部署时把它删掉。
5. **HTTPS 走 Caddy profile，但本机跑不了它。** 官方路径是 `docker compose --profile https up -d --build`（`docker-compose.yml:78-89` 的 `caddy:2-alpine` + `deploy/Caddyfile`，证书存在 `caddy` 卷）。这台机器没有 Docker，所以这一条要在真正的部署主机上做；换别的反代时记得 `.env` 里 `TRUST_PROXY=true`——**web 与 api 都读它**（`apps/web/server.ts:20`、`apps/api/src/app.ts:28`；api 那个写死的 `trustProxy: true` 已在 2026-10-02 改成跟随这一行，直接对外时保持 `false` 才是安全的）。
6. **备份的现实比文档窄。** embedded-postgres 的 bundle 里**没有 `pg_dump.exe`**（只有 `initdb`/`pg_ctl`/`postgres`），而 `packages/backend/src/operations/backup.ts:83` 调的就是外部 `pg_dump`——所以应用自带的 `ops.backup` 定时任务在本机既不注册（还要 `DB_BACKUP_STORE_SECRET_ID/KEY/BUCKET/REGION` 四个都配好，`backupConfigured()` + `schedules.ts:74`）也跑不动。搬上生产要么装真正的 PostgreSQL 客户端并配好对象存储，要么继续用"停库整目录复制 `.pgdata`"（做法与恢复见 `docs/geohot-runbook.md` 第 9.1 节）。反馈截图不进备份（`backup.ts:90`）。
7. **人工投递要不要开。** 野外与考察那 8 个 `external` 源靠 `POST /api/ingest/items`。本机 `.env` 里 `INGEST_TOKEN` 已经有值（`npm run env:init` 生成 48 位十六进制随机串），接口是通的（第 5 节与 `scripts/README-ingest.md` 有实测）；生产要换成一枚真正的密钥，并且把对应源从 `isolated` 改成 `editorial`，否则投进来的条目会因 `participation_mode=isolated` 被写成 `withdrawn`、任何公开出口都看不到。用不上这个入口就把 `INGEST_TOKEN=` 留空——留空等于永久 401，比留一枚弱值安全。
8. **门槛与校准。** 第 7 节第 3 条那句话（现值由 `industry/selection.ts` 给出、是**推出来的而不是校准出来的**）在上线前必须是"已用人工标注的 gold 集重跑过 `scripts/eval-selection.ts`"或者"被本人明确接受"的状态；同时确认第 6 节那条"门槛拦不住 92–93 分噪声、承重层是预筛 BLOCK"是本人事实。
9. **清理与提交。** 12 张 `*_bak_20260930` 表确认不再需要后 `DROP TABLE`；`.pgdata`、`.data`、`.env`、`.env.pipeline`、`.env.ports` 都必须在 `.gitignore` 里且不被提交（`.env.example` 与 `.env.pipeline.example` 两份模板是要提交的，`.gitignore` 里有对应的 `!` 例外）——**但 `.gitignore` 目前只兜住 `.env*` 这一族**：`prod.env`、`secrets.env`、`config/production.env`、`id_ed25519`、`server.pem` 五类路径 `git check-ignore -v` 实测**都不被忽略**（2026-10-03 复核），把这类文件放进仓库目录就等于赌手气，补规则的动作在 `docs/migration.md` 第 6 步；远端**已经配好了**（`git remote -v` → `origin https://github.com/xxc2007/GeoHot.git`，2026-10-03 实测），公开仓库的发布与逐字节验收走 `deploy/geohot/publish-to-github.sh` + `verify-github-sync.sh`（第 7 节第 11 条第 ③ 点），这一条以前写的"仓库里没有远端，上线前自己建一个备份远端"已经不成立。

---

## 11. 预检（每次动这个站之前先跑这一屏）

不是"觉得应该没问题"，是敲下去看输出。下面每一条都在两套环境各跑过一次：本机 live 栈（库 5433 / stub 3055 / api 3199 / web 3000）和本轮新做的一个干净克隆（`git clone` + `npm ci` + `npm run env:init -- --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065`，四组端口全在 spare 段，两套同时跑互不影响；克隆验完连 `.pgdata` 一起删掉了）。返回值抄在下面。

**1. 四个安全阀 + 两个 env 文件在不在。**

```bash
test -f .env && test -f .env.pipeline && echo "env 文件齐" || echo "缺 env 文件：跑 npm run env:init"
grep -E "^(COLLECT_ENABLED|MODEL_CALLS_ENABLED|FEISHU_CONTENT_PUSH_ENABLED|FEISHU_INTERNAL_ENABLED|INDEXNOW_SUBMIT_ENABLED|EMBEDDINGS_ENABLED)=" .env
#   期望 .env 里六个全是 false（测试继承 .env，在 .env 里开阀＝让测试去打外部服务）
grep -E "^(COLLECT_ENABLED|MODEL_CALLS_ENABLED|TZ|FETCH_SCHEDULE_BATCH)=" .env.pipeline
#   期望 COLLECT_ENABLED=true / MODEL_CALLS_ENABLED=true / TZ=Asia/Shanghai / FETCH_SCHEDULE_BATCH=1
grep -n DEV_AUTH .env .env.pipeline      # 期望：两个文件都没有输出
```

四个阀是 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_CONTENT_PUSH_ENABLED` + `FEISHU_INTERNAL_ENABLED`（两个飞书开关算一组外部推送）、`INDEXNOW_SUBMIT_ENABLED`；`EMBEDDINGS_ENABLED` 是第五个独立开关（没有 embedding key 时必须 false）。`.env` 里一律 false，只在叠 `.env.pipeline` 时开前两个。`TZ` 只有跑管道时才有意义但必须设：json_list 信源（地震台网、中央气象台）返回的是**不带时区**的时间串，`packages/backend/src/sources/json-list.ts:52` 按进程本地时区解释它——机器在 UTC 时区（Docker 镜像、CI、多数云主机）又没设 `TZ`，采集回来的 `published_at` 会整体差 8 小时，热度按错的时间衰减、该进今天的条目被算成昨天、08:00 出刊的日报日期跟着一起偏。

**2. `NODE_ENV` 与 `AIHOT_ENVIRONMENT` 是两个变量，只改一个等于没改。** 这是最容易骗过自己的陷阱：

| 谁读它 | 读哪个 | 后果 |
|---|---|---|
| `assertProductionSecrets`（`packages/backend/src/config.ts:127-137`） | **`NODE_ENV === "production"`** | 缺 `SESSION_SECRET`/`IMG_PROXY_SIGN_SECRET`、值 <8 位、命中占位正则（`changeme\|placeholder\|dummy\|test\|xxx+\|your…\|<…>`）、出现任何 `DEV_AUTH_*` 键、或 `ALLOW_PRIVATE_NETWORK_FETCH` 为真 → **拒绝启动**；api 还额外要求 `ADMIN_PASSWORD` ≥12 位或配了飞书登录（`apps/api/src/main.ts:11-13`） |
| `SITE_URL` 的回落闸门（`config.ts:54-68`） | **`NODE_ENV` 或 `AIHOT_ENVIRONMENT` 任一个为 `production`**（`config.ts:20`） | 生产下 `SITE_URL` 缺值或指向 `localhost`/`127.0.0.1`/`[::1]` → **拒绝启动**（开发下回落照旧，本机浏览不受影响）。拦的是"安静的错"：那个回落会把 localhost 写进 canonical、OpenGraph、RSS 的 `<link>`、sitemap 的 `<loc>`、robots 的 Sitemap 行与 security.txt，同时让 MCP 的 host 锁（`apps/api/src/routes/mcp.ts:219`）拒掉真域名 |
| 开发身份替身是否生效（`config.environmentName` → `packages/backend/src/admin/auth.ts:166`） | **`AIHOT_ENVIRONMENT`**（默认跟随 `NODE_ENV`） | 只要它不是 `production`，`.env` 里存在 `DEV_AUTH_ROLE` 就会发一个 `csrf:"dev"` 的免登录身份，后台所有写接口当场敞开 |

**只把 `AIHOT_ENVIRONMENT=production` 写进 env、`NODE_ENV` 还是 `development`，那道拒启闸门根本不会跑**；只改 `NODE_ENV=production` 时 `AIHOT_ENVIRONMENT` 的默认值会跟着变成 production，两道闸门才一起落下。所以生产配置要么两个都显式写 production，要么只写 `NODE_ENV` 并确认没有第二处把 `AIHOT_ENVIRONMENT` 设回 development。附带副作用：告警文案不再带部署名前缀；`SITE_URL` 换成 https 时会话 cookie 自动加 `Secure`（`apps/api/src/routes/admin-auth.ts:23`）。

**3. 证明后台确实锁着。** api 起在哪个端口就把 `<api>` 换成那个（本机 3199，克隆 3288），web 同理：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://<api>/api/admin/sources                   # 401
curl -sS http://<api>/api/admin/me                                                        # {"…","detail":"Sign in to the admin first."} [401]
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://<web>/admin               # 302 http://<web>/admin/login?return=%2Fadmin
curl -sS -o /dev/null -w '%{http_code}\n' http://<web>/admin/login                         # 200
# 用真存在、且需要鉴权的写路由。POST /api/admin/feedback/1 在本代码里没有处理器：它在鉴权之前
# 就命中兜底 404，因此无论后台锁没锁都回 404，证明不了任何事（2026-10-02 实测）。PATCH 这条无会话 401，
# 有会话但没有 CSRF 头时 403。
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH http://<api>/api/admin/feedback/1 \
  -H 'content-type: application/json' -d '{}'                                        # 401，绝不能是 2xx
PW=$(node -e "const fs=require('fs');const l=fs.readFileSync('.env','utf8').split(/\r?\n/).find(x=>x.startsWith('ADMIN_PASSWORD='));console.log(l.slice(15))")
curl -sS -c /tmp/jar -o /dev/null -w 'login=%{http_code}\n' -X POST http://<api>/api/auth/password \
  -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "password=$PW" --data-urlencode 'return=/admin'   # 303 + Set-Cookie: aihot_admin=…
curl -sS -b /tmp/jar -o /dev/null -w '%{http_code}\n' http://<api>/api/admin/sources        # 200（登录后才看得见）
```

干净克隆实测一行不差的返回值：`401` / `401 Sign in to the admin first.` / `302 → /admin/login?return=%2Fadmin` / `200` / `303` / `200`。后台侧栏在 `me.dev` 为真时会挂一个"开发"角标（`apps/web/app/routes/admin/layout.tsx`），**登录后看见"开发"角标就说明有人又把 `DEV_AUTH_ROLE` 加回来了**——2026-09-30 摘除前的对照实测：无 cookie 时 `/api/admin/sources` 200、`/api/admin/monitor/events` 200、`/api/admin/me` 返回 `{"csrf":"dev","dev":true}`，而 `PATCH /api/admin/feedback/999999` 带 `x-csrf-token: dev` 会进业务处理器（404 而非 403）；摘除后同样四项变成 401 / 401 / 401 / 403。改完 env 必须**重启 api 与 worker**：`--env-file` 只在启动时读一次，本文件第 3.3 节那两条 `node --env-file=…` 不带 `--watch`（只有 `npm run dev:api` 带）。

**4. 数据库这一侧的两条硬检查。**

```bash
node --input-type=module -e "import p from 'postgres';const d=p(process.env.DATABASE_URL,{max:1});console.log((await d.unsafe('SHOW server_encoding'))[0],(await d.unsafe('SHOW lc_ctype'))[0],(await d.unsafe('SHOW icu_locale'))[0]);console.log('similarity:',(await d.unsafe(\"SELECT similarity('三角洲','河流三角洲') s\"))[0],'trgm:',JSON.stringify((await d.unsafe(\"SELECT show_trgm('三角洲') t\"))[0]));await d.end()"
#   期望 UTF8 + 中文可用的 ctype + zh-CN-x-icu，且 similarity('三角洲','河流三角洲') 明显大于 0。
#   lc_ctype=C 时它恒为 0、show_trgm 返回空，pg_trgm 的 GIN 索引永远匹配不到中文，
#   而搜索和相关检索不报错、只是永远为空——这就是第 3.6 节坑二，改参数要重建集群。
node --input-type=module -e "import p from 'postgres';const d=p(process.env.DATABASE_URL,{max:1});console.log('migrations:',(await d.unsafe('SELECT count(*)::int c FROM schema_migrations'))[0].c);await d.end()"
```

跑测试前再确认库名以 `_test`/`_ci` 结尾（`tests/setup.ts:10` 会直接抛错拒绝，指错库会把主库写脏）；本机没有 `createdb`/`psql`，建库用第 8 节那条 `CREATE DATABASE`。

**5. 端口没撞。** 起 api 前先看一眼：`netstat -ano | grep LISTENING | grep -E ":300[01]|:31[0-9][0-9]|:543[0-9]"`。撞了别改代码，按第 3.7 节换一组端口重来（本轮就撞过一次：3299 已经被另一个 api 实例占着，`EADDRINUSE` 之后换 3288）。

**6. 全站回归。** `npm run typecheck`（六个工程，无输出即通过）与 `node scripts/smoke.ts --base http://localhost:3000`（只读，覆盖页面 + RSS + OpenAPI + `llms.txt` + 分享图 + MCP 握手）。本轮改完文档之后本机实跑的真实输出记在第 8 节末尾。

