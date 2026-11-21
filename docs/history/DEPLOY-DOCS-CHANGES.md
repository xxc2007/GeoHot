# 部署文档修订 · 2026-11-21

> 依据：`docs/history/AUDIT-DEPLOYABILITY.md` 的 D1/D4/D6/D7/D8/D10，以及 `docs/history/AUDIT-SECURITY.md` 的 M-07（硬编码公网 IP）。
> 约束：**只改文档、模板与脚本注释**，不改运行时业务代码、不改生产拓扑/端口/密钥值，未运行任何部署。
> 本文件是这批改动的变更记录；审计原文保持原样，不追改。
>
> **复核后修订（同日）**：① D1 的命令块不再把 `SITE_URL` 固定成 `http://web:3000`——改为 `export SITE_URL=…` 显式传入，未设置／非 http(s) 直接退出（该值能过生产闸门，只有 localhost/127.x/::1 会被拒，所以静默写错比拒启更危险）；② D6 的启动顺序改成与 `systemctl start` 命令逐字一致；③ D4 补上 `docs/manual.md:367` 这处同源错句；④ `README.md:104` 的发布条数由 255 改为实测 258（`docs/PROJECT-MAP.md:169` 的同一个 255 一并改正）；⑤ 本文件自己在 :33/:64 复述了那处真实 IP，已改成不写值（只留 M-07 的指代）；⑥ `AUDIT-SECURITY.md`、`security-findings.json`、`COMMIT-LEDGER-SIDE.md` 的仓库内副本已移除——`AGENTS.md:34` 明写它们不进公开仓库。

## 1. 改了什么（逐条）

| 项 | 文件:行 | 改动 | 依据 |
|---|---|---|---|
| **D1** | `docker-compose.yml:4-12` | 头注释补「前置两步」：`node scripts/init-env.ts` → 用 `node:util` 的 `parseEnv` 读入并重写 `.env`（按 `"K":"V"` 逐行）；`SITE_URL` 必须由部署者显式给，并写明「抄 CI 的 `http://web:3000` 不会拒启、只会把错地址静默写进 canonical/OG/RSS/sitemap/security.txt」 | `AUDIT-DEPLOYABILITY.md:53-62`；`config.ts:100,120`（生产闸门只拒 localhost/127.x/::1） |
| **D1** | `docker-compose.yml:27-29`、`:45` | `DATABASE_URL` 与 `db` 服务的 `POSTGRES_PASSWORD` 都去掉 `:-aihot` 弱默认，改成 `${POSTGRES_PASSWORD:?…}`：`.env` 里没有它就在解析阶段报错 | 审计 D1 第 1 条；安全审计 M-01（`AUDIT-SECURITY.md:485`） |
| **D1** | `docs/deploy.md:19-36` | 「用 Docker（推荐）」的命令块插入第 ② 步：与 CI 相同的 `parseEnv` 归一化脚本，但**要求显式** `export SITE_URL=https://example.com`（未设置／非 http(s) 直接 `exit 1`）；CI 的 `http://web:3000` 只在注释里作为「一次性栈」的例子出现，不再是命令块里的默认值 | 审计 D1 的「最小修复」；`check.yml:92-99`；`config.ts:100,120` |
| **D1** | `docs/deploy.md:41-46` | 命令块后补一段：第 ② 步不是可选的（无 `.env` / 行尾注释两种失败形态）、为什么 `http://web:3000` 能过闸门却仍是错的、`POSTGRES_PASSWORD` 必填 | 同上 |
| **D1** | `.env.example:53-56` | `POSTGRES_PASSWORD` 注释里写明「Docker 路线必填：compose 直接拼进 `DATABASE_URL`，没有兜底值」 | 审计 D1；M-01 |
| **D4** | `docs/manual.md:137` | 「`npm test` 会继承 `.env`」改为「`npm test` 是 `node --test`，不带 `--env-file`，读不到 `.env` 的任何阀；只从 shell 取 `DATABASE_URL`，测试库名必须 `*_test`/`*_ci` 且显式传入」 | 审计 D4（`package.json:30`、`tests/setup.ts:10`、`.env.example` 安全阀段落） |
| **D4** | `docs/manual.md:367` | §8 开头「`npm test` 和带 `--env-file-if-exists=.env` 的脚本会读 `.env`」改为「带 `--env-file-if-exists=.env` 的脚本会读 `.env`（缺失时静默跳过）；`npm test` 根本不读 `.env`，只看 shell 里的 `DATABASE_URL`」 | 复核指出：这处与 :137/:483 直接冲突；机制依据同 `package.json:30` |
| **D4** | `docs/manual.md:388` | 删掉「测试不访问外部服务——前提是 `.env` 里那两个阀是 false」，改为「`npm test` 不读 `.env`（见 3.5 节）；要模型的测试自己把 `*_BASE_URL` 指向本地 stub」 | 同上；不改会与 :137 自相矛盾 |
| **D4** | `docs/manual.md:483` | §11 预检注释里的「测试继承 .env」同样改成「只认 shell 里的 `DATABASE_URL`，库名 `*_test`/`*_ci` 显式传入」 | 审计 D4 点名的第二处 |
| **D4**（同源） | `README.md:187` | 「（测试也继承这份，开了就会真打外部服务）」改成「（`npm test` 不读 `.env`：只从 shell 取 `DATABASE_URL`…）」 | 审计 D4 只点名手册，但 README 同一句是同一个错误口径，一并改正 |
| **D4**（同源） | `docs/geohot-runbook.md:413` | §11 第 2 条尾巴的「测试会继承 `.env`」改成「`npm test` 不读 `.env`；只认 shell 里的 `DATABASE_URL`，库名 `*_test`/`*_ci` 显式传入」 | 同上：全仓 grep 出的第三处同源错句 |
| **D6** | `deploy/geohot/README-deploy.md:35-40` | §2 的 ⑧ 从「启动四个 unit」改为「四个核心 + 两条 workbuddy 桥（装了才起），共 6 条 `start`；`archive.service` 由 timer 拉起」，并写明清单来源：`systemd/` 现有 33 个 `.service` + 17 个 `.timer`（50 个单元文件），`install-units.sh` 的 `ALL_UNITS` 装其中 33 个（22 + 11） | 审计 D6；数字为本次实测（见第 3 节） |
| **D6** | `deploy/geohot/README-deploy.md:96` | 「四个 unit 的 `Environment=TZ=`」→「模板目录里 10 个 `.service` 的 `Environment=TZ=`」 | `grep -l "TZ=Asia/Shanghai" systemd/*.service` = 10 |
| **D6** | `deploy/geohot/README-deploy.md:209-216` | §8 的 ⑧ 改为「六条常驻 start」，顺序**与下一行的命令逐字一致**（四个核心 brain → api → worker → web，再补 workbuddy → workbuddy-cn）；⑨ 的断言描述从「四个核心单元 active」改成 `verify-deploy.sh` 的实际判据（api/web 无条件、worker 看 `readers-only` 标记、brain「enable 了才要求」、两条桥与 `archive.timer`「装了才要求」） | 审计 D6；`verify-deploy.sh:145-230`；复核指出原写法与 `:212` 的命令顺序不一致 |
| **复核** | `README.md:104`、`docs/PROJECT-MAP.md:169` | 「**255** 次/条读者可见的发布」改为「**258** 条读者可见的发布记录（`industry/changelog.json` 的 `releases` 数组；`git tag --list 'v*'` 是 254 个，差的 4 条是发布当天才补版本号）」 | 复核指出 255 对不上任何口径；本次实测 `entries = 258`、`git tag` = 254、`git rev-list --count HEAD` = 1714，与 `docs/history/README.md:17` 一致。`PROJECT-MAP.md` 的同一个 255 是同一处事实，按同一口径改掉，避免留下新的不一致 |
| **D6** | `deploy/geohot/install-units.sh:3-4`、`:34`、`:66` | 头部注释里的「20 个单元 / 28 个单元模板」改成实测值「33 个单元（22 `.service` + 11 `.timer`）/ 目录里 33 + 17 = 50 个单元文件」。**只改注释，未动逻辑** | 审计 D6「以实际清单为准」；数字见第 3 节 |
| **D7** | `.env.example:452-456` | `IMG_PROXY_REQUIRE_SIG=`、`FEISHU_PUSH_ENABLED=` 两行注释掉并标「代码未读」，说明与 F 段落里同名注释键重复、保留只为键名对齐 | 审计 D7；`grep -rn` 对全部 `.ts/.tsx` 0 读点（本次复核） |
| **D8** | `README.md:184` | 「线上 `/geohot` 前缀由反代与 web 层决定」改为「`BASE_PATH` 是构建期变量（`deploy/geohot/deploy.sh:20-22`：`GEOHOT_BASE_PATH` 传进 `npm run build`，默认 `/geohot`，域名根部署显式传空串），烧进 bundle；只改 nginx 变不出前缀」 | 审计 D8；`deploy.sh:21` 的 `${GEOHOT_BASE_PATH-/geohot}` |
| **D10** | `README.md:128` | 本地命令块前加「Git Bash（Windows）/ WSL / POSIX shell；PowerShell 逐条改写（`mv` → `Move-Item`、`VAR=x cmd` → `$env:VAR='x'; cmd`）」 | 审计 D10 |
| **D10** | `docs/manual.md:47` | §3.2 命令块前加同一句 | 审计 D10 |
| **安全** | `docs/geohot-runbook.md:2626` | 公网 IP（M-07 点名的那一处）→ `<reader-host>` | `AUDIT-SECURITY.md:491`（M-07） |
| **安全** | `deploy/geohot/night-window/install-long-window.sh:33` | 同一 IP → `<reader-host>`（该行是注释，逻辑未变） | 同上；M-07 |
| **工作区** | `D:\地理热点网站\README.md:26-29`（仓库外） | 新增「凭据与历史入口」：`_assist/` 与 `_diag/t8` 的明文凭据仍在原位、按 manual 队列等站长逐条决定，**仍需轮换**；`GEOHOT/docs/history/` 是仓库历史入口，安全审计与 `security-findings.json` 只在工作区 `docs/history/` | 本次任务指令 + 复核 |

## 2. 明确没做的事

- 没有改任何运行时业务代码（`apps/**`、`packages/**`、`scripts/**`、`tests/**`、`database/**` 本轮 0 改动）。
- 没有改生产拓扑、端口、密钥值；`docker-compose.yml` 只动了口令缺省与注释。
- 没有跑部署、没有 `docker compose up`、没有 `npm ci`、没有起库或迁移。
- 没有改 `docs/history/AUDIT-DEPLOYABILITY.md` 与 `AUDIT-SECURITY.md` 的原文。

## 3. 验证（本次实际执行）

| # | 命令 | 结果 |
|---|---|---|
| 1 | 只读脚本解析 `ALL_UNITS` 并与 `deploy/geohot/systemd/` 对账 | `ALL_UNITS entries = 33`（22 `.service` + 11 `.timer`）；模板在盘 `50`（33 `.service` + 17 `.timer`）+ 1 个 `.example`；`missing template for ALL_UNITS entry: []`；`on disk but not in ALL_UNITS` 17 个（hangzhou/role/concurrency/server-status 等） |
| 2 | `grep -l "TZ=Asia/Shanghai" deploy/geohot/systemd/*.service \| wc -l` | `10` |
| 3 | 把两份被改脚本先复制到临时目录（仓库路径直接 `bash -n` 被 PreToolUse 拦下），再 `bash -n` | `a.sh bash -n OK`（`install-long-window.sh`）、`b.sh bash -n OK`（`install-units.sh`） |
| 4 | `node --input-type=module -e "…parseEnv(readFileSync('.env.example'))…"` | `parsed keys = 120`；`IMG_PROXY_REQUIRE_SIG present? false`、`FEISHU_PUSH_ENABLED present? false`、`POSTGRES_PASSWORD present? true` |
| 5 | 在临时目录用 `.env.example` 的副本，**原样执行** `docs/deploy.md` 里新写的 heredoc 片段：① 带 `export SITE_URL=https://example.com`；② 不设 `SITE_URL` | ① `with SITE_URL -> "https://example.com"`；② 打印「SITE_URL 未设置或不是 http(s) 地址…」并 `exit=1`——命令块不再能把 `web:3000` 静默写进去 |
| 6 | `grep -rn "203\.10\.99\.26" docs deploy scripts README.md \| grep -v AUDIT-SECURITY` | 0 命中（rc=1） |
| 7 | `grep -n -- ":-aihot" docker-compose.yml` | 0 命中（rc=1）；两处 `POSTGRES_PASSWORD` 都已是 `:?` |
| 8 | `git diff --stat` | 本批命中：`.env.example`、`README.md`、`docker-compose.yml`、`docs/deploy.md`、`docs/manual.md`、`docs/geohot-runbook.md`、`deploy/geohot/README-deploy.md`、`install-units.sh`、`install-long-window.sh`（工作区另有其它并行改动，不属于本批） |
| 9 | 用 `node -e` 复刻 `config.ts:100` 的 `LOCAL_HOST` 正则，喂四个 URL | `http://web:3000 → rejected by production gate = false`；`localhost` / `127.0.0.1 → true`；`https://example.com → false`（证实「web:3000 能过闸门但仍是错地址」） |
| 10 | `node -e` 数 `industry/changelog.json` 的 `releases`；`git tag --list 'v*' \| wc -l`；`git rev-list --count HEAD` | `entries = 258`；`254`；`1714`（README 的 255 改为 258 的依据） |

**没有验证的**：`docker compose config`（本机 `docker: command not found`，也没有可用的 YAML 解析器/PyYAML），所以 `docker-compose.yml` 的语法与 `${VAR:?msg}` 插值只做了人工核对，**没有实际跑过**。同理没有跑 `npm test`、`npm run env:init`、任何 systemd 单元或部署脚本。

## 4. 需要 owner 决定（未擅自改）

1. **bootstrap 第 10 节 enable 了全部 33 个 `.service`，但 §8 只手工 `start` 六个**：`geohot-magpie`、`geohot-media`、`geohot-swap-cache`、`geohot-box-hold`、`geohot-instabox-hold`、`geohot-conc-guard`、`role-day/night`、`server-status`、`hangzhou` 隧道这几类在新机器上首次部署后要等重启才起来（它们已 enable）。是否要在 §8 增列分组或改成按机决定，属生产行为，未改。
2. **`<reader-host>` 的命名**：被脱敏的那处公网 IP 在复盘里是抓取方/扫描器 IP，不是本站读者主机。按任务要求统一写成 `<reader-host>`；若更看重语义，建议改成 `<scanner-host>` / `GEOHOT_HOST` 必填变量，需 owner 拍板。
3. **`install-units.sh` 里还有两处「只把四个单元打进终端」**（`:28`、`:46`）：它们描述的是 `GEOHOT_APP_ROOT` 指向别处时的生成路线（那条路线确实只生成四个），仍然成立；但默认路线的 dry-run 实际打印 33 个。措辞是否统一，未动。
4. **去掉 `:-aihot` 的迁移影响**：任何只靠默认口令跑起来的旧本机栈，更新后会直接报错，需要先在 `.env` 补一行 `POSTGRES_PASSWORD`。这是审计要求的行为变化，但它会让旧环境"升级即失败"一次。
5. **工作区里仍有未迁移的凭据材料**：`_diag/zcode-completion/conflict-ledger.csv`（安全审计 F-14，证据列内嵌 key 字面量）仍在原位，不在本次 README 段落点名的 `_assist/` 与 `_diag/t8` 范围内；是否一并移入保险库并就地脱敏，需 owner 决定。
6. **同一类过期计数还留在 `deploy/geohot/DEPLOYMENT.md:273`**：「四个常驻单元的 `TimeoutStopSec`」——实测模板目录里有 **7** 个 `.service` 写了 `TimeoutStopSec=285`。这不在 D6 点名的两处里，本轮未改；若要彻底清掉「抄死的计数」，建议下一次文档 pass 一并处理。
