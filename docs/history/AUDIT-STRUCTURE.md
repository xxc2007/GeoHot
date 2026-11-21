# 结构与冗余审计（AUDIT-STRUCTURE）

- 审计时间：2026-11-21 10:10–11:20（北京时间）
- 审计对象：`D:\地理热点网站`（工作区）与其唯一活跃仓库 `D:\地理热点网站\GEOHOT`
- 基准：`git -C D:/地理热点网站/GEOHOT rev-parse HEAD` → `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3`（`main`，1290 个跟踪文件）
- 审计方式：**只读**。只执行 `git ls-files` / `git ls-tree` / `git grep` / `git log` / `git hash-object` / `git status` / `diff` / `md5sum` / `wc` / `ls` / `head` / `cat`，以及两个我写在仓库外的分析脚本（见第 2 节）。
- 未执行：删除、移动、`git add`/`commit`/`clean`/`reset`、`npm ci`/`typecheck`/`test`/`build`、任何数据库或部署命令。**因此本文所有结论都是静态引用图 + 字节比对，不含“删掉后构建仍通过”的运行证据。**

---

## 1. 结论（一句话）

仓库的**模块层**（`apps/` 169 + `packages/` 205 = 374 个非测试 .ts/.tsx/.mjs）几乎没有死文件：`refs:0` 的只有一个 3 文件小簇，是「Codex 重置监控」这个 AI 专属模块关停后剩下的孤儿组件（第 4 节）。真正的冗余集中在**运维与材料层**：7 组逐字节相同的文件、9 个全仓无人命名的条目（第 5、6 节），以及 `deploy/geohot/tmp/` 与 `docs/major-release-20261024/` 这类一次性产物（第 7、8 节）。**没有发现任何“与地理热点无关就可以删”的大块源码**——反例是 `assets/leaderboard-sources/`、`assets/model-providers/`，它们虽然只服务已关停的模型榜，但 `NOTICE:37-41` 明确写着「保留以便上游模块被重新启用」，属刻意保留（第 9 节）。

---

## 2. 判定方法（可复现）

### 2.1 为什么不能只靠“文件名搜不到”

本仓库有三类「名字搜不到但必须留」的文件，必须逐类排除，否则会误报：

| 类别 | 实例 | 证据 |
|---|---|---|
| 被 glob 整体安装 | `deploy/geohot/systemd/**/*.service.d/*.conf` 全部由 `install-units.sh` 用 `for d in "$TEMPLATE_DIR"/*.service.d` + `for f in "$d"/*.conf` 批量拷贝，仓库里**从不逐个点名** | `deploy/geohot/install-units.sh:138`、`:142` |
| 被测试按路径断言 | `deploy/geohot/public-cache.conf`、`deploy/geohot/nginx/*.conf` | `apps/web/tests/cache.test.ts:87`、`tests/nginx-admin-admission.test.ts:5-6` |
| 运行时按路径读取 | `reference/public-v1.openapi.json`、`assets/og-fonts/*.ttf`、`tooling/fixtures/*.jsonl` | `apps/api/src/routes/static.ts:107`、`apps/api/src/og/render.ts:31-32`、`.env.pipeline.example:25` + `deploy/geohot/DEPLOYMENT.md:308` |

**结论：`refs:0` 只是「候选信号」，不是「可删」的充分条件。** 本节之后的每一条候选都另外附了运行方式或历史证据。

### 2.2 实际跑过的引用扫描

仓库有 1290 个跟踪文件，逐个 `git grep` 太慢（Windows 上单个 `git grep` 约 40 倍于一次全库扫描）。我写了两个**只读**分析器，放在仓库外的临时目录（`C:\Users\理想与现实\AppData\Local\Temp\audit-structure\`），输入是 `git ls-tree -r HEAD` 的 blob 列表：

```
node <temp>/scan.mjs <候选文件…>      # 一次读全库 blob，建 "@@FILE@@<path>" 语料后按文件名主干定位
bash <temp>/scan_refs.sh <列表文件>   # 纯 git grep -l -F 逐文件版，用作交叉验证
```

第一版 `scan.mjs` 有一个**文件归属 bug**（把文件名标记串里的匹配算给上一个文件），已在本次审计中修正并复核：修正前 `deploy/geohot/systemd/geohot-api.service.d/memory-pressure.conf` 报 `refs:1`，修正后为 `refs:0`，与 `git grep` 一致。**本文所有数字都取自修正后的版本，并用 `git grep` 抽样复核过。**

交叉验证命令（最终结论就来自这一条，逐个文件打印“命中文件数 + 命中文件”）：

```
while IFS= read -r f; do
  stem=$(basename "$f"); stem="${stem%.*}"
  printf "n=%s  %-58s %s\n" "$(git grep -l -F "$stem" | wc -l)" "$f" "$(git grep -l -F "$stem" | tr '\n' ' ')"
done < candidates.txt
```

> 已知局限：按「文件名主干」匹配会把同名不同目录的东西混在一起（例如 `format.ts` 在 `n=` 统计里命中 131 个文件，因为 `from "./format"` 在仓库里到处都是）。这种泛化名一律改用**精确路径串**复核（`git grep -F "features/monitor/format"`），第 4.1 节的表述即按此口径写。

### 2.3 字节比对口径

```
git hash-object <file>                         # 取 blob SHA
git ls-tree -r HEAD | awk '{print $3"\t"$4}' | sort | \
  awk -F'\t' '{h[$1]=h[$1]" "$2; c[$1]++} END{for(k in c) if(c[k]>1) print c[k]"\t"h[k]}'
```

全库只有 7 组同 blob，见第 5 节。

---

## 3. 仓库形状

```
$ git -C D:/地理热点网站/GEOHOT ls-files | wc -l
1290
$ git -C D:/地理热点网站/GEOHOT ls-files | awk -F/ 'NF>1{print $1}' | sort | uniq -c | sort -rn
    268 tests      212 apps       210 packages    145 deploy
    127 database    98 docs        67 scripts      56 tooling
     53 industry    33 assets       2 .github      1 reference      1 .claude
```

根部另有 14 个单文件（`package.json`、`package-lock.json`、`docker-compose.yml`、`Dockerfile`、`AGENTS.md`、`CLAUDE.md`、`README.md`、`README.en.md`、`NOTICE`、`LICENSE`、`SECURITY.md`、`tsconfig.base.json`、`.gitignore`、`.gitattributes`、`.dockerignore`、`.env.example`、`.env.pipeline.example`）。

工作树状态（审计开始与结束各查一次，无变化）：

```
$ git -C D:/地理热点网站/GEOHOT status --short
?? docs/history/
```

`docs/history/` 是未跟踪的审计产物目录（`COMMIT-LEDGER.md`、`ERA-01..04.md`、`AUDIT-CHANGELOG.md`、`AUDIT-DEPLOYABILITY.md`、`AUDIT-SYNC.md`，以及本文件）。**它不是冗余，是交付物。**

### 3.1 空文件

```
$ git ls-files > /tmp/gl.txt
$ find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.pgdata -prune \
       -o -type f -empty -print | grep -F -x -f <(sed 's|^|./|' /tmp/gl.txt)
（无输出）
```

1290 个跟踪文件里**没有空文件**。

---

## 4. 发现 A：唯一的死代码簇 —— `apps/web/app/features/monitor/`（3 文件）

### 4.1 事实

| 文件 | 谁引用了它 |
|---|---|
| `apps/web/app/features/monitor/ResetCalendar.tsx`（291 行） | **无**。`git grep -lF "ResetCalendar"` 只命中它自己 |
| `apps/web/app/features/monitor/PostCard.tsx` | 只有 `ResetCalendar.tsx:5` |
| `apps/web/app/features/monitor/format.ts` | 只有同簇的 `PostCard.tsx:7`、`ResetCalendar.tsx:6`；全仓**没有** `features/monitor/format` 这个路径串 |

补充排除「动态加载」这条退路：

```
$ git grep -n "import.meta.glob"        （无输出）
$ git grep -n "export \* from" apps/web/app   （无输出）
$ git grep -n -F "features/monitor"
docs/customize.md:97:…`apps/web/app/features/monitor/`…
```

即：没有 glob 导入、没有 barrel re-export，静态 import 图就是完整答案。

### 4.2 为什么它是死代码，而不是「关掉待用」

`industry/features.ts:10` 把 `codexResetMonitor` 设为 `false`（同文件 `:3` 写明「模型榜与 Codex 重置监控都是 AI 专属模块，地理站无意义」，`:8` 的 `leaderboard` 同样为 `false`）。但**光有关闭还不够**——

```
$ git log --oneline --diff-filter=D -3 -- 'apps/web/app/routes/codex*'
35c9a56f feat(admin): add live model usage overview and retire Codex reset controls
apps/web/app/routes/codex-reset.tsx
```

`35c9a56f` 删掉了 `apps/web/app/routes/codex-reset.tsx`（254 行）与 `apps/web/app/routes/admin/monitor.tsx`（338 行），并改了 `apps/web/app/routes.ts`。当前 `apps/web/app/routes.ts`（66 行）里 `codex` / `monitor` 一个都不剩：

```
$ grep -n -i -E "codex|monitor" apps/web/app/routes.ts; echo "rc=$?"
rc=1
```

所以：**即使把 `codexResetMonitor` 改回 `true`，这个组件也没有路由能挂上去**。它和 `NOTICE:37-41` 说的「保留以便重新启用」不是一回事——`NOTICE` 那段说的是 `assets/` 里的商标图，页面本身已经删了。

`docs/customize.md:97` 恰好点名了这个目录：「想彻底删掉代码，删这些目录并处理掉编译错误即可：… `apps/web/app/features/monitor/` …」。也就是说仓库自己的文档把它列为**可删**，只是没人真删。

### 4.3 候选

- `ResetCalendar.tsx` → **delete**，risk **low**
- `PostCard.tsx` → **delete**，risk **low**（随上一条；单独删会先让 `ResetCalendar.tsx:5` 编译失败）
- `format.ts` → **delete**，risk **low**（同上；注意 `apps/web/app/lib/format.ts` 是另一个活文件，别删错）

> 未验证：本次**没有**跑 `npm run typecheck` / `npm run build -w @aihot/web`。上述「删了不破编译」的结论来自「无任何 importer + 无 glob + 无 barrel」，不是编译器输出。

---

## 5. 发现 B：逐字节重复的 7 组文件

```
$ git ls-tree -r HEAD | awk '{print $3"\t"$4}' | sort | \
  awk -F'\t' '{h[$1]=h[$1]" "$2; c[$1]++} END{for(k in c) if(c[k]>1) print c[k]"\t"h[k]}' | sort -rn
4   apps/api/tsconfig.json apps/worker/tsconfig.json packages/backend/tsconfig.json packages/contracts/tsconfig.json
3   industry/tsconfig.json tests/tsconfig.json tooling/tsconfig.json
2   deploy/geohot/systemd/geohot-api.service.d/99-pool-recovery-20261024.conf deploy/geohot/systemd/geohot-worker.service.d/99-pool-recovery-20261024.conf
2   deploy/geohot/systemd/geohot-api.service.d/90-magpie-server.conf deploy/geohot/systemd/geohot-worker.service.d/90-magpie-server.conf
2   deploy/geohot/systemd/geohot-api-memory.conf deploy/geohot/systemd/geohot-api.service.d/memory-pressure.conf
2   deploy/geohot/bin/model-pool-dead.txt tooling/model-pool-dead.txt
2   .github/workflows/check.yml tooling/ci-check.yml
```

逐组判定：

| 组 | 判定 | 依据 |
|---|---|---|
| 4× / 3× `tsconfig.json` | **正常** | 都是只有 `extends` + `include` 的薄壳（实测 `apps/api/tsconfig.json` 与 `tests/tsconfig.json` 各 4 行），内容相同是必然；root `typecheck` 明确 `tsc -p` 了 contracts/backend/api/worker/tests/scripts/tooling 七份（`package.json` 的 `typecheck` 脚本）。唯一例外是 `industry/tsconfig.json`：它不在 `typecheck` 链里，属轻微冗余，但只是一份 4 行配置，不列为候选 |
| `99-pool-recovery-20261024.conf` ×2、`90-magpie-server.conf` ×2 | **正常** | 同一个 drop-in 要装给 api 和 worker 两个 unit；`install-units.sh:138` 按目录整体拷，两份都必须存在 |
| `geohot-api-memory.conf` = `geohot-api.service.d/memory-pressure.conf` | **候选**（见 5.1） | 同一 unit 的同一段配置放了两处，且其中一处根本不会被安装 |
| `bin/model-pool-dead.txt` = `tooling/model-pool-dead.txt` | **候选**（见 5.2） | 脚本只读 `$here` 那份 |
| `.github/workflows/check.yml` = `tooling/ci-check.yml` | **保留**（见 5.3） | 文档明确规定双份 |

### 5.1 `deploy/geohot/systemd/geohot-api-memory.conf`

```
$ git hash-object deploy/geohot/systemd/geohot-api-memory.conf \
                   deploy/geohot/systemd/geohot-api.service.d/memory-pressure.conf
24998690f08bc8a6541ebb7549cc094b90ff8fbe
24998690f08bc8a6541ebb7549cc094b90ff8fbe
$ git grep -n "geohot-api-memory"; echo "rc=$?"
rc=1
```

两条事实叠加才构成证据：

1. 内容与 `geohot-api.service.d/memory-pressure.conf` **完全同一 blob**（200 字节）；
2. 它躺在 `systemd/` 根目录，而 `install-units.sh` 只装 `systemd/<unit>.service|.timer` 和 `systemd/*.service.d/*.conf`——**根目录下的裸 `.conf` 不在任何一条拷贝规则里**（`install-units.sh:116-129` 装 unit，`:138-147` 装 drop-in，`:153-161` 只额外装 `archive-cycle.conf.example`）。所以它既不会被安装、也没有任何文本引用。

→ **delete**，risk **low**（保留 `geohot-api.service.d/memory-pressure.conf`，那是真正被安装的那份）。

> 注意反面：`deploy/geohot/systemd/geohot-api.service.d/99-pool-recovery-20261024.conf` 同样 `git grep` 零命中，但它**在 `*.service.d/` 下**，会被 `:138` 整体安装 → 不能删。这是本节唯一容易搞错的地方。

### 5.2 `tooling/model-pool-dead.txt`

```
$ diff deploy/geohot/bin/model-pool-dead.txt tooling/model-pool-dead.txt && echo IDENTICAL
IDENTICAL
$ git hash-object deploy/geohot/bin/model-pool-dead.txt tooling/model-pool-dead.txt
d492374907c09145a397c9ccd6a1858f00bcad59
d492374907c09145a397c9ccd6a1858f00bcad59
$ wc -c deploy/geohot/bin/model-pool-dead.txt tooling/model-pool-dead.txt
770 deploy/geohot/bin/model-pool-dead.txt
770 tooling/model-pool-dead.txt
```

消费者只有一个：`deploy/geohot/bin/prune-model-pool.sh:17` → `dead_file="${1:-$here/model-pool-dead.txt}"`，默认取**脚本同目录**那份。`AGENTS.md:147` 也把 `deploy/geohot/bin/model-pool-dead.txt` 写成正式清单路径。

`tooling/` 那份的唯一“存在理由”是 `prune-model-pool.sh:8` 与 `:12` 两行注释里提到了 `tooling/model-pool-dead.txt`——**注释与代码不一致**（代码根本不读 tooling 路径）。

→ **delete**，risk **medium**：如果操作员按注释显式传 `tooling/model-pool-dead.txt` 当第一个参数，删掉会 `exit 1`（`prune-model-pool.sh:20`）。保守做法是**同时把 `:8`、`:12` 两行注释改成 `deploy/geohot/bin/model-pool-dead.txt`**——那属于改代码，本轮只读，没做。

### 5.3 `.github/workflows/check.yml` = `tooling/ci-check.yml` —— 明确不是冗余

```
$ diff .github/workflows/check.yml tooling/ci-check.yml && echo IDENTICAL
IDENTICAL
$ git grep -n "ci-check" AGENTS.md
AGENTS.md:23:- CI 定义有两份且逐字节同步：发布可写的正本在 `tooling/ci-check.yml`，Actions 实际执行的是 `.github/workflows/check.yml`；改 CI 两处同改。
```

原因写在 `deploy/geohot/publish-to-github.sh:16-17`：发布用的 token 没有 `workflow` 作用域，推 `.github/workflows/*` 会被 GitHub 拒绝，所以正本搬到 `tooling/`。**这份重复是设计，不要“去重”。**

---

## 6. 发现 C：全仓无人命名的 9 个条目（8 个脚本 + 1 个组件）

用第 2.2 节的循环逐个核过，结果只有这 9 个（`n=0` 表示连自己都没有文本命中，`n=1` 表示只命中自己）：

```
n=1  apps/web/app/features/monitor/ResetCalendar.tsx   → 第 4 节
n=1  scripts/check-reserve-manifest.ts
n=1  scripts/deploy-reserve-guard.ts
n=0  scripts/refresh-workflow-readiness.ts
n=1  scripts/replenish-reserve-candidates.ts
n=1  scripts/reverify-reserves.ts
n=1  tooling/backfill-reasoning-tokens.ts
n=1  tooling/import-pricing-map.ts
n=1  deploy/geohot/bin/install-exec-tunnels.sh
```

对照：`scripts/` 里另外 57 个 `.ts/.mjs` 全部至少有 1 处外部引用（`package.json` 的 scripts、deploy 脚本、systemd 单元、tests 或 docs），**这 5 个是唯一的例外**。

### 6.1 一次性/被取代，证据较强

| 文件 | 证据 | 建议 |
|---|---|---|
| `tooling/backfill-reasoning-tokens.ts` | 文件头第 1 行自称「**一次性**回填：把历史回执 usage 里的 reasoning tokens 派生到 admin_model_attempt_metrics」；对应迁移 `database/migrations/0125_reasoning_tokens_metrics.sql` 已在库中 | **archive**，risk **low** |
| `tooling/import-pricing-map.ts` | 与 `packages/backend/src/admin/pricing-seed.ts` 读**同一批** seed（`database/seeds/pricing/map-{A,B,C}.json`）做**同一件事**（幂等 upsert + 变更写 `pricing_rate_versions`）；而 `scripts/migrate.ts:39` 每次迁移后自动调 `seedPricingRates`，`pricing-seed.ts:3` 也写明「clean clone 跑 `db:migrate` 即有数据，**无需手工导入**」 | **delete**，risk **low**（功能已被自动路径完全覆盖；要复现可从 git 历史取回） |
| `scripts/refresh-workflow-readiness.ts` | 13 行的 CLI 壳，唯一动作是循环调用 `recoverWorkflowReadiness`；该函数已由 `apps/worker/src/schedules.ts:3` 在正式调度里使用 | **archive**，risk **low** |
| `scripts/deploy-reserve-guard.ts` | 文件头 `:1-2` 写明「Pre-deployment check for migration **0121**… Safe to run on production at ANY schema state (before 0121 is applied)」；而库已迁到 `0126`（`ls database/migrations` 末位 `0126_source_discovery.sql`，`_diag/cleanup-and-verification-20261120/final-284c766c-verification.txt` 记 `migrations=120 applied`），前置条件早已不存在 | **archive**，risk **low** |

### 6.2 仍可能被临时调用，证据较弱（不要删）

| 文件 | 它与什么配套 | 建议 |
|---|---|---|
| `scripts/check-reserve-manifest.ts` | 只读预检 `industry/source-reserves.json`（文件头 `:1-11` 列了 6 项检查，声明「Never writes to the DB or the manifest」）；`industry/source-reserves.json` 是**在用的**运行池清单（437,946 B，`docs/source-reserve-policy.md:3` 明确它是本次经验证的入池清单） | **archive**，risk **medium** |
| `scripts/reverify-reserves.ts` | 复核备用池 robots/feed 可达性，`--write` 时改 `industry/source-reserves.json`（文件头 `:3-6` 用法、`:13` 声明不碰数据库） | **archive**，risk **medium** |
| `scripts/replenish-reserve-candidates.ts` | 替换失效备用源，默认 dry-run、`--apply` 才写注册表（文件头 `:1-3`、`:5`） | **archive**，risk **medium** |
| `deploy/geohot/bin/install-exec-tunnels.sh` | 在 exec 节点生成两条 SSH 隧道 unit（`:9-10`）。当前拓扑仍有执行节点（`AGENTS.md` 记 2026-11-17 为四节点），**无法证明它已废弃** | **keep**（本轮不列为删除候选） |

**为什么这 4 个只给 archive 不给 delete**：它们的用法只写在自己的文件头里，仓库没有第二处引用，但也没有任何“已完成/已取代”的痕迹。把它们移出 `scripts/`、`deploy/` 会改变运维手册的可发现性，属于需要仓库主人拍板的决定，不是结构审计能单方面判定的。`docs/source-reserve-policy.md:13` 只点名了 `scripts/provision-source-reserves.ts`（那个是**有**引用的，不在候选里）。

---

## 7. 发现 D：未跟踪/被忽略的临时物

### 7.1 `.gitignore` 现状

```
$ cat .gitignore | grep -n "tmp\|_tmp"
72:deploy/geohot/tmp/
73:tooling/_tmp*
```

`:71` 的注释原文：「部署轮一次性过渡脚本与本机分析 scratch（不进索引；发布闸门另行校验）」。

忽略清单（排除 `node_modules/`、`.pgdata/` 后，`git status --ignored --short`）：

```
!! .data/                     !! .env                     !! .env.deepseek
!! .env.pipeline              !! .env.ports                !! .env.step5
!! .env.wbprobe               !! .mimosa/                  !! .zcode/
!! apps/web/.react-router/    !! apps/web/build/           !! apps/web/node_modules/
!! deploy/geohot/tmp/         !! packages/backend/node_modules/
!! tooling/corpus/merge-conflicts.md
```

### 7.2 `deploy/geohot/tmp/` —— 17 项，全部未跟踪

```
$ ls -la deploy/geohot/tmp | wc -l        # 17（14 个 .sh + 3 个 staging 目录）
$ git log --oneline --all -- deploy/geohot/tmp
（空：从未进过索引）
```

内容形态：

- 14 个一次性运维脚本：`cols.sh`、`coltype.sh`、`final-verify.sh`、`full-inventory.sh`、`inventory-query.sh`、`queue-breakdown.sh`、`receipt-classify.sh`、`switch-throttle.sh`、`throttle-observe.sh`、`magpie-auth-check.sh`、`magpie-diag.sh`、`magpie-readonly-check.sh`、`deploy-0c92837.sh`、`deploy-89e251d.sh`。
- 3 个 staging 目录，各含一份 592 KB 的 `source.tar.gz`：`staging-0c92837`（592K）、`staging-797c85e`（592K）、`staging-89e251d`（592K）。

「临时」的硬证据：

- 两个部署脚本把 SHA 写死：`deploy-0c92837.sh:3` → `SHA=0c9283723debfa12d355d07a824eb78ddb298baf`；`deploy-89e251d.sh:2` → `SHA=89e251dcf50587ec0de994cfa9aeb7afee6c71f8`。两者都存在于提交历史（`git cat-file -t 0c92837` → `commit`），即 tar 包内容可从 git 重新生成。
- 其余脚本是「查 `receipt_attempts` 有哪些列」「看空闲队列任务数」这类**一次性排查**（`cols.sh:1-7`、`throttle-observe.sh:1-8`）。
- `.gitignore:72` 自己被注释标为「一次性过渡脚本与本机分析 scratch」。

→ **archive**，risk **low**（移出工作区到 `_archive/`；它们从来不在索引里，GitHub 上也没有，删掉不影响任何端）。合计约 1.8 MB（`du -sh`）。

### 7.3 `tooling/corpus/merge-conflicts.md`

`.gitignore` 最后一段注释写明「Regenerated by `tooling/merge-corpus.mjs` on every non-dry-run」。**生成物，保持忽略即可**，不列为候选（删了下次跑脚本又长出来）。

### 7.4 `.mimosa/`、`.zcode/`

两个 agent 运行痕迹目录，被 `.gitignore:40-41` 与发布闸门 `deploy/geohot/publish-to-github.sh` 的 `BAD_PATHS`（`:163`）双重挡住；注释记录它们曾长到 880,136 个文件 / 6.03 GB。**不是仓库内容，也不该进仓库**；本轮不列为候选（属本机运行态，不是结构问题）。

---

## 8. 发现 E：一次性验收材料 `docs/major-release-20261024/`

4 个文件、合计 6 KB；除目录内部一处自引外，没有任何外部引用：

```
$ for f in docs/major-release-20261024/*; do printf "%-64s refs=%s\n" "$f" "$(git grep -l -F "$(basename $f)" | grep -v -F "$f" | wc -l)"; done
docs/major-release-20261024/browser-results.json        refs=1
docs/major-release-20261024/contour-20-results.json     refs=0
docs/major-release-20261024/contour-20.md               refs=0
docs/major-release-20261024/report.md                   refs=0
```

`browser-results.json` 那 1 处引用来自同目录的 `report.md:18`（「原始断言汇总见 `browser-results.json`」）；其余三个文件在 1290 个跟踪文件里**一次都没被点到**。

内容确认（只读抽样）：

- `report.md:1` →「# GEOHOT 重大更新：动态与交互验收（2026-10-24）」
- `contour-20.md:1` →「# GEOHOT 2.0 线条字形调整（2026-10-24）」

这是**某一次发布的专项验收记录**，不是长期文档。仓库里有更正式的同类去处：`docs/research/`（42 篇，见 9.3）和 `docs/known-issues.md`。

→ **archive**，risk **low**（建议移到 `docs/history/` 或 `_archive/`，保留留痕、退出主干文档面）。

> 为什么不建议 delete：这是发布证据。删了不影响运行，但会让 10-24 那轮的验收无法回查；`archive` 同样能让 `docs/` 变干净，代价为零。

---

## 9. 明确「不是候选」的项（附排除证据）

### 9.1 `tooling/ci-check.yml`
逐字节等于 `.github/workflows/check.yml`，但 `AGENTS.md:23` 规定两处同改，`.gitignore` 与 `publish-excludes` 也解释了动机。**设计如此。**

### 9.2 `assets/leaderboard-sources/`（14 文件）、`assets/model-providers/`（15 文件）
全仓唯一提到它们的代码文件是 `NOTICE`，看起来像“与地理热点无关的死资源”。但 `NOTICE:37-41` 把话说死了：

> Those marks are referenced only by the model leaderboard and the Codex reset monitor, which this derivative disables (`industry/features.ts`); **they are kept so the upstream modules still work if someone re-enables them**, and this notice does not license them to …

**刻意保留 + 商标署名义务**。清理它们必须同步改 `NOTICE`，且会让上游模块无法回滚启用。→ **keep**，risk 标注 **medium**（不是删除风险，而是「误删会同时破坏署名与可回滚性」）。

### 9.3 `docs/research/`（42 个文件：41 篇 .md + 1 个 .json）
引用扫描显示它们成**链**：每篇都被且仅被下一篇引用（`archive-coverage-refresh-2026-10-11-0807.md` ← `…-1247.md` ← `archive-news-closure-2026.md` …），链头 `archive-candidate-integrity-2026.md` 另有 ≥2 处引用。这是**按时间连续的研究留痕**，`refs:1` 是链条的正常形态，不是“没人读”。→ **keep**。

### 9.4 `docs/promo/`（2×12 MB mp4 + html + jpg）
仓库里最大的两个 blob（各 12,028,370 B）。看着像该清的体积，但**两者都有消费者**：

- `README.md:38` / `README.en.md:38` 直接链 `docs/promo/geohot-promo.mp4`
- `docs/promo/index.html:239-246` 同时链 `geohot-promo.mp4` 与 `geohot-promo-nobgm.mp4`（后者标「下载无配乐版」）
- 两者**不是**同一文件（`md5sum`：`4f3dd33f…` vs `eff720f6…`），是“带配乐/无配乐”两个版本

→ **keep**。附带发现（非候选）：`docs/known-issues.md:3480` 与 `deploy/geohot/verify-github-sync.sh:223` 仍写着「`docs/promo/*` 只在远端存在、开发线不跟踪」，但当前 HEAD **跟踪了全部 4 个文件**（`git ls-tree -r -l HEAD -- docs/promo` 有输出）。这是文档/脚本注释与事实的漂移，值得另开一单修，不属本次清理范围。

### 9.5 `_archive/`（403 MB）、`_assist/`（3.4 MB）
- `_archive/`：README 原文「历史快照…未确认唯一副本前不要删除」。内含两个 181 MB / 185 MB 的证据 tarball，`_diag/cleanup-and-verification-20261120/cleanup-audit-summary.txt:32` 记录过它们的字节数并核对一致。→ **keep**。
- `_assist/`：README 原文「保留仅为避免丢失不可恢复的凭据」，且目录下有 `.env.local-executor`、`.env.executor`、`.env.primary`、`.env.providers`。**`.env` 类文件按本轮口径一律不进 delete。** → **keep**。

> 补充观察（非候选）：`_assist/newbox/bootstrap{1,2,3,4}*.sh` 与 `GEOHOT/deploy/geohot/second-node/bootstrap*.sh` 同名但**内容不同**（分别差 2 / 63 / 31 / 21 行，`diff` 实测），不是副本关系，不能当重复删。

### 9.6 各类“不能按缓存处理”的
`GEOHOT/.pgdata/`（本机 Postgres 簇）、`GEOHOT/node_modules/`、`.git/`、`database/migrations/`（121 个 SQL，编号到 `0126`）、`industry/`（信源与选题数据）——按任务约束整类排除，**一个都没进候选**。

---

## 10. 未验证 / 待确认

| 项 | 状态 |
|---|---|
| 删除 `features/monitor/` 后 `npm run typecheck`、`npm run build -w @aihot/web` 是否仍绿 | **未运行**。结论仅来自静态 import 图 |
| 5 个 reserve 相关脚本是否仍有操作员在手工调用 | **无法从仓库判定**。仓库内零引用，仓库外（`_diag/`、`_archive/`）未穷举 |
| `deploy/geohot/bin/install-exec-tunnels.sh` 是否已被 `deploy/geohot/third-node/setup-exec.sh` 取代 | **待确认**。两者都建 exec 侧 unit，但 `setup-exec.sh` 建的是 `geohot-exec-worker.service.d/50-window.conf`（`:204-205`），与隧道不是同一件事 |
| `docs/architecture/package.json` + `package-lock.json`（nested npm 项目） | **keep**：`README.md:98` 给出 `npm ci --prefix docs/architecture` + `node docs/architecture/render.mjs` 的维护路径，`render.mjs` 是图的双语源 |
| `.claude/launch.json`（366 B） | **keep**：本机工具配置，无引用但成本为零 |
| `CLAUDE.md`（12 B，内容 `@AGENTS.md`） | **keep**：Claude Code 的 import 指令，不是重复文件 |

---

## 11. 候选汇总

机器可读版本见同目录 `cleanup-candidates.json`（数组，`path` 相对工作区根 `D:\地理热点网站`，仓库内文件带 `GEOHOT/` 前缀）。

| # | path | action | risk | 一句话理由 |
|---|---|---|---|---|
| 1 | `GEOHOT/apps/web/app/features/monitor/ResetCalendar.tsx` | delete | low | 零 importer；路由已在 `35c9a56f` 删除，flag 改回 true 也挂不上 |
| 2 | `GEOHOT/apps/web/app/features/monitor/PostCard.tsx` | delete | low | 只被 #1 引用 |
| 3 | `GEOHOT/apps/web/app/features/monitor/format.ts` | delete | low | 只被 #1/#2 引用（勿与 `apps/web/app/lib/format.ts` 混淆） |
| 4 | `GEOHOT/deploy/geohot/systemd/geohot-api-memory.conf` | delete | low | 与 `geohot-api.service.d/memory-pressure.conf` 同 blob；根目录裸 `.conf` 不在安装规则内 |
| 5 | `GEOHOT/tooling/model-pool-dead.txt` | delete | medium | 与 `deploy/geohot/bin/model-pool-dead.txt` 同 blob；脚本只读后者 |
| 6 | `GEOHOT/tooling/import-pricing-map.ts` | delete | low | 与 `pricing-seed.ts` 功能重复，后者由 `migrate.ts:39` 自动执行 |
| 7 | `GEOHOT/tooling/backfill-reasoning-tokens.ts` | archive | low | 文件头自称“一次性回填”，对应迁移 0125 已落 |
| 8 | `GEOHOT/scripts/deploy-reserve-guard.ts` | archive | low | 仅为迁移 0121 的一次性前置检查，库已到 0126 |
| 9 | `GEOHOT/scripts/refresh-workflow-readiness.ts` | archive | low | 13 行 CLI 壳，核心函数已在 worker 调度里 |
| 10 | `GEOHOT/scripts/check-reserve-manifest.ts` | archive | medium | 零引用只读预检，配套数据仍在用 |
| 11 | `GEOHOT/scripts/reverify-reserves.ts` | archive | medium | 零引用运维脚本，可能被临时调用 |
| 12 | `GEOHOT/scripts/replenish-reserve-candidates.ts` | archive | medium | 同上 |
| 13 | `GEOHOT/deploy/geohot/tmp/`（17 项） | archive | low | `.gitignore:72` 自标一次性；`deploy-*.sh` 写死已存在的 SHA |
| 14 | `GEOHOT/docs/major-release-20261024/`（4 文件） | archive | low | 2026-10-24 单次验收材料，3 个文件零引用 |
| 15 | `_diag/items-h8nme0fprk1uf1u8dbhfz53k5.html` 及其余 2 个 | delete | low | 3 份 `md5sum` 完全相同（`e072c3fe…`），同一次抓取的重复落盘 |
| 16 | `GEOHOT/tooling/ci-check.yml` | keep | low | 与 `.github/workflows/check.yml` 同 blob，但 `AGENTS.md:23` 规定双份 |
| 17 | `GEOHOT/assets/leaderboard-sources/` | keep | medium | 只服务已关停的模型榜，但 `NOTICE:37-41` 明写“保留以便重新启用”+ 商标署名 |
| 18 | `GEOHOT/assets/model-providers/` | keep | medium | 同上 |

第 15 条的复现命令：

```
$ cd D:/地理热点网站/_diag && md5sum items-*.html
e072c3feff88be1c32aaba94bceb1283 *items-h8nme0fprk1uf1u8dbhfz53k5.html
e072c3feff88be1c32aaba94bceb1283 *items-lg7ryzsv7jnat2okdam64e8sa.html
e072c3feff88be1c32aaba94bceb1283 *items-xqe9q013jnb8f35rimyenn4rm.html
```

（同目录的 `item-*.html` 三份**不**相同——`96fa00ea…` / `47b3bfdc…` / `80b0933f…`，各自是不同 key 的详情页，不在候选里。）

---

## 12. 建议的下一步顺序

1. **先做零争议的**：#4/#5/#6 三条 `delete`（同 blob 重复 / 功能被自动路径覆盖），改完跑一次 `npm run typecheck` 与 `npm test` 收口。
2. **再做 #1/#2/#3**（monitor 组件簇）——它需要 `git rm` 三个文件并确认 web 构建绿；`docs/customize.md:97` 已经授权。
3. **#13/#14 走 archive**：移到 `_archive/` 或 `docs/history/`，别直接删，它们分别是部署轮留痕和发布验收证据。
4. **#10–#12 需要仓库主人拍板**：结构上零引用，运维上可能还在用。
5. **顺带修两处漂移**（不在本审计动作范围）：`prune-model-pool.sh:8,12` 的注释指向 `tooling/model-pool-dead.txt`（代码读 `$here`）；`known-issues.md:3480` / `verify-github-sync.sh:223` 关于 `docs/promo/` “不跟踪”的说法已与 HEAD 不符。
