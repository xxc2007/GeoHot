# 可部署性审计 · 2026-11-21

> **问题**：「任何人从 GitHub 克隆这个仓库，能不能自己把它在本地跑起来，并且能迁到新域名/新服务器？」
> **结论**：文档层、脚本层、模板层三者的关键承重事实**互相对得上**（我逐条对着代码读过），但**「克隆 → `npm ci` → 起库 → 迁移 → 冒烟」这条链本轮一行都没有执行**（本次任务明确禁止 `npm ci` 与部署）。所以本文给出的是：哪些环节有代码级证据、哪些只有文档说法、哪些照抄文档会失败。缺口按「照抄会不会卡住」排序，不是按字数排序。

- 审计对象：`GEOHOT/`（`git remote` = `https://github.com/xxc2007/GeoHot.git`，HEAD `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3`，`gh repo view` 返回 `"visibility":"PUBLIC"`、`pushedAt 2026-11-20T17:51:44Z`——公开可克隆这一条成立）。
- 只读：未修改任何文件（本文件除外），未 `npm ci`、未构建、未起库、未部署。
- 范围：`README.md`、`docs/manual.md`、`deploy/geohot/README-deploy.md`、`.env.example`、`package.json`、`database/migrations/`、Node 版本、`BASE_PATH`、本地库启动、seed、smoke。

---

## 1. 本轮真正跑过的检查（命令与输出）

| # | 命令 | 输出 / 结论 |
|---|---|---|
| 1 | `node -v` / `npm -v` | `v24.19.0` / `11.17.0`（满足 `package.json:11` 的 `>=24.11`） |
| 2 | `npm config get engine-strict` | `false` —— `engines` 只是**警告**，不是闸门 |
| 3 | `ls database/migrations/*.sql \| wc -l` | **121**（README:139 要求现查这条，就是这个数） |
| 4 | 迁移编号连续性（`sed`+`awk` 逐号比对） | 最高 `0126`，缺口 `0012 / 0025 / 0035 / 0093 / 0094`；`git log --all --name-only -- database/migrations` 里这 5 个编号**从未出现过** |
| 5 | `git log --diff-filter=D --name-only -- database/migrations` | 只删过一个：`0061_gemini_budget.sql`（提交 `7c5ea877`，纯 `INSERT INTO budgets` 数据迁移） |
| 6 | `node -e "…sources.json…topics.json…"` | `sources 668 enabled 666`、`topics 43` —— 与 `docs/manual.md:280` 的「668 条…666 条 `enabled=true`」、`:271` 的「主题…当前 43」一致 |
| 7 | `wc -l tooling/corpus/curated-materials.jsonl` | **117**（manual §7.8 的说法成立） |
| 8 | 自写只读脚本：比对 7 个 `package.json` 与 `package-lock.json` 的 deps | `lockfile root deps match every workspace package.json`（`npm ci` 不会因 lock 漂移报 `EUSAGE`） |
| 9 | `node -e` 读 `package-lock.json` | `typescript 7.0.2`、`@types/node 26.6.3`、`embedded-postgres 17.10.0-beta.17` 全部 `resolved` 到 `registry.npmjs.org`；`@embedded-postgres/{windows-x64,linux-x64,darwin-*,…}` 都在锁里（`windows-x64` 带 `"os":["win32"]`、`optional:true`） |
| 10 | 临时文件探针：`node --env-file=t.env -e …`（`A=   # comment`） | `A ""`、`B "10"` —— **Node 24.19 会剥掉行尾注释**，`.env.example` 里 `API_HOST=   # 生产…` 这类行不会把注释当值 |
| 11 | `grep -c $'\r' .env.example` + `cat .gitattributes` | `0` 个 CR；`.gitattributes` 是 `* text=auto eol=lf` → 任何平台克隆都是 LF，`init-env.ts` 的 `^ADMIN_PASSWORD=$` 精确匹配不会失效 |
| 12 | `git ls-files .env.example .env.pipeline.example` | 两份模板**都在**版本控制里（`.gitignore:5-8` 只排除真实 `.env*`） |
| 13 | `git grep -nI "D:\\地理热点\|C:\\Users\|D:/地理热点"` | 0 命中 —— 没有本机绝对路径被提交 |
| 14 | `node -e` 统计 `scripts/smoke.ts` 两张表 | `PAGES 17` + `MACHINE 18`，与 manual §3.3 的「17 + 18」一致 |
| 15 | `node -e` 解析 `receipts.ts` 与迁移里的 `budgets` 行 | 注册表 20 个 `service` 全部有预算行（`raccoon/codearts/qoder-global` 在 `0097`，`workbuddy-ai` 在 `0076`，其余在 `0098`） |
| 16 | `docker --version` / `docker compose version` | `command not found` —— 容器路线本轮**无法验证** |
| 17 | `git status --short` | 唯一未跟踪项是 `?? docs/history/`（`git ls-files docs/history` 为空） |

---

## 2. 逐条核对（按任务点名的八项）

| 项 | 依据 | 状态 |
|---|---|---|
| **Node 版本** | `package.json:11` `>=24.11`；`README.md:120`「Node.js 24.11 或更高」；`docs/manual.md:41` 同、并记本机 `v24.19.0`；`Dockerfile:3` `node:24-trixie-slim`；`.github/workflows/check.yml:42,85` `node-version: 24`；`deploy/geohot/bootstrap-server.sh:80` `NODE_MIN="24.11"`（:300-304 只检查、不代装）。**本地实测 v24.19.0 通过。** 但无 `.nvmrc`/`.node-version`，`engine-strict=false`（第 2 条实测）→ 版本约束只靠文档与 bootstrap 脚本 | 文档一致；**执行未验证**（没有在 24.11 以下的机器上跑过） |
| **依赖安装** | 锁文件与所有 workspace 的 `package.json` 一致（第 8 条）；CI 的 `Install` 步就是 `npm ci --no-audit --no-fund`（`check.yml:45-46`） | 静态通过；`npm ci` 本轮**未跑**（按任务约束） |
| **env 模板与生成** | `.env.example`/`.env.pipeline.example` 已跟踪（第 12 条）；5 个空键在 `:40,45,51,54,267`，与 `scripts/init-env.ts:70-75` 的 `^KEY=$` 一一对应；`init-env.ts:43-47` 拒绝覆盖；`:77-93` 把端口写进 `DATABASE_URL/API_PORT/API_BASE_URL/WEB_PORT/SITE_URL/BRAIN_PORT/LLM_BASE_URL`；LF 保证（第 11 条）；行尾注释不会污染值（第 10 条） | 静态通过；`npm run env:init` 本轮**未跑** |
| **`database/migrations` 数量** | 121 个文件（第 3 条），编号到 `0126` 且不连续（第 4 条）；`scripts/migrate.ts:25` 按**文件名**排序应用、`:21` 用 `schema_migrations(name)` 去重、`:13-19` 没有 `DATABASE_URL` 时**拒绝运行** | 计数已实测；迁移执行**未跑**（需库） |
| **本地 DB 启动** | `scripts/dev-db.ts`：`:65-67` 用户/口令/库 `geohot/geohot/geohot` 与 `.env.example:58` 的 `DATABASE_URL` 一致；`:236` `--locale-provider=icu --icu-locale=zh-CN --encoding=UTF8`（对应 manual §3.6「坑二」）；`:238-248` `embedded-postgres` 17、`scram-sha-256`、持久化 `.pgdata`；`resolvePort()` 只认 `--port`/`DEV_DB_PORT`（README:136-138 的警告属实）；`db:down` → `scripts/dev-db-down.ts` | 静态通过；`npm run db:up` 本轮**未跑**，且 **CI 完全不覆盖它**（见缺口 D2） |
| **seed** | `scripts/seed.ts:34` 先 `seedTopics()`，`:40` 读 `industry/sources.json`、`ON CONFLICT DO NOTHING`（`:57`）；语料走 `npm run seed:curated`（`tooling/corpus/*.jsonl` 117 行，第 7 条） | 静态通过；**未跑** |
| **`BASE_PATH` 构建** | `apps/web/vite.config.ts:17-26`（`base`）、`apps/web/react-router.config.ts:6-15`（`basename`）、`apps/web/app/lib/public-path.ts` 三处都读**构建期** `process.env.BASE_PATH`；`bootstrap-server.sh:70-71` 归一化 `GEOHOT_BASE_PATH`、`:740,744` 以 `BASE_PATH=…` 构建、`:564-565` 校验 `SITE_URL` 路径与前缀一致；`Dockerfile:22` **不带** `BASE_PATH`（= 容器路线只能域名根，`docs/deploy.md` 已明写） | 静态通过；构建**未跑** |
| **smoke** | `scripts/smoke.ts` 17 页 + 18 机读 + MCP 握手 + 2 条跨出口不变量（第 14 条）；`:90` 起的前缀校验块在 `--base` 无路径时整体跳过 → 本地根部署形态可以直接跑；`package.json:31` `smoke` 别名存在，README:145 用的就是它 | 静态通过；**未跑**（需要 api+web+已构建的 web） |

---

## 3. 缺口清单（照抄会不会卡住，按影响排序）

### D1 · 高 · Docker 一图流照抄跑不通（`docker-compose.yml` 头注释 + `docs/deploy.md` 的命令块）

- **现象**：`docker-compose.yml:1` 写着 `# docker compose up -d --build → http://localhost:3000`；`docs/deploy.md` 的「用 Docker（推荐）」给的是 `git clone` → `npm run env:init` → `docker compose up -d --build` 三条。
- **为什么不够**（三条同时成立）：
  1. `docker-compose.yml:8` `env_file: .env` —— 干净克隆没有 `.env`，compose 直接在解析阶段失败；
  2. `docker-compose.yml:11` 写死 `NODE_ENV: production`，`:16` 要求 `SITE_URL: ${SITE_URL:?…}` 非空，而 `npm run env:init` 写出的正是 `SITE_URL=http://localhost:3000`（`.env.example:34`）；
  3. `packages/backend/src/config.ts:121` 在 production 下对 localhost 直接 `Refusing to start in production: SITE_URL …` → **api 起不来**，首页 200 但 `/api/health` 全红。
- **证据**：仓库自己的 CI 就是证据 —— `.github/workflows/check.yml:87-101` 在 `init-env` 之后**必须**用 `parseEnv` 重写整个 `.env` 并把 `SITE_URL` 改成 `http://web:3000` 才敢 `docker compose up`；这一步**没有写进任何文档**。CI 注释还写着「Compose treats some empty-value/comment combinations differently」——即 `.env.example` 的行尾注释在 Compose 那边未必和 Node 一样安全（第 10 条只证明了 **Node** 会剥注释）。
- **最小修复**：在 `docs/deploy.md` 那三条命令中间插一步「把 `.env` 的 `SITE_URL` 改成读者实际访问的地址（不能是 localhost）」，并把 CI 里那段 `parseEnv` 归一化写成文档里的一行脚本；`docker-compose.yml:1-2` 的头注释补一句前置条件。
- **不修也可以的理由**：正文已经用大段文字解释了这一条（`docs/deploy.md`「env:init 之后先别急着 up」段）。但**命令块本身仍是错的**，而命令块才是被复制的东西。

### D2 · 高 · 本地库启动是唯一「没有任何自动化覆盖」的环节

- **现象**：`npm run db:up`（`scripts/dev-db.ts`）是没有 Docker、没有系统 PostgreSQL 的机器上**唯一**被文档化的起库方式（manual §3.1「不需要 Docker…所以下面用 embedded-postgres」）。
- **为什么不够**：
  - CI 的 linux job 用的是 `services: postgres:17-alpine`（`check.yml:21-29`，`image: postgres:17-alpine` 在 :23），**从不跑 `db:up`**；docker job 用容器里的 `db` 服务。也就是说 `dev-db.ts` 的跨平台行为在今天**零覆盖**；
  - `scripts/dev-db.ts:30-31` 把 `BUNDLE_DIR` 写死成 `node_modules/@embedded-postgres/windows-x64`，`PG_CTL` 由它派生并在 `reapBackends()`（`:274-283`）里被 spawn —— Linux/macOS 上这个包**根本不会被装**（锁文件里带 `"os":["win32"]`，第 9 条），所以那条「补一刀 `pg_ctl stop -m immediate`」只对 Windows 生效；`hideServerConsole()`（`:292-319`）同样只在 win32 生效；
  - `:236` 的 `--locale-provider=icu --icu-locale=zh-CN` 依赖打包的二进制带 ICU，这一条无法在本机之外验证。
- **最小修复**（二选一）：① 在 CI 加一个 ubuntu job：`node scripts/dev-db.ts --daemon --port=5455` → `DATABASE_URL=…:5455/geohot npm run db:migrate`，跑通即证明 Linux 可用；② 若不打算支持，就在 README「本地运行」开头写明「`db:up` 只在 Windows 上验证过；Linux/macOS 请用系统 PostgreSQL 或 `docker compose`」。
- **备注**：本条不是「已知会坏」，是「已知没测」。本轮**没有**在非 Windows 上执行过任何命令。

### D3 · 中 · `dev-db.ts` 的二进制 shim 失败时抛原始堆栈，不是人话

- **现象**：`ensureAsciiBinaries()` 在模块顶层调用（`scripts/dev-db.ts:149`），而友好错误处理（`dev-db: failed to start — …`）在 `:337-368` 的 `try` 里。`:96-123` 内的三类失败（找不到 bundle、`mkdirSync` 无权限、junction 不解析）都会以未捕获异常的形式冒到终端。
- **为什么不够**：这条路径恰好是**中文路径 + Windows** 用户第一次 `npm run db:up` 最可能踩的（目录名 `D:\geohot-embedded-postgres` 由 `:33` 的 `path.parse(ROOT).root` 决定，即**盘符根目录**）。本机 `fs.accessSync('C:/')`/`('D:/')` 都是可写（实测），所以这台机器上没有暴露；换一台受限账户就会以 `EPERM` 收场，而提示里没有一个字指向「换盘符 / 换路径 / 用系统 PostgreSQL」。
- **最小修复**：把 `:149` 的一次调用挪进 `try`，或在 `:96-123` 内 catch 后 `console.error` 一句「二进制镜像到 `<shim>` 失败（<code>）：把仓库放到可写的非系统盘，或改用系统 PostgreSQL」。

### D4 · 中 · 手册说 `npm test` 会继承 `.env` —— 实际不会

- **证据**：`package.json:30` 是 `node --test --test-concurrency=1 --test-timeout=120000 "tests/*.test.ts" "scripts/*.test.ts"`，**没有 `--env-file`**；`.env.example:82-84` 自己写着「`npm test` 就是 `node --test`，不带 `--env-file`，所以它读不到这里的任何阀」。
- **与文档冲突**：`docs/manual.md:135`「`npm test` 会继承 `.env`：一旦在这里打开 `COLLECT_ENABLED`，测试就可能真的去访问外部服务」；`:481`「测试继承 `.env`，在 `.env` 里开阀＝让测试去打外部服务」。
- **为什么不够**：手册被声明为「操作口径以它为准」（`docs/manual.md:4`）。按它理解，人会把「测试不上外网」的保证记在 `.env` 的阀门上；真实机制是「没有测试注册 schedules + 需要模型的测试自己指向本地 stub」（`.env.example:82-84`、`packages/backend/src/config.ts:76-78` 的注释）。这是**安全阀的归属**记错了位置，不是措辞问题。
- **最小修复**：改 manual 两处，改成 `.env.example:82-84` 那段口径。

### D5 · 中 · `contactEmail` 已经填了，手册仍说 `null`

- **证据**：`industry/site.ts:38` 是 `contactEmail: "xxc200707@qq.com"`（`:36` 注释：「站主已填真实 QQ 邮箱」）。
- **与文档冲突**：`docs/manual.md:352`（§7.7「`contactEmail` 现在是 `null`…`/.well-known/security.txt` 因此按设计返回 404」）、`:456`（§10 开头「`contactEmail` 是 `null`」）、`:463`（§10.4「现在是 `null`，不是占位地址」）。
- **为什么不够**：§10 是「上线前必须做的事」。照它做的人会去填一个已经填好的字段，而**真正的风险没人提**：一旦部署，`/.well-known/security.txt` 会写 `Contact: mailto:xxc200707@qq.com`（`apps/api/src/routes/static.ts:185-188`）、`llms.txt` 会多一行「联系：…」（`packages/backend/src/publication/llms.ts:97`）——**这个个人邮箱会公开**。
- **最小修复**：三处同步改成现值，并补一句「上线即公开该地址，不想公开就留 `null`」。

### D6 · 中 · 部署包内部对「起几个 unit」自相矛盾

- **证据**：`deploy/geohot/README-deploy.md:35-36`「⑧ 启动四个 unit（brain/api/worker/web）」；同文件 `:205-208`「⑧ 六个常驻单元，顺序 brain→api→worker→web，再补两条 workbuddy 桥」；`:208` 又写「第 2 节断言**四个核心单元** active，另按『装了才要求』断言两条桥」。
- **为什么不够**：§0-1 与 §5 说明生产 `MODEL_POOL` 八路成员里有 `workbuddy-*`，这些成员**只能**经 `geohot-workbuddy.service`/`geohot-workbuddy-cn.service`（`deploy/geohot/systemd/` 里确实有）到达。只按 §2 起四个 unit，站能开、但那一半判定门是 `connect ECONNREFUSED`（§7 故障表最后一条写的就是这个形态）。
- **最小修复**：§2 的 ⑧ 改成「四个核心 unit + 按 `MODEL_POOL` 是否含 `workbuddy-*`/`workbuddy-cn-*` 决定是否起两条桥」，与 §8 对齐。

### D7 · 中 · `.env.example` 里两个「代码不读」的键仍以生效开关的样子出现

- **证据**：`:437-443` 明确写「`IMG_PROXY_REQUIRE_SIG`、`FEISHU_PUSH_ENABLED`… 代码却不读」，并且把这两个键注释掉；但同一文件 `:450-451` 又有**未注释**的 `IMG_PROXY_REQUIRE_SIG=`（注释说明「1 时图片代理必须带签名」）和 `FEISHU_PUSH_ENABLED=`（「第三个开关」）。`grep -rn` 全部 `.ts/.tsx` 对这两个键 **0 读点**（另一处 `:49` 也写着「旧版这里写的 `IMG_PROXY_REQUIRE_SIG=false` 是个死开关…已删掉」）。
- **为什么不够**：部署者按 450-451 填值会以为打开了签名强校验或飞书推送；实际什么都没发生，而「图片代理恒验」（`:48-49`）是另一套逻辑。
- **最小修复**：删掉 `:450-451` 两行，或改成注释并标「死键，保留仅为键名对齐」。

### D8 · 低 · README 把「前缀由谁决定」说反了一半

- **证据**：`README.md:176`「本地构建是**域名根**形态：没有 `BASE_PATH`，线上 `/geohot` 前缀由反代与 web 层决定」。
- **为什么不够**：前缀是**构建期**烧进 bundle 的（`apps/web/vite.config.ts:17-26`、`apps/web/react-router.config.ts:6-15`；`deploy/geohot/README-deploy.md:17`「前缀是**构建期**变量」）。「由反代决定」会让人以为运行时改 nginx 就能挂前缀，而那样只会得到 `ERR`/404（`docs/deploy.md`「Docker 这条路是域名根部署」一节讲的就是这个）。
- **最小修复**：一句改成「前缀是构建期变量（`BASE_PATH`）；本地默认构建是域名根形态」。

### D9 · 低 · 迁移编号不连续，且有一个编号被复用

- **证据**：121 个文件、最高 `0126`、缺口 `0012/0025/0035/0093/0094`（第 4 条，历史里从未出现）；`0061_gemini_budget.sql` 被删（第 5 条）后，编号 0061 给了新的 `0061_workbuddy_day_headroom.sql`（`ON CONFLICT … DO UPDATE … WHERE budgets.per_day = 6000`，可重放）。
- **为什么不够**：`migrate.ts:25` 以**文件名**为键，所以干净克隆是自洽的；受影响的是**已有库**——它的 `schema_migrations` 里有 `0061_gemini_budget.sql`、没有新 0061，下次 `db:migrate` 会在 `0126` 之后补跑新 0061（本次是安全的，因为带 `WHERE` 守卫）。真正的代价是「第 N 条迁移」**不是稳定标识**：任何脚本、演练记录、恢复清单都不能按序号引用。
- **最小修复**：无需改代码；若在意，可在 `database/migrations/` 加一份 5 行 README：「编号可复用、幂等、以文件名为准，条数请 `ls *.sql | wc -l`」。

### D10 · 低 · README 的本地命令块假设 POSIX shell，但没说

- **证据**：`README.md:127` `mv .env .env.bak 2>/dev/null; …`、`:139` `ls … | wc -l`、`:153` `%TEMP%/…`。项目主力机是 Windows（`docs/manual.md:42`「Git Bash」），而 README 的「本地运行与二次开发」块里一个字都没说 shell。
- **最小修复**：命令块前加一句「以下命令在 Git Bash（Windows）/ bash（macOS、Linux）里执行；PowerShell 请换成 `Move-Item` 等价写法」。

### D11 · 信息 · 这份审计本身不在克隆里

- `git status` 只有 `?? docs/history/`，`git ls-files docs/history` 为空 —— 整个 `docs/history/` 目录（含本文件与 `ERA-0*.md`）**未被跟踪**。想让克隆的人看到它，必须提交；否则它只存在于这台机器。

---

## 4. 必须由站点所有者本人提供的（代码里能填的全是占位/本机值）

| 项 | 为什么不能由代码或审计代填 | 依据 |
|---|---|---|
| **域名 / 是否挂子路径** | `SITE_URL` 的取值与路径必须等于构建期前缀；生产下缺值或 localhost **拒启** | `packages/backend/src/config.ts:111-121`；`bootstrap-server.sh:564-565` 会断言两者一致 |
| **TLS 证书 / 反代方式** | Caddy profile 要域名；nginx 路线要 `server_name` + `:80`/`:443` 两个 vhost 同时改 | `docker-compose.yml:86-98`；`deploy/geohot/README-deploy.md:229-236` |
| **五枚密钥** | `env:init` 能生成，但**生产必须重发**（搬家是唯一正当的换密钥理由）：`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`ADMIN_PASSWORD`(≥12)、`INGEST_TOKEN`(≥16)、数据库角色口令 | `deploy/geohot/README-deploy.md:238-248`；`scripts/init-env.ts:65-75` |
| **模型凭据** | 本机有 `tooling/brain-stub.ts` 顶替（`LLM_API_KEY=local-brain` 是占位，代码拦不住它，`README-deploy.md:93` 要求人工核）；生产要么接真模型、要么显式 `MODEL_CALLS_ENABLED=false`（后果：新料一条都不公开） | `docs/manual.md:228-236`；`docs/deploy.md`「模型」段 |
| **ICP 备案号** | 只能主办者申请；现为空串 → 页面不显示 | `industry/site.ts:50` |
| **`contactEmail` 是否公开** | 现值是个人 QQ 邮箱（`industry/site.ts:38`），上线即进 `security.txt`/`llms.txt` | 见 D5 |
| **条款 / 隐私页措辞** | 仍是模板口径（`industry/pages/terms.md` 版本 2.0.40、备案号「待站长申请后填写」） | `docs/manual.md:456` |
| **备份目的地** | 应用内 `ops.backup` 要 `pg_dump` 二进制 + `DB_BACKUP_STORE_*` 四项；否则走 cron + 离开本机的一份 | `deploy/geohot/README-deploy.md:97-110`；`docs/manual.md:465` |
| **可选外部服务** | 飞书两阀、`INDEXNOW_KEY`、`SOCIALDATA_API_KEY`、`DAJIALA_KEY`、`WORKBUDDY_*` 凭据 —— 全部默认关/不配 | `.env.example:90-98, 426-451` |

---

## 5. 本轮**没有**执行的东西（不要把它们当成已通过）

1. `npm ci`（任务禁止）——只用第 8 条的锁/包比对代替；
2. `npm run env:init`（会写文件）——只读核对了正则与模板；
3. `npm run db:up` / `db:migrate` / `seed.ts` / `seed:curated` / `npm run build -w @aihot/web` / `npm run smoke` / `npm run typecheck` / `npm test`；
4. `docker compose up`（本机 `docker` 不存在，第 16 条）；
5. 任何跨平台验证（Linux/macOS 上的 `dev-db.ts`）——所以 D2 是「未测」而不是「已坏」；
6. 迁移实际应用（`migrate.ts:37-41` 说干净库会顺带 upsert 47 条价卡，本轮**未核对**这个数）。

---

## 6. 下一个人照着跑就能收口的命令（建议顺序）

```bash
# 0) 干净目录克隆（不要复用本机 GEOHOT/node_modules 与 .pgdata）
git clone https://github.com/xxc2007/GeoHot.git geohot-audit && cd geohot-audit
node -v                                   # 期望 >= 24.11
npm ci                                    # 期望 exit 0
mv .env .env.bak 2>/dev/null; mv .env.pipeline .env.pipeline.bak 2>/dev/null
npm run env:init -- --db-port=5455 --api-port=3299 --web-port=3099 --brain-port=3065
grep -c '^ADMIN_PASSWORD=.\+' .env        # 期望 1（=1 说明随机密码真的落盘了，不是空值）
npm run db:up -- --foreground --port=5455 # 长驻；另一终端继续
npm run db:migrate                        # 期望 "121 migration(s) applied"
node --env-file-if-exists=.env scripts/seed.ts          # 期望 topics 43 / sources 668 级
npm run seed:curated -- --dry-run --enforce-source      # 期望 117 material line(s)
node --env-file=.env --env-file=.env.pipeline tooling/brain-stub.ts    # 3065
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts     # 3299
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts
npm run build -w @aihot/web && node --env-file=.env apps/web/server.ts # 3099
npm run smoke -- --base http://127.0.0.1:3099                          # 期望全 ✓，不带前缀
# 测试库（库名必须 _test/_ci）
node --input-type=module -e "import postgres from 'postgres'; const s=postgres('postgres://geohot:geohot@127.0.0.1:5455/postgres'); await s.unsafe('CREATE DATABASE geohot_test'); await s.end();"
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5455/geohot_test npm run db:migrate
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5455/geohot_test npm test
# 子路径形态（要验 /geohot 就一定带 BASE_PATH 重建，且 SITE_URL 带同一前缀）
BASE_PATH=/geohot npm run build -w @aihot/web
```

> 这套命令与 `README.md:122-146`、`docs/manual.md:47-70` 一致；差别只有两处：把「迁移条数」写成期望值 **121**（今天是这个数，README 故意不写死，以 `ls database/migrations/*.sql | wc -l` 为准），以及补了 `grep -c '^ADMIN_PASSWORD=.\+'` 这一条断言——它专门证明 D1/D4 之外最容易静默失败的一步：模板替换没匹配上时 `.env` 里是空密码，站起得来但 `/admin` 永远进不去。

---

## 7. 一句话总结

**文档写得很细，但细的是「已经踩过的坑」，不是「没装过的机器」。** 静态层（模板、脚本、锁文件、迁移计数、Node 版本、`BASE_PATH`）自洽且可核对；真正没有证据的是**执行**：`npm ci`、`dev-db.ts` 的跨平台行为、Docker 一图流。前两个是本轮任务明确禁止执行的，第三个是本机没有 Docker。**上述 D1、D4、D5、D6 是「照抄文档会做错事」的四条，改动量都在一句到十行之间，建议在任何人拿到这个仓库之前修掉。**
