# 清理方案（CLEANUP-PLAN-20261121）

- 生成时间：2026-11-21
- 依据：`GEOHOT/docs/history/AUDIT-STRUCTURE.md`、`GEOHOT/docs/history/cleanup-candidates.json`、`docs/history/AUDIT-WORKSPACE.md`、`docs/history/workspace-inventory.json`、`docs/history/AUDIT-SECURITY.md`、`docs/history/security-findings.json`
- 基准：`git -C D:/地理热点网站/GEOHOT rev-parse HEAD` → `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3`（`main`，1290 个跟踪文件，本次复核）
- 本轮动作：**0 删除 / 0 移动 / 0 `git rm`**。只新增 `docs/history/CLEANUP-PLAN-20261121.md` 与 `docs/history/cleanup-plan.json` 两个方案文件。
- 机读版本：`docs/history/cleanup-plan.json`（41 条，字段 `path / scope / action / reason / evidence / risk / requiresManual`）

> **为什么写在 `D:/地理热点网站/docs/history/` 而不是 `GEOHOT/docs/history/`**：本方案点名了 `_assist/newbox/.env.primary`、`_diag/t8/magpie-merge/` 这类凭据文件的位置。`GEOHOT` 是公开仓库，`AUDIT-SECURITY.md:11` 已定下「这些路径不写进公开仓库 docs」的原则，本方案沿用。文中 `path` 的相对根因此分两种：`scope=repo` → `D:/地理热点网站/GEOHOT`，`scope=workspace` → `D:/地理热点网站`。

---

## 0. 一页结论

| 集合 | delete | archive | keep | 合计 |
|---|---:|---:|---:|---:|
| `cleanup-candidates.json` 原始 18 条（复算） | 7 | 8 | 3 | 18 |
| 本方案 baseline（应用修正 ③ 后） | **6** | **9** | **3** | 18 |
| 并入安全审计 / 工作区审计新发现 | 7 | 1 | 15 | 23 |
| **`cleanup-plan.json` 合计** | **13** | **10** | **18** | **41** |

其它分布（均由 JSON 复算，不是手抄）：`scope` repo 17 / workspace 24；`risk` low 16 / medium 15 / high 10；`requiresManual=true` **22** 条（delete 5 / archive 3 / keep 14），`false` 19 条。

复算命令（在 `D:/地理热点网站` 下执行，本次已运行）：

```
$ node -e "const d=require('./docs/history/cleanup-plan.json');const c=k=>d.items.reduce((a,x)=>(a[x[k]]=(a[x[k]]||0)+1,a),{});console.log(d.items.length,c('action'),c('scope'),c('risk'),c('requiresManual'))"
41 { delete: 13, archive: 10, keep: 18 } { repo: 17, workspace: 24 } { low: 16, medium: 15, high: 10 } { false: 19, true: 22 }
```

一句话：**仓库内有 17 条要动（3 个死组件 + 2 个同 blob 重复文件 + 9 条归档），工作区有 24 条（3 条低风险可执行 + 1 条归档 + 20 条只进人工决定）；真正需要先做的是「轮换凭据」和「先 unlink 再谈归档」，不是删文件。**

---

## 1. 并入的 5 条复核修正

| # | 原候选/审计的写法 | 本方案改为 | 依据 |
|---|---|---|---|
| ① | 候选 `path` 带 `GEOHOT/` 前缀；`_diag/...` 与仓库路径混在同一命名空间 | `scope=repo` 的 path **一律去掉 `GEOHOT/`**，执行时不得再拼前缀；`_diag/` 三条（`items-*.html`、`logs/*.log`、`browser/older-evidence…`）标 `scope=workspace`，相对 `D:/地理热点网站` | `cleanup-candidates.json` 第 15 条路径为 `_diag/...`，而工作区根不是仓库（`AUDIT-SECURITY.md:42-50`）；`AUDIT-STRUCTURE.md:399` 自述「仓库内文件带 `GEOHOT/` 前缀」 |
| ② | `geohot-api-memory.conf`：「不在 install-units.sh 的任何拷贝规则内……因此从未生效」 | **可删，但理由改为**：裸 `.conf` 不是合法 unit、systemd 不读；`deploy/geohot/deploy.sh:246-252` 会把 `systemd/` 下所有 `*.service/*.timer/*.conf` 按相对路径 `install` 到 `/etc/systemd/system/`，所以它**会被复制过去**，只是落在 `/etc/systemd/system/geohot-api-memory.conf` 这个无效位置；服务器残留需另行清理 | 本次复核：`deploy/geohot/deploy.sh:250` `install -D -m 644 "$f" "/etc/systemd/system/$rel"`、`:252` `find ... \( -name '*.service' -o -name '*.timer' -o -name '*.conf' \)`；`deploy/geohot/install-units.sh:116-129` 只装 `ALL_UNITS`、`:138-147` 只装 `*.<unit>.d/*.conf`；两者同 blob `24998690…` |
| ③ | `tooling/import-pricing-map.ts` → `delete`，risk low（理由：与 `pricing-seed.ts` 功能重复） | **改 `archive`**，risk low。它是**任意外部价卡 JSON 的唯一入口**（`tsx tooling/import-pricing-map.ts <extra.json>`）；`pricing-seed.ts:13` 只读仓库内 `map-A/B/C`，没有这个能力 | 本次复核：`tooling/import-pricing-map.ts:5-6` 用法、`:17-19` 读 `process.argv.slice(2)`；`pricing-seed.ts:13` `SEED_FILES = ['map-A.json','map-B.json','map-C.json']` |
| ④ | `#16 ci-check.yml`、`#17 assets/leaderboard-sources`、`#18 assets/model-providers` 曾被当成「同 blob 重复/与地理热点无关」的清理对象 | **三条一律 `keep`**，且都不算重复项。`ci-check.yml` 是 `AGENTS.md:23` 规定的双份；两个 assets 目录是 `NOTICE:37-41` 明写的「保留以便重新启用 + 商标署名」 | 本次复核 `diff .github/workflows/check.yml tooling/ci-check.yml` → `IDENTICAL`；`assets/leaderboard-sources` 14 文件、`assets/model-providers` 15 文件 |
| ⑤ | 汇总口径不一致 | **18 条按 JSON 复算 = 7 delete + 8 archive + 3 keep**（已亲自复算）。应用 ③ 后本方案为 **6 + 9 + 3**；并入后的总数见 §0，全部由 JSON 重算，不手抄 | `node` 复算：原始 18 条 `{delete:7, archive:8, keep:3}` |

> 另修正一处**事实性坑**（不改变动作）：`AUDIT-WORKSPACE.md:82` 说 `cleanup-and-verification-20261120/` 引用的 `artifacts/cleanup-audit.json` 不存在、该目录是「唯一存世副本」。本次实测该目录**自己就含 `cleanup-audit.json` 与 `cleanup-audit-summary.txt`**（19 项），所以正确表述是「引用的 `../artifacts/` 路径已失效，本目录内的副本是该轮审计仅存的记录」——结论仍是 keep，但依据要写对。

---

## 2. 仓库内候选（17 条）

**archive 的定义（全方案统一）**：移到 `D:/地理热点网站/_archive/repo-20261121/<原相对路径>`，仓库侧 `git rm` 并在同一提交写明去向。文件在 git 历史与 `_archive` 各留一份，可随时取回。

| # | path（相对 GEOHOT） | 动作 | 风险 | 人工 | 理由与证据 |
|---|---|---|---|:--:|---|
| 1 | `apps/web/app/features/monitor/ResetCalendar.tsx` | delete | low | – | 零 importer；路由已在 `35c9a56f` 删除，flag 改回 true 也挂不上。本次复核：`git grep -lF ResetCalendar` 只命中自己；`grep -iE "codex\|monitor" apps/web/app/routes.ts` rc=1；`docs/customize.md:97` 点名该目录可删 |
| 2 | `apps/web/app/features/monitor/PostCard.tsx` | delete | low | – | 只被 #1 引用（`ResetCalendar.tsx:5` import、`:266` 使用），必须与 #1 同一次提交删 |
| 3 | `apps/web/app/features/monitor/format.ts` | delete | low | – | 只被 #1/#2 引用；勿与仍在用的 `apps/web/app/lib/format.ts` 混淆。本次复核：`git grep -n -F "features/monitor"` 只命中 `docs/customize.md:97` |
| 4 | `deploy/geohot/systemd/geohot-api-memory.conf` | delete | low | – | 与 `geohot-api.service.d/memory-pressure.conf` 同 blob（`24998690…`，各 200 B）。**不是「不会被安装」**：`deploy/geohot/deploy.sh:246-252` 确实会把它复制成 `/etc/systemd/system/geohot-api-memory.conf`；问题在裸 `.conf` 不是合法 unit、systemd 不加载，`deploy/geohot/install-units.sh` 也从不装它（`:116-129`、`:138-147`）。服务器残留另行清理（未验证是否存在） |
| 5 | `tooling/model-pool-dead.txt` | delete | medium | – | 与 `deploy/geohot/bin/model-pool-dead.txt` 同 blob（`d4923749…`，各 770 B）；`prune-model-pool.sh:17` 只读 `$here` 那份。**执行时必须同提交改 `prune-model-pool.sh:12` 的注释**（现写「默认 tooling/…」，与代码不符，照注释传参会在 `:20` exit 1） |
| 6 | `tooling/import-pricing-map.ts` | **archive** | low | – | 外部价卡 JSON 的唯一入口（修正 ③）；`pricing-seed.ts` 只读仓库 seed。归档保住能力、退出日常代码面 |
| 7 | `tooling/backfill-reasoning-tokens.ts` | archive | low | – | 文件头自称一次性回填，迁移 `0125` 已落；全仓零引用 |
| 8 | `scripts/deploy-reserve-guard.ts` | archive | low | – | 仅为迁移 `0121` 的一次性前置检查；库已到 `0126_source_discovery.sql`（本次复核） |
| 9 | `scripts/refresh-workflow-readiness.ts` | archive | low | – | 13 行 CLI 壳，核心函数已由 `apps/worker/src/schedules.ts:3` 在正式调度里使用 |
| 10 | `scripts/check-reserve-manifest.ts` | archive | medium | ✔ | 零引用只读预检，但配套 `industry/source-reserves.json`（437,946 B）仍在用，是否还有人手工调用只有主人知道 |
| 11 | `scripts/reverify-reserves.ts` | archive | medium | ✔ | 零引用运维脚本，`--write` 会改 `industry/source-reserves.json`，可能仍被临时调用 |
| 12 | `scripts/replenish-reserve-candidates.ts` | archive | medium | ✔ | 同上：operator-only、默认 dry-run，调用是手工的 |
| 13 | `deploy/geohot/tmp/` | archive | low | – | 17 项，`git ls-files` = 0、`git log` = 0（从未跟踪）；`.gitignore:72` 自标一次性。只归档，不删 |
| 14 | `docs/major-release-20261024/` | archive | low | – | 4 文件 6 KB，3 个零引用（`browser-results.json` 仅同目录自引）；属发布验收证据，归档留痕 |
| 15 | `tooling/ci-check.yml` | **keep** | low | – | 与 `.github/workflows/check.yml` 逐字节相同，但 `AGENTS.md:23` 规定双份（发布 token 无 workflow 作用域）。**不是重复项** |
| 16 | `assets/leaderboard-sources/` | **keep** | medium | – | 只服务已关停的模型榜，但 `NOTICE:37-41` 写明「保留以便上游模块被重新启用」+ 商标署名；清理须同步改 NOTICE |
| 17 | `assets/model-providers/` | **keep** | medium | – | 同上（14 个商标，`NOTICE:10-11`、`:38`） |

---

## 3. 工作区并入候选（24 条）

### 3.1 可执行（`requiresManual=false`，4 条）

| # | path（相对 D:/地理热点网站） | 动作 | 风险 | 理由与证据 |
|---|---|---|---|---|
| 18 | `_diag/items-h8nme0fprk1uf1u8dbhfz53k5.html` | delete | low | 三份 `items-*.html` 是同一抓取的重复落盘。本次复核 `md5sum` → 三份均 `e072c3feff88be1c32aaba94bceb1283`；删一份、留另外两份即可 |
| 19 | `_diag/logs/*.log` | delete | low | 110 个 `assist-trial1..N.log`，本次复核字节和 1,503,327；该目录 `grep -rlE 'Bearer\|Cookie:\|password='` → 0 命中（`AUDIT-WORKSPACE.md:80`）。**只删 `*.log`**：同目录 8 个 `.mjs/.sh` 探针是 keep，按整目录删会带走它们（`ls _diag/logs` → 118 项） |
| 20 | `_assist/state/` | delete | low | 22 个 `assist-child-*.log` + 3 个 `extraction-assist.lock.stale-*`；本次复核 25 文件；worker pid 1723 不在运行（`AUDIT-WORKSPACE.md:99`） |
| 21 | `_diag/browser/older-evidence-20261116.tar.gz` | archive | low | 7.98 MB 旧证据包，归档到 `_archive` 即可。**不要动同目录 17 个探针脚本** |

### 3.2 只进人工决定（`requiresManual=true`，19 条，其中 high 10 条）

| # | path | 动作 | 风险 | 需要的决定 / 前置 |
|---|---|---|---|---|
| 22 | `_assist/run-hidden.vbs` | delete | medium | 启动目标已不存在、链已断，但隐藏窗口 + `ExecutionPolicy Bypass`；**先确认无计划任务/启动项**（本轮未跑 `schtasks`） |
| 23 | `_diag/t8/magpie-merge/` | keep | **high** | 完整 Magpie OAuth 凭据库（39/50/49 access、37/46/45 refresh、3/4/4 devicePrivateKey、caller secret、`server-files.tar/.b64`）。顺序：**撤销/轮换 → 三份收敛为一份并移出 `_diag` → 再删打包件**。本轮不删任何一份 |
| 24 | `_diag/zcode-completion/` | keep | **high** | `conflict-ledger.csv` 证据列内嵌可用 key（sk- 35/73 字符、`ak_`、`AQ.`、4 处 `password=`）。不整份删（取证价值），**先就地脱敏 + 轮换 4 枚 key**，再谈归档 |
| 25 | `_diag/cleanup-and-verification-20261120/` | keep | medium | 11-20 那轮清理/验证的仅存台账（`cleanup-audit.json`、`cleanup-audit-summary.txt`、`final-*.txt`）；引用路径 `../artifacts/` 已失效 |
| 27 | `_assist/newbox/` | keep | **high** | `.env.primary` 自述生产 env，含 `SESSION_SECRET`(64)/`ADMIN_PASSWORD`(11)/`INGEST_TOKEN`(64)/`IMG_PROXY_SIGN_SECRET`(64)。**.env 类不删**；先在服务器轮换并验证，再决定整目录去留 |
| 28 | `_assist/local-executor/` | keep | **high** | `.env.local-executor` 含 40+ 供应商 key；`worker.log` 3.26 MB 与凭据相邻。worker 已停，轮换前不动 |
| 29 | `_assist/geohot-assist.json` | keep | **high** | SSH 描述符（生产 host + identityFile + 转发端口）；运行时若还要读就保留；私钥无口令应补口令 |
| 30 | `_archive/evidence-rounds-20261010-13.tar.gz` | keep | **high** | 185,595,717 B / 5,232 条目，`_archive/README.md:9` 标唯一副本；包内 `.env` 是**已轮换的旧值**。删前先异地备份 + `tar -tzf` 核数；更稳是剔除 `.env` 后重归档 |
| 31 | `_archive/diag-rounds-r18-r67-20261116.tar.gz` | keep | medium | 181,735,490 B / 10 条目（嵌套压缩），未解包核对；唯一留痕，先备份 |
| 32 | `_archive/2026-11-03/` | keep | **high** | 两个 symlink 指向 `GEOHOT/node_modules`：跟随式递归删除会带走 18,117 个依赖文件。**先 `unlink` 再谈处置** |
| 33 | `_archive/patches-20261030/` | keep | medium | 11 个 `.patch`，`stash0-full` 标唯一副本；是否已合并未验证 |
| 34 | `_archive/promo-videos/` | keep | medium | 2 个 mp4（23 MB）；`_archive/README.md:13`「不用了就能删」——只有站长能定 |
| 35 | `_archive/source-registry-20261120/` | keep | medium | PG 全库 dump + preflight；写入晚于 `_archive` 目录本身，违反冷档规则（R6）；先定性再决定放哪 |
| 36 | `_archive/private/` | keep | medium | SSH 日日志 + PR 正文 + 旧描述符；PR 正文是否还有用需站长判断 |
| 37 | `.mimosa/hook-state/` | keep | medium | 本轮实测 28,416 文件 / 26 个 baseline，仍在增长；被运行中的钩子写入，**不能整目录删**，只能按已结束会话清理；需要的是保留策略 |
| 38 | `_archive/2026-11-03/_archive/.modelteam/ds-key-probe.mjs` | delete | **high** | 【先轮换 K1 后删】402 B，写死 35 字符 sk- 字面量 |
| 39 | `_archive/2026-11-03/_archive/.modelteam/wb-cn-credential.json` | delete | **high** | 【先撤销设备授权后删】2,534 B，access/refresh token 导出件（均已过期） |
| 40 | `_diag/t8/snap_c.out` | delete | **high** | 【先轮换 K3 后删】20,990 B 截屏，含与四份 `.env` 同值的 51 字符 sk- |
| 41 | `_archive/private/geohot-assist.json` | delete | medium | 204 B 旧 SSH 描述符副本；确认无流程在读后删 |

### 3.3 无需执行（keep，`requiresManual=false`，1 条）

| # | path | 动作 | 风险 | 理由与证据 |
|---|---|---|---|---|
| 26 | `_diag/tmp/_keep/` | keep | low | `_keep` 是刻意标记：`aboutrss.md` 256 KB、`local-models.json` 32 KB、3 份 feed 清单。`AUDIT-WORKSPACE` 初稿误判 delete，已纠正（`AUDIT-WORKSPACE.md:85`）；本次复核 6 个文件 |

> 未并入 JSON 的同批建议：`_diag/browser/` 下 13 个运行目录（39.3 MB）与 `nodes-check-server.png`，以及 `_diag/t9、t11、t12、t13、mcp、archive-20261116`、`_diag` 顶层 50 个散落文件（合计约 1.7 MB）——`workspace-inventory.json` 给的是 archive，但价值在留痕、不在腾空间，且需逐个列名以免连带 17 个探针脚本。列为**可选批次**，不占本方案的执行位。

---

## 4. 人工决定队列（22 条，执行脚本不得自动处理）

优先级按「泄露面 × 不可逆性」排序：

1. **凭据轮换（今天）**：`_diag/t8/magpie-merge/`（#23）、`_assist/newbox/`（#27）、`_assist/local-executor/`（#28）——先把 OAuth refresh / device 授权、4 个生产口令、2 个 51 字符模型 key、`ak_`、caller secret 全部轮换并验证生效。**轮换前不删任何一份**，否则会失去「哪些值要作废」的对照。
2. **台账脱敏（今天）**：`_diag/zcode-completion/conflict-ledger.csv`（#24）就地替换 key 为 `<redacted len=N>`。
3. **三个高危小文件（轮换后）**：#38 / #39 / #40 / #41。
4. **不可逆归档（本周）**：#30 / #31 / #33 先异地备份并核数；#32 先 `unlink` 两个 symlink，再决定整目录处置。
5. **运维脚本去留（本周）**：#10 / #11 / #12 需仓库主人确认是否还有人手工调用。
6. **环境、缓存与生命周期（本周）**：#22（`schtasks` 确认）、#25 / #29 / #34 / #35 / #36、#37（按会话清理 + 设保留策略）。

---

## 5. 明确排除：本方案不提出删除的

按任务约束整类排除，**一条都没进 delete**：

| 类别 | 实例 | 说明 |
|---|---|---|
| `.env` 类 | `GEOHOT/.env`、`.env.deepseek`、`.env.pipeline`、`.env.step5`、`.env.wbprobe`、`.env.ports`、`_assist/newbox/.env.*`、`_assist/local-executor/.env.local-executor` | 只轮换、只限权、只移出工作区 |
| 数据/运行态 | `GEOHOT/.data/`、`GEOHOT/.pgdata/`、`GEOHOT/node_modules/`、各 `apps/*/node_modules`、`.git/` | 本机 Postgres 簇与依赖宿主；#32 的 symlink 正指向它 |
| 迁移与行业数据 | `GEOHOT/database/migrations/`（121 个 SQL，到 `0126`）、`GEOHOT/industry/`（信源/选题/`source-reserves.json`） | 迁移的删除属另一类变更，不在清理范围 |
| 运行时/构建产物 | `apps/*/build`、`apps/web/.react-router`、`packages/*/node_modules` 等 | 本方案对 `apps/` 只动 `features/monitor/` 三个**源码**死文件（`docs/customize.md:97` 授权），不碰任何运行时文件 |
| 已判定 keep | `tooling/ci-check.yml`、`assets/leaderboard-sources/`、`assets/model-providers/`、`_diag/tmp/_keep/`、`_diag/logs/*.mjs/sh`、`_diag/browser/*.mjs`、`_diag/browser-audit/`、`.mimosa/finding-ledger|hook-status`、`.zcode/workflow-runs/.gitignore` | 见 §2/#15-17、§3 |
| 仓内长期资料 | `GEOHOT/docs/research/`（42 篇成链）、`GEOHOT/docs/promo/`（两条在用 mp4）、`_archive/README.md`、工作区 `README.md` | `AUDIT-STRUCTURE.md:361-371` |

---

## 6. 执行顺序（只排 `requiresManual=false` 的 19 条；其中 15 条是 delete/archive 动作，4 条是 keep 无需执行）

**Batch 0 · 预检**

```
git -C D:/地理热点网站/GEOHOT status --short
git -C D:/地理热点网站/GEOHOT rev-parse HEAD          # 期望 2e5edf22…
git -C D:/地理热点网站/GEOHOT ls-files | wc -l        # 期望 1290
```

本次预检实测 `git status --short` 已有与清理无关的改动：` M AGENTS.md`、` M README.md`、` M industry/changelog.json`、`?? docs/PROJECT-MAP.md`、`?? docs/history/`。清理提交**不得**把它们混进来。

**Batch 1 · 零争议删除（仓库 2 条）**：#4、#5（#5 附带 `prune-model-pool.sh:12` 注释修正）。

**Batch 2 · monitor 死组件（仓库 3 条）**：#1 → #2 → #3 一次提交，然后：

```
cd D:/地理热点网站/GEOHOT && npm run typecheck && npm test
```

**Batch 3 · 仓库归档（6 条）**：#6、#7、#8、#9、#13、#14。`scripts/`、`tooling/` 的 `tsconfig.json` 都是 `"include": ["*.ts"]`（本次已读），移走文件不会让 `tsc -p` 失败；归档后仍要重跑一次 `npm run typecheck`。

**Batch 4 · 工作区低风险（4 条）**：#18、#19、#20、#21。#19 用 `rm _diag/logs/*.log`（**不要** `rm -rf _diag/logs`）。

**Batch 5 · 人工队列**：按 §4 顺序，逐条由人确认后执行。

### 验收命令（**本次一条都未运行**，仅作为执行后的门禁）

| 检查 | 命令 | 本次状态 |
|---|---|---|
| 类型检查 | `cd D:/地理热点网站/GEOHOT && npm run typecheck` | **未运行** |
| 测试 | `cd D:/地理热点网站/GEOHOT && npm test` | **未运行** |
| web 构建 | `cd D:/地理热点网站/GEOHOT && npm run build -w @aihot/web`（`apps/web/package.json` 的 `build` = `react-router build`，本次已读） | **未运行** |
| 死代码复核 | `git grep -lF "features/monitor"`（应只剩 `docs/customize.md:97`） | 本次已跑（当前状态） |
| 归档完整性 | `tar -tzf` 不得用于归档目录；用 `find _archive/repo-20261121 -type f \| wc -l` 比对 `git show --stat HEAD` 的文件数 | **未运行** |
| 服务器残留 | `ssh … 'ls -l /etc/systemd/system/geohot-api-memory.conf'` | **未运行**（无服务器访问） |

---

## 7. 风险与未验证项（如实记录）

1. **`geohot-api-memory.conf` 的服务器残留未验证**。`deploy.sh` 会把它复制到 `/etc/systemd/system/`，但 systemd 不加载裸 `.conf`；服务器上是否真的存在该文件、存在了多久，本轮无服务器访问，**未确认**。仓库删除不影响服务器，反之亦然。
2. **`model-pool-dead.txt` 的注释不一致**。#5 若只删文件不改 `prune-model-pool.sh:12` 注释，下一位操作员按注释传参会在 `:20` 直接 exit 1。
3. **symlink 穿透**。#32 的 `_archive/2026-11-03/` 按不跟随是 10.9 MB，按跟随是 900,315,807 B（`AUDIT-WORKSPACE.md:158-172`）。任何 `Remove-Item -Recurse` / `robocopy /MIR` / 跟随式归档都可能清空 `GEOHOT/node_modules`。本方案对它只给 keep。
4. **`.mimosa/hook-state` 在增长**。本次实测 28,416 文件 / 26 个 baseline（`AUDIT-WORKSPACE.md` 11:05 为 24,040 / 22），仍在被写入；按会话清理必须先确认 actor 结束，否则会打断运行中的 workflow。
5. **未运行构建/测试**。删除 `features/monitor/` 后 `typecheck`、`build` 是否仍绿，本轮**没有运行证据**，结论仅来自「无 importer + 无 glob + 无 barrel」。执行 Batch 2 的人必须补跑。
6. **未运行 `schtasks`**。`_assist/run-hidden.vbs` 是否被计划任务/启动项引用，仅有 `README.md:12` 的「没有相关计划任务」声明（`AUDIT-WORKSPACE.md:189`、`:277` 均记该声明未经核实）。
7. **tarball 内部未穷举**。`evidence-rounds`（5,232 条目）只流式看过 3 个 `.env` 条目；`diag-rounds`（10 条目）与 `older-evidence`（33 条目）未解包。包内是否另有明文凭据**未验证**。
8. **凭据是否仍有效未验证**。所有「需轮换」都基于「明文 + 多副本」的保守判断，未调用任何真实服务验证（`AUDIT-SECURITY.md:519`）。
9. **archive 的语义**。本方案把「归档」定义为「移出活动树 + 外部留一份 + git 历史留一份」，不是 `git mv` 到仓库内的 `archive/` 目录（那样仍留在代码面，且相对 import 会断）。执行时请统一按这个定义，避免一半人移到 `docs/history/`、一半人移到 `_archive/`。

---

## 8. 与上一轮清理（2026-11-20）的关系

- 上一轮已按计划移除 4 个 worktree（`GEOHOT-docs-admin-usage-20261117`、`GEOHOT-reader-capacity-20261118`、`GEOHOT-security-sanitize-20261118`、`GEOHOT-deploy`）与 `_shots`、`_verify`、`geohot-daily-links`、`index.html`（`AUDIT-WORKSPACE.md:241-248` 逐项 `[ -e ]` → ABSENT）。
- 但 `_assist` 明文凭据与 `_diag/t8/magpie-merge` 凭据库**原封未动**，且新增的 `source-registry-20261120/` 又直接写进了冷档（R6）。所以本方案的重心不是「再删多少」，而是**先把凭据面收口**。
- `.mimosa/hook-state` 曾在 2026-11-04 从 880,136 文件清到 0（`_diag/sweep-local.md:15`），两周后长回 28,416 文件——这说明一次性清理对它无效，需要的是保留策略。

---

## 附：机读清单字段说明

`docs/history/cleanup-plan.json` 顶层含 `generatedAt`、`basis`（HEAD/跟踪文件数/六个来源）、`conventions`（path 根与 archive 语义）、`items`（41 条）。每条：

```json
{"path": "...", "scope": "repo|workspace", "action": "delete|archive|move|keep",
 "reason": "...", "evidence": "...", "risk": "low|medium|high", "requiresManual": true}
```

`move` 在本方案中未使用：所有「换位置」都表达为 `archive`（有明确目的地），避免执行者自行发挥。
