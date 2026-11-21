# GEOHOT 工作区审计（GEOHOT 之外）

审计对象：`D:\地理热点网站` 顶层，**不含** `GEOHOT/`。
审计时间：2026-11-21。
本轮操作：**0 删除 / 0 移动**；只写 `docs/history/` 两个审计产物（它们是审计输出，不是被审计对象）。未执行 `rm`、`Remove-Item`、`git clean`、`git worktree remove`、`git reset`。

> 版本说明：本文初稿由本任务上一轮起草（10:14–10:16）。本轮在同一文件上复测，并**逐条重跑**了所有载荷性取证命令（清单见 §七），未重跑的项在 §六 明列为未验证。初稿记录 `.mimosa/` 为 13,111 文件 / 102.9 MB；11:05 复测为 **24,045 文件 / 188.8 MB**，原因是 `hook-state` 在审计进行期间仍随每个 actor 会话新增约 11 MB 基线快照。下文所有 `.mimosa` 数字、合计与可回收估算均已按 11:05 复测值改写，初稿数字仅在此处与 §四 保留作对照。

配套机读清单：`docs/history/workspace-inventory.json`。

---

## 一、口径与方法

| 项 | 做法 |
| --- | --- |
| 体积 | 逐文件 `find <path> -type f -printf '%s\n'` 求和（**逻辑字节**），非估算。同时给出 `du -sh` 的**分配**体积作对照。 |
| 符号链接 | 统计一律 **不跟随**。实测存在 2 个 symlink 指向 `GEOHOT/node_modules`（见风险 R3），`find -L` 会把 18,117 个文件算进来，故本次全部用 `-type f` / `-type l` 分开统计。 |
| 文件类型 | `find ... -printf '%TY-%Tm-%Td\n'` 取最新 mtime；扩展名用 `sed -E 's/.*\.([A-Za-z0-9]{1,6})$/\1/'` 归一后 `uniq -c`。 |
| 密钥 | 只打印**变量名 / 字段名 / 值长度 / 是否形似占位符**，值本身不落盘、不进本文件。匹配模式：`sk-`、`sk-ant-`、`ghp_`、`gho_`、`AKIA`、`BEGIN ... PRIVATE KEY`、`xox[bp]-`、`AIza`、`eyJ...`（JWT）、`Bearer ...`、`password=`、`Cookie:`。 |
| 未做 | 未解包任何 tarball 到磁盘（只用 `tar -tzf` / `tar -xzO` 流式读）；未扫描 tarball 内部二进制；未核对服务器端实际凭据是否已轮换；未运行 `schtasks` 确认计划任务。 |
| 时点 | `.mimosa/` 在审计期间**仍被写入**，故它是本次唯一需要复测的目录；其余目录两次测量字节数完全一致（见 §四）。 |

工作区总量（GEOHOT 之外，2026-11-21 11:05 复测）：**672,387,256 B ≈ 641.2 MiB / 914+24,045+637+51+1+1 = 25,649 个文件**。

| 目录 | 逻辑字节 | 分配(`du`) | 文件数 | 最新 mtime |
| --- | --- | --- | --- | --- |
| `_archive/` | 420,058,809 | 403M | 914 | 2026-11-21 |
| `.mimosa/` | 188,789,728 | 242M | 24,045 | 2026-11-21 10:58 |
| `_diag/` | 60,185,231 | 59M | 637 | 2026-11-20 |
| `_assist/` | 3,350,927 | 3.4M | 51 | 2026-11-16 |
| `README.md` | 2,559 | — | 1 | 2026-11-20 |
| `.zcode/` | 2 | 5K | 1 | 2026-10-31 |
| **合计** | **672,387,256** | — | **25,649** | — |

`.mimosa` 逻辑 180.0 MiB 而分配 242M，差值来自 24k 个 4K 簇的小文件；`_archive` 逻辑 400.6 MiB 而分配 403M，基本一致。`_archive` 仍占本工作区的 62.5%，`.mimosa` 已从初稿的 17.6% 升到 28.1%。

---

## 二、各目录用途证据

### 2.1 `_archive/` —— 冷存档（403M）

用途证据：
- `README.md:11`：「`_archive/` 历史快照、旧版素材和数据库备份证据。**未确认唯一副本前不要删除**。」
- `_archive/README.md:3-4`：「这里只放『已经发生过的、不再被任何脚本读的东西』。**任何进程都不该再读这里**。」

因此本审计对 `_archive/` **全部条目给 `review`**，无一给 `delete`。

类型构成（914 文件）：`mjs` 214、`sh` 101、`log` 84、`type` 79、`yml` 68、`png` 52、`ts` 43、`txt` 42、`json` 30、`md` 27、`sql` 18、`patch` 18 —— 即「旧源码树 + 诊断脚本 + 截图 + 补丁」的混合快照，不是纯素材库。

逐项：

| 路径 | 字节 | 内容与证据 | 建议 |
| --- | --- | --- | --- |
| `evidence-rounds-20261010-13.tar.gz` | 185,595,717 | `_archive/README.md:9` 明确标注**唯一副本**；`tar -tzf` 5,232 条目；内部 `.round9/.round10/clone-drill/*/.env` 含**已填充**的本地 drill 密钥（`ADMIN_PASSWORD` 16 位、`SESSION_SECRET` 64 位、`POSTGRES_PASSWORD` 36 位、`INGEST_TOKEN` 48 位），但其 `DATABASE_URL` 指向 `127.0.0.1:5433/geohot_drill_test`、`SITE_URL=http://localhost:3499`，属一次性本地演练库，**不是生产库** | review |
| `diag-rounds-r18-r67-20261116.tar.gz` | 181,735,490 | `_archive/README.md:8` 记录为 R18–R67 诊断目录原样打包；`tar -tzvf` 只有 10 条目，因为内部是**嵌套压缩**：`browser-runs-r21.tar.gz` 60.9MB、`r59` 43.6MB、`r67` 44.7MB、`oneoff-scripts-20261105.tar.gz` 5.2MB | review |
| `promo-videos/` | 23,266,510 | 2 个 mp4；`_archive/README.md:13`「不用了就能删」——删除条件取决于站长是否还要这两条片子，本审计无法判定 | review |
| `patches-20261030/` | 12,114,188 | 11 个 `.patch`；`_archive/README.md:11` 标注 `stash0-full-20261030.patch`（11.1MB）为**唯一副本** | review |
| `2026-11-03/` | 10,900,873 | 629 文件，大搬迁前快照（`_archive/README.md:12`）。内含**嵌套 `_archive/`**（3.48MB/447 文件），其中有 `.modelteam/wb-cn-credential.json`、`.codearts/mock.env`、`.chaoxing/`；另有两个 **symlink 指向 `GEOHOT/node_modules`**（风险 R3） | review |
| `wip-rescue-20261105/` | 4,019,926 | 231 文件；`SUMMARY.txt:1-7` 逐项记录 7 个救援分支「N status, N copied, 0 skipped」，是分支内容的搬运清单 | review |
| `source-registry-20261120/` | 2,088,923 | 4 文件：`geohot-source-registry-20261120.dump`（879,679 B，文件头 `PGDMP` + `geohot` + `17.11 (Ubuntu …)`，即 PostgreSQL 17.11 custom-format 全库导出）、`preflight-report.json`（`total: 824 / passed: 795`）、两份 manifest | review |
| `private/` | 335,988 | 34 文件：`geohot-assist.json`（SSH 连接参数，含 `identityFile`）、两份 PR 正文、`queue-snapshot.sh`、`geohot-assist-state/assist-2026-10-30..11-03.log` | review |
| `README.md` | 1,194 | 冷存档规则与删前核对要求（`README.md:16`：唯一副本先打包再谈删除） | keep |

### 2.2 `_diag/` —— 诊断与验收（59M）

用途证据：`README.md:10`「只读诊断脚本、代码行数统计、清理审计、验收截图与最终验证日志」。

类型构成（637 文件）：`png` 168、`log` 131、`mjs` 76、`md` 62、`json` 44、`txt` 39、`sh` 34、`sql` 18、`py` 17。

| 路径 | 字节 | 内容与证据 | 建议 |
| --- | --- | --- | --- |
| `browser/`（13 个 `*-<时间戳>/` 运行目录） | 39,303,227 | 目录内 **164 文件**（153 张 png + 11 个 json；整目录含顶层共 182 文件）：`r16-2026-11-15T12-00-44`(9.47MB)、`r16-2026-11-16T01-20-51`(9.44MB)、`bsk-20261115`(6.09MB)、7 个 `admin-*`(14.3MB)、3 个 `magpie-probe-*`。是验收视觉证据，删了无法从代码重建 | archive |
| `browser/`（15 个探针脚本 + 1 份运行日志） | 62,817 | 实测 `find -maxdepth 1 -type f`：15 个 `.mjs`（合计 60,287 B，最大 `verify-r16.mjs` 16,729 B）+ `r161-run.log` 2,530 B。`verify-r16/verify-r16b/cdp-lib/verify-admin/verify-admin-mobile/verify-dark/mobile-{pool,scroll}-probe/check-{admin-layout,admin-paging,mobile-pool,magpie}/shot-pages/tab-probe/tmp-nodes2`，可重跑。注：这 16 个文件只占 63KB，远小于该目录的 48.3MB——大头是下面的 13 个运行目录与两个大文件 | keep |
| `browser/older-evidence-20261116.tar.gz` | 7,979,669 | 单个 7.98MB 证据包，占该目录散落文件体积的 88% | archive |
| `browser/nodes-check-server.png` | 983,098 | 单张 983KB 截图 | archive |
| `t8/magpie-merge/` | 548,863 | **凭据库**：`logins.json` 45 条（字段含 `auth`）、`plugin-auth.json` 40 条（`refresh`/`access`/`deviceToken`/`deviceRefresh`/`email`/`machineId`）、`caller-keys.json` 1 条明文 `secret`（`sk-magpie-key-…`）、`providers.json`、`server-files.tar`(102,400 B)+`server-files.b64`(136,536 B) 以两种格式**重复打包同样 5 个文件**。见风险 R2 | review |
| `t8/`（其余 80 文件） | 6,214,722 | `diag-*.sql`、`audit.md`、`magpie.md`、`local-deploy-r66.md`、移动端截图 | archive |
| `logs/` | 1,503,327（另 7,259 见下行） | 110 个 `assist-trial1..N.log`（2026-11-04/05 本机协同调试），占该目录 99.5%。`grep -rlE 'Bearer \|Cookie:\|password='` → **0 命中** | delete |
| `logs/` 里混着的 8 个 `mjs/sh` | 7,259 | `clone_db.mjs`、`mktestdb.mjs`、`mk_scratch.mjs`、`probe_dbs.mjs`、`probe_heartbeat.mjs`、`probe_migrations.mjs`、`repro_adminread.mjs`、`wait_and_webtests.sh`——可重跑探针，容易被「整目录删日志」顺手带走 | keep |
| `cleanup-and-verification-20261120/` | 1,081,351 | 19 文件，含上一篇磁盘审计 `cleanup-audit-summary.txt`。**其第 43-44 行指向的 `artifacts/cleanup-audit.json` 与 `artifacts/cleanup-audit-summary.txt` 均已不存在**，此处疑为唯一存世副本。见风险 R7 | review |
| `t9/` | 799,911 | 84 文件：`_remote_h..k.sh`、`add-changelog-*.mjs`、`audit-round6.md` —— 一次性的远程操作与轮次审计 | archive |
| `mcp/` | 425,793 | `probe.mjs`/`probe2.mjs`/`smoke.mjs` | archive |
| `tmp/` | 300,529 | 只有 `_keep/` 一层：`aboutrss.md` 256,171 B（AboutRSS 项目 README 存根）、`local-models.json` 32,347 B、3 份 feed 清单、`geo-homes.txt`。**`_keep` 是刻意标记，不是垃圾**，初稿判 `delete` 有误 | review |
| `archive-20261116/` | 282,526 | `turn3-report.md`…`turn5-report.md`、`verify-tests.md`、`mv*.err` | archive |
| `zcode-completion/` | 229,892 | `README.md`、`queue-ledger.csv`、`conflict-ledger.csv`、`proposals.md` | archive |
| 顶层散落 50 文件 | 266,400 | `loc-by-file.csv`(38.5KB)、`GEOHOT-代码规模与优化建议.md`(35KB)、`sweep-local.md`(24.6KB)、6 份 `item(s)-*.html` 抓取快照、`probe1..10.mjs`、`loc-*.mjs`、`smells.mjs`、`recheck.mjs`、`nn.mjs`、`db-rescue.mjs`、`gen-index.mjs`、`export-csv.mjs`、`mk-launchers.mjs`、`usage-compact.sh`、3 份 `api-*.json` | archive |
| `t11/` | 75,381 | 单文件 `audit-fanout.txt` | archive |
| `t12/` | 69,313 | `cleanup-c.md`（上一轮清理计划）、`evidence.txt`、`local-deploy-r15/16/22.md` | archive |
| `t13/` | 33,090 | `acme-exempt.sh`、`cf-edge-only.sh`、`cleanup-r18-plan.md`、`huashu.mjs` | archive |
| `browser-audit/` | 18,063 | `audit.py`、`sample.py` | keep |

### 2.3 `_assist/` —— 旧本机协同凭据（3.4M）

用途证据：`README.md:12`「旧本机协同留下的**凭据目录**；当前站点不再运行本机 worker，也没有相关计划任务。保留仅为避免丢失不可恢复的凭据，不属于运行链路。」

现场核对（本轮实测）：
- `_assist/local-executor/supervise.lock/pid` = `1723`；`tasklist //FI "PID eq 1723"` → 「信息: 没有运行的任务匹配指定标准」→ **worker 未运行**。
- `_assist/run-hidden.vbs` 要启动的目标 `GEOHOT/scripts/run-workstation-assist.ps1` → `ls` 报 `No such file or directory` → **启动链已断**。
- `worker.log` 末次写入 2026-11-16 06:14。

即 README 的「已停用」结论成立，但目录仍在，且里面是明文生产凭据。

| 路径 | 字节 | 内容与证据 | 建议 |
| --- | --- | --- | --- |
| `local-executor/` | 3,292,204 | 13 文件。`.env.local-executor`（10,222 B）含 40+ 供应商 `*_API_KEY`；`worker.log` 3,260,605 B（占 99%）；`start.ps1`/`stop.ps1`/`supervise.sh`/`window*.vbs` | review |
| `newbox/` | 52,765 | 11 文件。`.env.primary` 首行自述 `# GEOHOT production env — generated on the server by the deploy agent`，含 `SESSION_SECRET`(64)/`ADMIN_PASSWORD`(11)/`INGEST_TOKEN`(64)/`IMG_PROXY_SIGN_SECRET`(64)/`DATABASE_URL`(`127.0.0.1:5432/geohot`)；另有 `.env.executor`、`.env.providers`。见风险 R1 | review |
| `state/` | 4,680 | 25 文件：22 个 `assist-child-*.log` + 3 个 `extraction-assist.lock.stale-*` | delete |
| `geohot-assist.json` | 232 | 字段 `host`/`hostKeyAlias`/`identityFile`/`localPort`/`stateDirectory`，是 SSH 跳板参数 | review |
| `run-hidden.vbs` | 1,046 | 内容：`CreateObject("WScript.Shell")` + `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "…\GEOHOT\scripts\run-workstation-assist.ps1" -Config "…\_assist\geohot-assist.json" -SlotCount 2`，`sh.Run cmd, 0, False`（隐藏窗口）。目标已不存在 | delete |

### 2.4 `.mimosa/` —— 工具链缓存（242M 分配 / 180.0 MiB 逻辑，且在增长）

- `hook-state/`：188,785,595 B / 24,040 文件（23,996 个 `.source` + 44 个 `sess_*.json` / `.continue.json`），**22 个 `*.baseline/` 目录**，每个约 9.4–11 MB。这是 PreToolUse/PostToolUse 钩子的基线快照，**可重建、无业务价值**。
- 关键量化：把 23,996 个 `.source` 全部 `sha256sum` 去重，**只有 1,091 个不同内容**，即同一批源文件被平均复制 **22 份**（每个 actor 一份基线）。快照内容是项目源码（抽样首行如 `// Dots short-writing requests disable documented thinking…` + `import { purgeTagged, stub, t }`），故它同时也是 `GEOHOT` 源码的一份游离副本。
- 增长实测：10:16 为 12 个基线 / 13,108 文件 / 102,908,588 B；11:05 为 22 个基线 / 24,040 文件 / 188,785,595 B。**47 分钟内 +10 个基线、+85.9 MB**，与本次 workflow 的 actor 数同步。审计收尾时（11:14）再测为 24,047 文件，仍在增长。
- `finding-ledger/`：2,857 B / 2 文件（`v1/events/batch-{pre,post}tooluse-*.json`）。
- `hook-status/`：1,276 B / 4 文件（每个会话一个哈希命名 JSON）。

判断：`hook-state` 属于**每会话线性增长的缓存**，不是历史资料；但它正被运行中的钩子使用，**不能整目录删**，只能删非活跃会话的 `*.baseline` / `*.continue.json`，且需先确认对应 actor 已结束。

### 2.5 `.zcode/`

`workflow-runs/.gitignore` 2 字节占位，无内容。keep。

### 2.6 按「问题类型」汇总索引（回答抽查时最常问的六类）

| 类型 | 数量 / 体积 | 位置与证据 | 建议 |
| --- | --- | --- | --- |
| 临时脚本、一次性诊断 | `_diag` 内 133 个 `mjs/sh/py/ps1`；`_archive/2026-11-03` 内 271 个（其中 `.codearts/` 73 个） | 命名即证据：`probe1..10.mjs`、`db-probe1..6.mjs`、`db-cn-check/db-cn-check2.mjs`、`db-intl-check/db-intl-check2.mjs`、`backfill-db-probe1..5.mjs`、`db-cn-latency.mjs`、`db-cn-origin.mjs` | 脚本本身多为 `archive`；带编号后缀的 probe 系列无保留价值 |
| 一次性诊断产物 | `_diag/logs` 110 个 `.log` 1.43 MiB；`_diag` 顶层 6 份 `item(s)-*.html` + 3 份 `api-*.json`（各 159 B，抓取快照）；`_diag/tmp/_keep` 6 文件 0.29 MiB（**调研素材，非垃圾**） | `_diag/logs/assist-trial1..N.log`（2026-11-04/05）；`_diag/tmp/_keep/aboutrss.md` 等 | 日志 `delete`；`_keep` 与 html/json 快照 `review`/`archive` |
| 缓存 | `.mimosa/hook-state` 188.8 MB / 24,040 文件 | §2.4；`sha256sum` 去重后仅 1,091 种内容 | 只删已结束会话（`review`） |
| 旧发布包 | 3 个压缩包合计 375.3 MB | `_archive/evidence-rounds-20261010-13.tar.gz` 185.6MB、`_archive/diag-rounds-r18-r67-20261116.tar.gz` 181.7MB、`_diag/browser/older-evidence-20261116.tar.gz` 7.98MB；`find _archive _diag _assist -name '*.tar.gz' -o -name '*.zip' -o -name '*.7z'` 无其它命中 | 前两个 `review`（唯一副本），第三个 `archive` |
| 可能含密钥的 JSON/文本 | `_assist` 4 个 `.env*`（生产级，见 R1）；`_diag/t8/magpie-merge/` 凭据库（R2）；归档 3 处（R4） | 键名与长度见 §七；本文件不含任何密钥值 | 全部 `review`，先轮换再谈删除 |
| 与 GEOHOT 无关的邻居站 | 实质残留 1 处（`grep` 共 4 文件命中，另 3 处是文档引用与页面快照） | `_archive/2026-11-03/panel-shots/tmp-nginx/xxc2007.me.conf:96`、`:401` 的 `root /var/www/nanchang15;`；`:51`/`:346` 的 `root /var/www/intro;`。另 3 个命中：`_diag/t12/cleanup-c.md`、`_diag/t8/hygiene.md`（文档引用）、`_archive/2026-11-03/.playwright-mcp/page-…yml`（页面快照）。`_archive/intro-site/` 已不存在（`_diag/t12/cleanup-c.md:13` 记录其曾为 173.6MB） | 配置 `review`；`hygiene.md:317` 的失效路径需修 |

---

## 三、风险清单（按严重度）

### R1 · 高 —— `_assist/newbox/.env.primary`、`.env.executor`、`.env.providers`、`local-executor/.env.local-executor` 内含**生产级明文凭据**

证据：`_assist/newbox/.env.primary:1` 自述 `# GEOHOT production env — generated on the server by the deploy agent`；`SESSION_SECRET` 值长 64、`ADMIN_PASSWORD` 11、`INGEST_TOKEN` 64、`IMG_PROXY_SIGN_SECRET` 64、`DATABASE_URL` 88（`postgres://<redacted>@127.0.0.1:5432/geohot`），均**非占位符**（不含 `changeme`/`your-`/`example.com`/`<...>` 等特征）。`.env.executor` 同样包含这套键。

影响：任何能读 `D:\地理热点网站` 的进程/用户/备份/同步盘都能拿到站点会话签名密钥、后台口令与采集令牌。这与 `README.md:23`「线上配置、`.env`、数据库、Cookie、SSH 私钥与部署口令不进 Git、不进日志、不写进说明文档」的自我要求相悖——文件本身没进 Git，但仍以明文躺在工作区。

处置建议（本轮不执行）：先在服务器侧轮换 `SESSION_SECRET`/`ADMIN_PASSWORD`/`INGEST_TOKEN`/`IMG_PROXY_SIGN_SECRET` 与各 `*_API_KEY`，再议删除；如需留档，移入受 ACL 保护的位置或密码管理器，而不是仓库旁的普通目录。

### R2 · 高 —— `_diag/t8/magpie-merge/` 是一个完整的 Magpie 凭据库

证据（只读结构，未展开值）：`logins.json` 45 条；`plugin-auth.json` 40 条，字段含 `refresh`/`access`/`expires`/`deviceToken`/`deviceRefresh`/`email`/`accountId`/`machineId`；`caller-keys.json:5` 单条明文 `"secret": "sk-magpie-key-…"`（62 字符，`id=a0790ef7…`、`name=Windows-Local-Magpie`）；`providers.json` 15 个供应商条目；`server-files.tar` 与 `server-files.b64` 把上述 5 个文件再打包两份。

影响：OAuth refresh token 与设备令牌可长期换取访问权。`_diag` 是「可清理」目录，一旦按 `_diag` 整体删除/上传工单附件，这批 token 会外流；反之若仅备份后删除，也需先确认不依赖它们。

处置建议（本轮不执行）：先把该目录移出 `_diag` 纳入受控存储并轮换 Magpie 调用密钥与各账号 refresh token；`server-files.tar`/`.b64` 与散文件是同一批数据的重复，保留一份即可。

### R3 · 高 —— `_archive/2026-11-03/` 内有两个 symlink 指向 `GEOHOT/node_modules`，递归删除会穿透

证据：
```
lrwxrwxrwx … _archive/2026-11-03/geohot-item-preview/node_modules -> /d/地理热点网站/GEOHOT/node_modules
lrwxrwxrwx … _archive/2026-11-03/geohot-title-fix2/node_modules   -> /d/地理热点网站/GEOHOT/node_modules
readlink -f → /d/地理热点网站/GEOHOT/node_modules
find (不跟随) = 0 files；find -L (跟随) = 18,117 files
```
体积上的同一现象：`_archive/2026-11-03/` 按**不跟随**统计是 10,900,873 B，按 **跟随链接**统计（`statSync` 递归）是 **900,315,807 B**，即两个链接会让任何跟随式归档/计费工具多算 **889,414,934 B（约 848 MiB）**。这是判断该目录「有多大」时最容易错的地方。
影响：任何**跟随**链接的递归删除（`Remove-Item -Recurse` 旧版行为、`robocopy /MIR`、部分归档/同步工具）会把共享依赖宿主 `GEOHOT/node_modules` 一并清空，直接打断 `deploy` 与三个 junction 依赖它的工作树——这与 `_diag/cleanup-and-verification-20261120/cleanup-audit-summary.txt:38` 自己写的「最危险误删风险」是同一类事故。`rm -rf` 在 Git Bash 下只删链接本身，但**不能假定执行者用的是哪种工具**。

处置建议（本轮不执行）：删 `2026-11-03/` 前先 `unlink` 这两个 symlink，或用 `find -type l -delete` 单独处理，再删目录；并在任何「整目录删除」脚本里加 `-P`/不跟随 的显式开关。

顺带纠正一个扫描假象：本轮初扫在 `_archive/2026-11-03/geohot-item-preview/node_modules/jose/…` 命中的 `BEGIN PRIVATE KEY` 与 `undici`/`fastify` 的 `Bearer` 命中，**是经 symlink 读到的 GEOHOT 依赖源码**，不是归档内容，也不是泄漏。

### R4 · 中 —— 归档内的模型账号凭据

证据：
- `_archive/2026-11-03/_archive/.modelteam/wb-cn-credential.json`：顶层 `version`/`note`/`credential`，`credential` 含 `accessToken`（1,335 字符）、`refreshToken`（700 字符）、`expiresAt`、`domain=www.workbuddy.cn`、`source`、`account.uid`。本机换算 `expiresAt=1794189359496` → **2026-11-09T01:55:59Z**，即 access token 在审计时**已过期 12 天**；`note` 自述「由 tooling/workbuddy-bridge.ts --export-credential 导出；明文，等同密码」。**refresh token 是否已在服务端吊销未验证**。
- `_archive/2026-11-03/_archive/.codearts/mock.env`：虽名为 mock，仍列有 `CODEARTS_API_KEY`、`QODER_CN_API_KEY` 等键。
- `_archive/private/geohot-assist.json`：SSH `identityFile` 路径（指向工作区外的私钥文件）。

影响：归档目录最容易被当成「无需保护的历史垃圾」而被打包外传。accessToken/refreshToken 属可复用凭据。

处置建议（本轮不执行）：access token 已自然过期，但 refresh token 有效期更长（同批签发，`exp=1794362156` → 2026-11-11T01:55:56Z，亦已过期）；仍应在 WorkBuddy 侧撤销该设备授权后再谈删除，因为 refresh token 在过期前可能已被复制到别处。归档本体保留（可能是唯一副本）但收紧权限。

### R5 · 中 —— 隐藏窗口 + `ExecutionPolicy Bypass` 的自启脚本残留

证据：`_assist/run-hidden.vbs` 用 `WScript.Shell.Run(cmd, 0, False)`（窗口样式 0 = 隐藏）执行 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File …\run-workstation-assist.ps1 -SlotCount 2`。该目标现已不存在，pid 1723 也不在运行。

影响：脚本本身已失效，但这类文件同时具备「隐藏窗口」「绕过执行策略」「无参数静默运行」三重特征，任何终端防护/EDR 都会判为可疑；留在工作区也会误导后来者以为仍有后台进程。`README.md:12` 声称「没有相关计划任务」，本轮**未运行 `schtasks` 验证**，该声明未经我确认。

处置建议（本轮不执行）：确认无计划任务/启动项引用它之后删除；若保留，至少加注释说明已废弃。

### R6 · 中 —— `_archive/` 的「冷存档」规则已被破坏

证据：`_archive/README.md:3-4` 规定「任何进程都不该再读这里」；但 `_archive/source-registry-20261120/` 的 `preflight-report.json`、`verified-manifest.json`、`verified-manifest-2.json` 时间戳为 **2026-11-21 00:40**，是该目录最新写入，晚于 `_archive` 目录本身（2026-11-20 22:29）。

影响：说明 11 月 20–21 日仍有人/脚本把新产物直接落进冷档。冷档与工作区边界失效后，「哪些是唯一副本」的判断会持续漂移，删除风险随之上升。

处置建议（本轮不执行）：明确该 registry 快照到底属于「待用交付物」还是「冷档」；若是前者，应移到 `_diag/` 或有明确生命周期的目录。

### R7 · 中 —— 唯一副本散落，且已有引用断链

证据：
- `_archive/README.md:9` 标注 `evidence-rounds-20261010-13.tar.gz` 为**唯一副本**（177MB）；`:11` 标注 `stash0-full-20261030.patch`（11.1MB）为唯一副本。二者均无第二份。
- `_diag/cleanup-and-verification-20261120/cleanup-audit-summary.txt:43-44` 指向 `D:\地理热点网站\artifacts\cleanup-audit.json` 与 `…\artifacts\cleanup-audit-summary.txt`；实测 `artifacts/` **不存在**（`ABSENT`）。即该 `_diag` 副本可能是 11-20 那次审计的唯一存世记录。

影响：上述三项任一项被当「诊断垃圾」清掉，都不可恢复。

处置建议（本轮不执行）：把这三项登记为「唯一副本」清单；若要腾空间，先异地/异盘备份并校验（`_archive/README.md:16` 已要求「删之前 `tar -tzf` 数一遍条目数对得上」）。

### R8 · 低 —— 邻居站残留：已基本清干净，只剩归档里的服务器配置

证据：
- `_diag/t12/cleanup-c.md:13` 记录 `_archive/intro-site/` 曾是 173.6 MB / 694 文件，内含 **4 份 `个人展示网站`** 副本 + promo，来源 `github.com/xxc2007/Introduction-of-XinChen-Xiong`。本轮 `ls -d _archive/intro-site` → `No such file or directory`，**已移除**。
- 全局 `grep -rlE '个人展示|nanchang15|个人网站'` 仅 4 个文件命中，其中实质内容只有 `_archive/2026-11-03/panel-shots/tmp-nginx/xxc2007.me.conf:96` 与 `:401` 的 `root /var/www/nanchang15;`（另一台站点的 vhost 根目录）。
- `_diag/t8/hygiene.md:317` 仍保留指向 `_archive\intro-site\9191\个人展示网站` 的命令，该路径已不存在，属**文档腐坏**。

影响：本工作区已无活跃的邻居站文件；仅剩一条归档 nginx 配置引用 `nanchang15` 的服务器路径（若该配置含其它 vhost 细节，属服务器拓扑信息）。`D:\个人展示网站`、`D:\nanchang15-website` 不在本次审计范围。

处置建议（本轮不执行）：`hygiene.md` 的那行命令加「路径已删除」标注；nginx 配置确认无敏感 upstream/token 后可长期留在归档。

### 与同批次安全审计的分工

同目录下另有 `AUDIT-SECURITY.md` 与 `security-findings.json`（2026-11-21 10:14 生成，非本审计产物）。二者与本文不冲突，属**同一批事实的两个视角**：

- 本文 = 磁盘占用 / 保留价值 / 删除风险（回答「能不能删」）。
- 安全审计 = 泄漏面与凭据可利用性（回答「泄了会怎样」）。

重叠点：`_diag/t8/magpie-merge/`（本文 R2 与其首条 finding 指向同一目录）。安全审计该条进一步报告 **3 个非空 `devicePrivateKey`**、`deviceToken`(9)、`access`(39)、`refresh`(37)、`accountId`(39)、`email`(9)（`security-findings.json` 首条 `evidence`；`AUDIT-SECURITY.md:371` 另列 `name`/`machineId`）——**这些计数我本轮未独立复算**，仅转述其结论；我独立确认的是 `plugin-auth.json` 为 40 条 provider 记录、`logins.json` 45 条、`providers.json.providers` 15 条，且字段名含 `refresh`/`access`/`deviceToken`/`deviceRefresh`/`accountId`/`machineId`。

`_assist/` 在 `security-findings.json` 中对应 **6 条 finding**（`_assist/newbox/.env.primary`、`.env.executor`、`.env.providers`、`local-executor/.env.local-executor`、`local-executor/worker.log`、`_assist/geohot-assist.json`），与本文 R1/R5 指向同一批文件。注：初稿曾写「原文 `"mentions _assist": true`」，该字面量在 `security-findings.json` 中**不存在**（该文件为 32 条 finding 的数组，字段只有 `where`/`kind`/`evidence`/`tracked`），已按实际结构改写。

---

## 四、与 2026-11-20 上一次审计的差异

上次审计（`_diag/cleanup-and-verification-20261120/cleanup-audit-summary.txt`）给出：树内逻辑总量 1,536,434,982 B；`_diag` 58,982,641 B（needs-review）；`_archive` 417,969,886 B（keep）；`_assist` 3,350,927 B（keep）；并列出 3 个待删 worktree 共 138,927,033 B。

本轮实测对比：

| 上次提到 | 本轮状态 | 证据 |
| --- | --- | --- |
| `GEOHOT-docs-admin-usage-20261117` | 已不存在 | `[ -e ]` → ABSENT |
| `GEOHOT-reader-capacity-20261118` | 已不存在 | ABSENT |
| `GEOHOT-security-sanitize-20261118` | 已不存在 | ABSENT |
| `GEOHOT-deploy` | 已不存在 | ABSENT |
| `_shots`、`_verify`、`geohot-daily-links` | 已不存在 | ABSENT |
| `index.html`（上次记为 keep，9,862 B） | 已不存在 | ABSENT |
| `artifacts/cleanup-audit.json` | **不存在**（上次的证据指针失效） | ABSENT |
| `_assist` 3,350,927 B | **字节数完全一致**，未被改动 | 本轮求和 = 3,350,927 |
| `_diag` | 增至 60,185,231 B（+1,202,590），新增 `cleanup-and-verification-20261120/` | 本轮求和 |
| `_archive` | 增至 420,058,809 B（+2,088,923），新增 `source-registry-20261120/` | 本轮求和 |
| `.mimosa/hook-state` | 本次审计**进行期间**从 102,908,588 B / 13,108 文件增至 188,785,595 B / 24,040 文件（+85,877,007 B） | 10:16 与 11:05 两次 `find -printf '%s'` 求和 |

更早一轮的对照：`_diag/sweep-local.md` 记录 2026-11-04 那次清理把 `.mimosa\hook-state` 从 **880,136 个文件清到 0**（该表「审计工作流候选文件数最大来源」一行），而今天它已有 24,040 个文件——**同一个缓存已重新长回来**，只是这次规模还小一个量级。这说明「清一次」对该目录无效，需要的是保留策略（如按会话保留最近 N 个基线），而不是一次性删除。

结论：11-20 之后确实做过一轮清理（worktree、deploy、`_shots`、`_verify`、`index.html` 均按计划移除），但 `_assist` 明文凭据与 `_diag/t8/magpie-merge` 凭据库**原封未动**，且新增的归档产物又直接写进了冷档。

---

## 五、建议执行顺序（本轮一律未执行）

1. **先轮换、再删除**：R1/R2/R4 的密钥在服务器侧轮换并验证生效，之后才谈 `_assist/*.env*` 与 `_diag/t8/magpie-merge/` 的去留。
2. **处置 symlink**：R3 的两个链接先 `unlink`，再考虑 `_archive/2026-11-03/`。
3. **备份唯一副本**：R7 三项先异地校验备份，`tar -tzf` 核对条目数（`_archive/README.md:16` 的要求）。
4. **清缓存/日志**：`.mimosa/hook-state`（**只删已结束会话的基线**，排除活跃 actor）、`_diag/logs` 的 110 个 `.log`、`_assist/state` 属低风险可回收项，合计约 181.5 MiB。**`_diag/tmp/_keep` 不要动**。
5. **修文档**：`_diag/t8/hygiene.md:317` 的失效路径、`_archive/README.md` 对 `source-registry-20261120/` 的归属说明。

预计可回收（在 1–4 完成前提下，11:05 口径）：`hook-state` 180.04 MiB + `_diag/logs` 的 `.log` 1.43 MiB + `_assist/state` 4.6 KiB ≈ **181.5 MiB（≈190.3 MB）**，占本工作区（GEOHOT 之外）641.2 MiB 的约 **28.3%**。因 `hook-state` 仍在增长，这是**下界**；`_archive` 的 400.6 MiB 才是大头，但它整目录属 `review`，需站长逐项确认。

---

## 六、未覆盖与限制

- 未解包任何 tarball，因而**未扫描** `evidence-rounds-20261010-13.tar.gz`（185MB）与 `diag-rounds-r18-r67-20261116.tar.gz`（181MB）内部除 `.env`/命名字符串以外的二进制内容；两包内是否还有其它明文密钥**未验证**。
- `_archive/source-registry-20261120/*.dump` 是 PostgreSQL custom-format（`PGDMP`），未用 `pg_restore -l` 解析表清单，**未逐表确认**是否含用户表数据。
- 未运行 `schtasks /query`，故 `README.md:12`「没有相关计划任务」只是引用其声明，未经本轮核实。
- 未审计 `GEOHOT/`、`D:\个人展示网站`、`D:\nanchang15-website`；仅在解释 symlink 目标与 grep 假象时读取了 `GEOHOT/node_modules` 的路径与文件计数。
- 文件「用途」全部来自目录内自带文档、脚本首部注释与文件名，未向任何人求证；标 `review` 者即表示**我无法单凭文件本身判定其去留**。

---

## 七、复测记录（2026-11-21 10:40–11:05，实际执行）

| 命令 | 输出 | 支撑的结论 |
| --- | --- | --- |
| `for d in _archive _diag _assist .mimosa .zcode; do find "$d" -type f -printf '%s\n' \| awk '{s+=$1}END{print s}'; done` | 420,058,809 / 60,185,231 / 3,350,927 / 188,789,728 / 2；加 `README.md` 2,559 = **672,387,256** | §一 总量表 |
| `find _archive -type l -printf '%p -> %l\n'` | 2 条，均指向 `/d/地理热点网站/GEOHOT/node_modules` | R3 |
| `find -L _archive/2026-11-03/geohot-item-preview/node_modules -type f \| wc -l` | **18,117** | R3 |
| 递归 `statSync` 求 `_archive/2026-11-03` 体积 | **900,315,807 B**（不跟随为 10,900,873 B） | R3 的体积放大 |
| `tar -tzf _archive/evidence-rounds-20261010-13.tar.gz \| wc -l` | **5,232** | R7 唯一副本 |
| `tar -tzvf _archive/diag-rounds-r18-r67-20261116.tar.gz` | 5 个 `diag-r*/` 目录 + 内嵌 `browser-runs-r{21,26,59,67}.tar.gz`(60.9/27.3/43.6/44.7 MB) 与 `oneoff-scripts-20261105.tar.gz`(5.2 MB) | §2.1 |
| `tar -tzf evidence… \| grep -E '\.env($\|\.)'` | 9 条，含 `.round9/clone-drill/app/.env`、`.round10/clone-drill/repo/.env` 等 | R4 |
| `tar -xzO … .round9/clone-drill/app/.env`（只取键名与掩码 DSN） | `SITE_URL=http://localhost:3499`、`DATABASE_URL=postgres://geohot:***@127.0.0.1:5433/geohot_drill_test`；键含 `SESSION_SECRET`/`ADMIN_PASSWORD`/`POSTGRES_PASSWORD`/`LLM_API_KEY` | R4「属本地演练库」的判断 |
| `find .mimosa/hook-state -name '*.source' \| wc -l` → `sha256sum \| cut -d' ' -f1 \| sort -u \| wc -l` | 23,996 → **1,091** 个不同内容（22×重复） | §2.4 |
| `node -e` 读 `.env.executor` 键值长度 | `SESSION_SECRET` 64、`ADMIN_PASSWORD` 11、`INGEST_TOKEN` 64、`LLM_API_KEY` 51、`DATABASE_URL` 89，均非占位符 | R1 |
| `node` 读 `wb-cn-credential.json` 元数据（不打印值） | `accessToken` 1,335 字符、`refreshToken` 700 字符、`expiresAt` 1794189359496 → **2026-11-09T01:55:59Z**（已过期）、`source` 为 `CodeBuddyExtension` 本地 auth 导出 | R4；过期状态已确认 |
| `node` 读 magpie-merge | `logins.json` 45 条、`plugin-auth.json` 40 条、`providers.json.providers` 15 条；`server-files.tar` 102,400 B 与 `server-files.b64` 136,536 B 并存 | R2 |
| `tasklist //FI "PID eq 1723"` | 「信息: 没有运行的任务匹配指定标准。」 | §2.3 worker 未运行 |
| `ls GEOHOT/scripts/run-workstation-assist.ps1` | `No such file or directory` | §2.3 启动链已断 |
| `ls -d artifacts` | `No such file or directory`；`grep -n artifacts _diag/cleanup-and-verification-20261120/cleanup-audit-summary.txt` → 43、44 行 | R7 |
| `head -c 16 …source-registry-20261120.dump \| od -c` | `P G D M P 001 020 \0 004 …` | §2.1 PostgreSQL custom dump |
| `node` 读 `preflight-report.json` | `total 824 / passed 795` | §2.1 |
| `sed -n '315,319p' _diag/t8/hygiene.md` | 仍含 `_archive\intro-site\9191\个人展示网站` | R8 文档腐坏 |
| `find /d -maxdepth 2 -name evidence-rounds-20261010-13.tar.gz` | 无输出（D: 根两层内无第二份） | R7 的「唯一副本」仅在此范围内成立 |
| `ls -p _diag \| grep -v / \| wc -l` | **50** | 修正初稿「37 个文件」的计数误差（字节数 266,400 原就正确） |
