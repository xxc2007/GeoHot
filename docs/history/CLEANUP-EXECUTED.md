# 清理执行记录 — 2026-11-21

- 仓库：`D:\地理热点网站\GEOHOT`
- 分支：`chore/repo-cleanup-20261121`（本次新建，起点 `2e5edf22`；**未提交、未 push**）
- 方案：`docs/history/cleanup-plan.json`（41 条：19 条 auto、22 条 manual）
- 执行方式：只跑指定脚本，未修改脚本，未手工增删方案外文件

> **复核后修订（同日）**：复核指出 `vault_credentials.sh` 把 12 条 `requiresManual=true` 条目（7 keep + 5 待删）整目录搬进了 vault，越过 plan 的「manual 不由执行脚本自动处理」语义。这 12 条已按原路径原样移回工作区（`_assist` 51、`_archive/private` 34、`_archive/2026-11-03` 629、`_diag/t8/magpie-merge` 14、`_diag/t8/snap_c.out` 1、`_archive/evidence-rounds-…tar.gz` 1，合计 730 文件 / 200,753,358 B，与 §5 的迁入计数一致）；`D:\GEOHOT-SECURE-VAULT\20261121` 已清空，manual 队列仍待站长逐条处理。§3.2 与 §5 的「进入 vault」记录的是修订前的迁入事实。`conflict-ledger.csv` 的脱敏按 plan §4.2 保留（原文未留备份，不可还原）。
> **归档落点复核**：§1 的 6 个 archive 项已按 `cleanup-plan.json` 的 conventions 改落 `D:\地理热点网站\_archive\repo-20261121\<原相对路径>`；workspace 项 #21 补做到 `D:\地理热点网站\_archive\workspace-20261121\<原相对路径>`。仓库内 `docs/history/archive/` 与 `docs/history/releases/` 不再存放归档件。

## 0. 总览

| 类别 | 条目数 | 结果 |
| --- | --- | --- |
| 自动条目（requiresManual=false） | 19 | 12 条执行完成（含复核后补做的 #21）；4 条 keep 跳过；3 条因脚本路径判断 bug 未执行（见 §2） |
| 手工条目（requiresManual=true） | 22 | 0 条删除；10 条原地未动；12 条曾被第 3 步整目录迁入 vault，复核后已按原路径原样移回（见页首，内容完整） |
| 合计 | 41 | — |

三条命令的实际输出与退出码：

1. `node /d/geohot-deploy-tools/apply_cleanup.mjs` → `EXIT=0`，`applied: 11`
2. `node /d/geohot-deploy-tools/redact_ledger.mjs` → `EXIT=0`，`{"redacted":6}`
3. `bash /d/geohot-deploy-tools/vault_credentials.sh` → `EXIT=0`，6 条 `vaulted`

> 关于「每步失败要停」的判断：第 1 步退出码为 0、仓库侧 11/11 全部落地，但工作区侧 4 条被脚本静默跳过（详见 §2）。我没有就地中止，理由是：第 2、3 步不依赖这 4 个被跳过的文件；第 3 步是保护性移动，中止会把明文凭据继续留在工作区。**这 4 条仍需修 bug 后重跑**，此处如实记录，未用手工删除替代脚本。复核后 #21（`older-evidence` 归档）已补做到约定的 workspace 归档路径，剩余 3 条。

## 1. 已执行的自动条目（12 条：11 条 repo + 1 条 workspace 补做）

| # | 路径 | 动作 | 结果 |
| --- | --- | --- | --- |
| 1 | `apps/web/app/features/monitor/ResetCalendar.tsx` | delete | `git rm` 已暂存（`D`） |
| 2 | `apps/web/app/features/monitor/PostCard.tsx` | delete | `git rm` 已暂存（`D`） |
| 3 | `apps/web/app/features/monitor/format.ts` | delete | `git rm` 已暂存（`D`） |
| 4 | `deploy/geohot/systemd/geohot-api-memory.conf` | delete | `git rm` 已暂存（`D`） |
| 5 | `tooling/model-pool-dead.txt` | delete | `git rm` 已暂存（`D`）；与 `deploy/geohot/bin/model-pool-dead.txt` md5 均为 `802bf49f…`，确为重复副本，且 `prune-model-pool.sh:17` 默认读脚本同目录那份 |
| 6 | `tooling/import-pricing-map.ts` | archive | → `D:\地理热点网站\_archive\repo-20261121\tooling\import-pricing-map.ts` |
| 7 | `tooling/backfill-reasoning-tokens.ts` | archive | → `D:\地理热点网站\_archive\repo-20261121\tooling\backfill-reasoning-tokens.ts` |
| 8 | `scripts/deploy-reserve-guard.ts` | archive | → `D:\地理热点网站\_archive\repo-20261121\scripts\deploy-reserve-guard.ts` |
| 9 | `scripts/refresh-workflow-readiness.ts` | archive | → `D:\地理热点网站\_archive\repo-20261121\scripts\refresh-workflow-readiness.ts` |
| 10 | `deploy/geohot/tmp/`（17 项，14 个 .sh + 3 个 staging 目录） | archive | → `D:\地理热点网站\_archive\repo-20261121\deploy\geohot\tmp`（1.8 MB，17 项齐全） |
| 11 | `docs/major-release-20261024/`（4 文件） | archive | → `D:\地理热点网站\_archive\repo-20261121\docs\major-release-20261024\`（4 文件齐全） |
| 12 | `_diag/browser/older-evidence-20261116.tar.gz`（workspace 项 #21） | archive | 复核后补做 → `D:\地理热点网站\_archive\workspace-20261121\_diag\browser\older-evidence-20261116.tar.gz`（7,979,669 B） |

审计文件复制（`apply_cleanup.mjs` 的 `copyAudit`）：

- 新复制：`AUDIT-SECURITY.md`、`security-findings.json`、`CLEANUP-PLAN-20261121.md`、`cleanup-plan.json`、`COMMIT-LEDGER-SIDE.md`（复核后已移除前两者与 `COMMIT-LEDGER-SIDE.md` 的仓库内副本：`AGENTS.md:34` 明写这三份不进公开仓库）
- 目标已存在、未覆盖：`AUDIT-WORKSPACE.md`（md5 `5f21faac…`，父目录同值）、`workspace-inventory.json`（md5 `e6936412…`，父目录同值）

## 2. 自动条目中未执行的 7 条

### 2.1 keep（4 条，按方案跳过，正确）

`tooling/ci-check.yml`、`assets/leaderboard-sources/`、`assets/model-providers/`、`_diag/tmp/_keep/`

### 2.2 因脚本 bug 未执行（3 条，**需要重跑**）

`apply_cleanup.mjs:5` 定义 `root = "D:/地理热点网站"`（正斜杠），`apply_cleanup.mjs:14-16` 的 `inside()` 用 `resolved.startsWith(base + path.sep)` 判断；Windows 上 `path.resolve` 返回反斜杠，`"D:\\地理热点网站\\_diag\\…"` 永远不以 `"D:/地理热点网站\\"` 开头，故 `apply_cleanup.mjs:69` 对**所有** workspace 条目判为 `outside workspace`。已就地复现：

```
resolved:  "D:\\地理热点网站\\_diag\\logs\\*.log"
base+sep:  "D:/地理热点网站\\"
inside:    false
```

| 路径 | 方案动作 | 现状（实测） |
| --- | --- | --- |
| `_diag/items-h8nme0fprk1uf1u8dbhfz53k5.html` | delete | 仍在，19,610 B；同目录另两份 md5 相同副本保留（`_diag/items-lg7…html`、`_diag/items-xqe9…html`） |
| `_diag/logs/*.log` | delete | 仍在，110 个 `.log`（目录 1.7 MB）；同目录 8 个 `.mjs/.sh` 探针按方案保留 |
| `_assist/state/` | delete | 曾随 `_assist` 进入 vault，复核后随 `_assist` 移回原位；仍未删除（#20 待执行） |

补做：`_diag/browser/older-evidence-20261116.tar.gz` 已按 #21 归档到 `_archive/workspace-20261121/_diag/browser/older-evidence-20261116.tar.gz`（7,979,669 B）。

修复建议（未执行，因要求不改脚本）：`inside()` 两侧统一 `path.resolve()`，或 `root` 改用 `path.win32.normalize`。

## 3. 手工条目（22 条）的处置

### 3.1 原地未动（10 条）

`scripts/check-reserve-manifest.ts`、`scripts/reverify-reserves.ts`、`scripts/replenish-reserve-candidates.ts`、`_diag/zcode-completion/`、`_diag/cleanup-and-verification-20261120/`、`_archive/diag-rounds-r18-r67-20261116.tar.gz`、`_archive/patches-20261030/`、`_archive/promo-videos/`、`_archive/source-registry-20261120/`、`.mimosa/hook-state/`

以上均经 `test -e` 逐个确认仍在原位。

### 3.2 曾随第 3 步整目录迁入 vault（12 条，复核后已原样移回）

第 3 步的移动清单以父目录形式给出了 `_assist`、`_archive/private`、`_archive/2026-11-03`、`_diag/t8/magpie-merge`、`_diag/t8/snap_c.out`、`_archive/evidence-rounds-20261010-13.tar.gz`，因此下列 manual 条目**被移动而非删除**。下表「实际」列是修订前状态；复核后这 12 条已按原路径移回工作区（vault 已清空，见页首）：

| manual 条目 | 方案意图 | 实际 |
| --- | --- | --- |
| `_assist/run-hidden.vbs` | delete | 随 `_assist` 进入 vault，未删 |
| `_diag/t8/magpie-merge/` | keep | 进入 vault（位置变更，内容完整） |
| `_assist/newbox/` | keep | 进入 vault（含 3 个 `.env.*`，未改动内容） |
| `_assist/local-executor/` | keep | 进入 vault（含 `.env.local-executor`、3.26 MB `worker.log`） |
| `_assist/geohot-assist.json` | keep | 进入 vault |
| `_archive/evidence-rounds-20261010-13.tar.gz` | keep | 进入 vault（未解包、未修改，185,595,717 B） |
| `_archive/2026-11-03/` | keep | 进入 vault（629 文件 / 10,900,873 B） |
| `_archive/private/` | keep | 进入 vault（34 文件 / 335,988 B） |
| `_archive/2026-11-03/_archive/.modelteam/ds-key-probe.mjs` | delete（先轮换后删） | 进入 vault，**未删**，轮换仍待办 |
| `_archive/2026-11-03/_archive/.modelteam/wb-cn-credential.json` | delete（先撤销后删） | 进入 vault，**未删**，撤销仍待办 |
| `_diag/t8/snap_c.out` | delete（先轮换后删） | 进入 vault，**未删**，轮换仍待办 |
| `_archive/private/geohot-assist.json` | delete | 进入 vault，**未删** |

这一处置符合第 3 步的显式指令，但**不等于完成了这 4 条 delete**：撤销/轮换动作一件都没做。复核后 12 条已全部移回原位，manual 队列回到「等站长逐条处理」的状态（见页首）。

## 4. 台账脱敏（第 2 步）

文件：`_diag/zcode-completion/conflict-ledger.csv`

- 脱敏前：252 行（1 表头 + 251 数据），md5 `ef63e01d…`；命中 `sk-` 3 处、`ak_` 1 处、`AQ.` 1 处、`password/secret/token` 赋值行 7 行
- 脱敏后：252 行（行数不变），全部行仍为 6 列，状态列分布 `verified=104` / `unconfirmed=147`（合计 251），**行与结论完整**
- 替换 6 处，替换标记：`<redacted len=11>`、`len=18`、`len=32`、`len=35`、`len=37`、`len=73`
- 其中 `len=18` 是误报：原串是 URL 片段 `risk-and-opportunity` 内的 `sk-and-opportunity`，被一并抹掉，只影响该处示例可读性，不影响结论
- 残留 1 处形似前缀：第 19 行 `disk-at-a-time` 中的 `sk-at-a-time`（总长 12，未达脚本 `{10,}` 阈值）。**已确认是普通英文词片段，不是凭据**，未处理
- 局限：脚本只覆盖 `sk-` / `ak_` / `AQ.` / `password|passwd|secret|token=` 四类，其它厂商前缀（`ghp_`、`xoxb-`、`AIza` 等）不在覆盖范围；本轮未额外扫描

## 5. Vault（第 3 步，**复核后已清空**）

- 路径：`D:\GEOHOT-SECURE-VAULT\20261121`
- （修订前）移动 6 项，共 **730 文件 / 200,753,358 B**，移动前后逐项比对文件数与字节数完全一致：

| 项 | 文件数 | 字节 |
| --- | --- | --- |
| `_diag/t8/magpie-merge` | 14 | 548,863 |
| `_diag/t8/snap_c.out` | 1 | 20,990 |
| `_assist` | 51 | 3,350,927 |
| `_archive/evidence-rounds-20261010-13.tar.gz` | 1 | 185,595,717 |
| `_archive/private` | 34 | 335,988 |
| `_archive/2026-11-03` | 629 | 10,900,873 |

- （修订前）工作区侧 6 个源路径均已不存在（逐条检查，无残留）；复核后 6 项已按原路径移回，vault 日期目录已删除
- 符号链接：`_archive/2026-11-03` 内 2 个 `node_modules` 链接是**绝对路径**（`/d/地理热点网站/GEOHOT/node_modules`），移动后仍可解析；`mv` 为同卷重命名，未跟随链接，18k 依赖文件未被卷入
- ACL（实测 `icacls`）：
  - 根：`NT AUTHORITY\SYSTEM:(OI)(CI)(F)`、`THINKBOOK16\理想与现实:(OI)(CI)(F)`，继承已移除
  - 子项（抽查 `.env.primary`）：仅上述两个主体，均为 `(I)(F)`，继承已生效
  - 注意：`/inheritance:r` 同时移除了 `Administrators` 组，管理员若需访问须先取得所有权

## 6. 仍未轮换 / 未撤销的凭据类型（只列类型，不写值）

本轮**未执行任何轮换、撤销或私钥口令变更**。以下类型仍以可用形态存在于工作区原位（复核后已从 vault 移回，见页首）：

1. **Magpie OAuth 凭据库**（`_diag/t8/magpie-merge`）：access token（3 份 plugin-auth 分别 39/50/49 个非空）、refresh token（37/46/45）、devicePrivateKey、deviceToken、`caller-keys` secret（62 字符，2 处副本）、`server-files.tar/.b64` 打包件；另有 3 份 logins 各 3 组 token。方案要求「先撤销/轮换，再收敛为一份，最后才谈删」
2. **`sk-` 模型 API key**：至少 3 枚不同值 —— K1（35 字符，`ds-key-probe.mjs`，台账称「真实可用」）、K3（51 字符，`snap_c.out`，与四份 `.env` 同值）、以及台账内嵌的 35/73 字符两枚；台账已脱敏但**密钥本身未轮换**
3. **`ak_` 与 `AQ.` 令牌**：各 1 枚，仅存在于已脱敏台账
4. **`_assist/newbox` 生产 env**：`SESSION_SECRET`(64)、`ADMIN_PASSWORD`(11)、`INGEST_TOKEN`(64)、`IMG_PROXY_SIGN_SECRET`(64)，另 `.env.executor`/`.env.providers` 含同一套与 2 枚 `sk-` 字面量
5. **`_assist/local-executor`**：`.env.local-executor` 内 40+ 供应商 `*_API_KEY`
6. **WorkBuddy 中国版凭据**：`accessToken`(1,335) + `refreshToken`(700)；方案称已过期，但仍应在 WorkBuddy 侧撤销该设备授权
7. **SSH 连接描述符**：2 份（`_assist/`、`_archive/private/` 各一），含生产 host、hostKeyAlias、identityFile 路径、localPort；**私钥是否设口令未验证**
8. 已轮换、无需再动：`_archive/evidence-rounds-…tar.gz` 内 2 份 `.env` 的 `ADMIN_PASSWORD/SESSION_SECRET/IMG_PROXY_SIGN_SECRET/INGEST_TOKEN`，方案注明与当前 `.env` 哈希不同（旧值）

## 7. 本次跑过的验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（7 个 tsc 工程 + web） | `npm run typecheck` | `EXIT=0`，无报错 |
| 删除文件是否仍被引用 | `git grep -n "ResetCalendar\|monitor/PostCard\|monitor/format"` | 0 命中 |
| 归档脚本是否仍被引用 | `git grep -n` 逐个查 `import-pricing-map`/`backfill-reasoning-tokens`/`deploy-reserve-guard`/`refresh-workflow-readiness`/`geohot-api-memory` | 均 0 命中 |
| `model-pool-dead` 残留引用 | `git grep -n model-pool-dead` | 4 处（`AGENTS.md:156` 与 `prune-model-pool.sh:8,12,17`），复核后 `:8,12` 注释已改成 `deploy/geohot/bin/model-pool-dead.txt`，不再指向已删的 `tooling/` 副本 |
| `.gitignore` 失效规则 | `git grep -n _assist/` | `.gitignore:68-69` 指向 `_assist/local-executor/*.log`，该目录在仓库外，规则本就空转，现状无害 |
| 台账结构 | 自写 node 脚本统计行/列/状态分布 | 252 行 / 6 列 / 104+147 |
| vault 完整性 | 移动前后 `find -type f` 计数与字节求和 | （修订前）730 文件 / 200,753,358 B，完全一致；复核移回后逐项计数与表内数字一致 |
| vault ACL | `icacls` 根与子项 | 仅 SYSTEM + 本机用户，子项 `(I)` 继承生效 |
| 是否产生提交 | `git log --oneline -3` | 仍为 `2e5edf22`，未提交、未 push |

## 8. 需要站长决定 / 后续动作

1. **修 `apply_cleanup.mjs` 的 `inside()`** 后重跑，处理 §2.2 的 3 个仍存在的目标（`_assist/state/` 已随 `_assist` 移回原位，仍需按 #20 删除）
2. **按 §6 完成轮换/撤销**，之后才可执行 4 条「先轮换后删」的 manual delete
3. `_archive/README.md:9,12,14` 对 `evidence-rounds…tar.gz`、`2026-11-03/`、`private/` 的描述在复核移回后重新成立，索引不再需要改
4. `prune-model-pool.sh:8,12` 的旧路径已在复核中改为 `deploy/geohot/bin/model-pool-dead.txt`
5. 本次分支上的 `AGENTS.md`、`README.md`、`industry/changelog.json` 修改与未跟踪的 `docs/PROJECT-MAP.md` **是本轮之前就存在的**工作区改动，未由本次清理产生，提交时请分开处理
