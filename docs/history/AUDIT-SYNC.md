# 版本同步审计（AUDIT-SYNC）

- 审计时间：2026-11-21 10:03–10:12（北京时间；对应 UTC 02:03–02:12）
- 审计方式：只读。只执行 `cat` / `stat` / `ls` / `git rev-parse` / `git hash-object` / `git status` / `systemctl is-active|show|cat` / `curl GET`。
- 未执行：部署、重启、迁移、`git fetch`/`push`、修改 `.env` 或任何服务器配置。
- 审计对象：本地 `D:\地理热点网站\GEOHOT`、GitHub `xxc2007/GeoHot` 的 `main`、生产 `https://xxc2007.me/geohot/api/health`、可只读访问的服务器节点。

## 1. 结论

| 锚点 | SHA | 与本地 HEAD 的关系 |
|---|---|---|
| 本地 HEAD（`main`） | `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3` | 基准 |
| GitHub `origin/main`（`gh api`） | `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3` | 相同 |
| GitHub `origin/main`（`git ls-remote`） | `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3` | 相同 |
| 生产 health `.release` 字段 | `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3` | 相同 |
| HZ 节点 `…/.release` | `284c766ce8565fcb24a38060932de25140d11f5d` | **落后 13 个提交**（严格祖先，无分叉） |
| 读者节点 `…/.release` | not covered | 无只读访问 |
| WH 节点 `…/.release` | not covered | 无只读访问 |

一句话：**本地 / GitHub / 生产 API 三者一致在 `2e5edf22`；杭州协调+执行节点仍停在 `284c766`，落后 13 个提交；读者节点与 WH 节点的 `.release` 本次未能读取。**

## 2. 本地

```
$ git -C D:/地理热点网站/GEOHOT rev-parse HEAD
2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3
$ git -C D:/地理热点网站/GEOHOT rev-parse --abbrev-ref HEAD
main
$ git -C D:/地理热点网站/GEOHOT log -1 --pretty='%H %ad %s' --date=iso-strict
2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3
2026-11-21T01:51:39+08:00 Merge pull request #356 from xxc2007/fix/jina-timeout-20261121
$ git -C D:/地理热点网站/GEOHOT status -sb
## main...origin/main
?? docs/history/
$ git -C D:/地理热点网站/GEOHOT status --porcelain --untracked-files=no | wc -l
0
```

- 已跟踪内容零改动；唯一未跟踪项是 `docs/history/`（本目录，含本文件）。
- `git branch -vv` 中 `* main 2e5edf22 [origin/main]`，无 `ahead`/`behind` 标记。
- 远端：`origin https://github.com/xxc2007/GeoHot.git`（fetch/push 同址）。

## 3. GitHub

两条独立通道结果一致：

```
$ gh api repos/xxc2007/GeoHot/git/ref/heads/main --jq '.ref+" "+.object.sha+" "+.object.type'
refs/heads/main 2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3 commit

$ gh api repos/xxc2007/GeoHot/commits/main --jq '.sha+" | "+.commit.author.date+" | "+.commit.message' | head -1
2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3 | 2026-11-20T17:51:39Z | Merge pull request #356 from xxc2007/fix/jina-timeout-20261121

$ git ls-remote origin refs/heads/main
2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3	refs/heads/main
```

`2026-11-20T17:51:39Z` 与本地 `2026-11-21T01:51:39+08:00` 是同一时刻。

## 4. 生产 health

```
$ curl -sS -D - https://xxc2007.me/geohot/api/health
HTTP/1.1 200 OK
Date: Sat, 21 Nov 2026 02:03:07 GMT
Cache-Control: no-store
x-geohot-public-cache: BYPASS
cf-cache-status: DYNAMIC
...
{"ok":true,"db":"ok","reason":"ok","elapsed":2,"ms":2,"release":"2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3"}

$ curl -sS https://xxc2007.me/geohot/api/health   # 10:12:26 +08
{"ok":true,"db":"ok","reason":"ok","elapsed":13,"ms":13,"release":"2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3"}
```

- 两次结果相同；响应带 `Cache-Control: no-store` 与 `x-geohot-public-cache: BYPASS`，可视为源站实时值而非 CDN 缓存。
- **口径限制（重要）**：`releaseId()` 是「环境变量优先，文件兜底」（`apps/api/src/app.ts:27-36`，health 在 `apps/api/src/app.ts:102` 取用，`apps/api/src/app.ts:131` 输出）。因此 health 的 40 位 SHA 证明的是 **API 进程自称的发布号**；`deploy/geohot/deploy.sh:322` 同时写 `.release`、`deploy/geohot/deploy.sh:326-336` 同时把 `.env` 的 `AIHOT_RELEASE` 同步为同一 SHA。二者取值相同，但**只读 health 无法区分是哪一个来源命中**，也不能替代读者节点上 `.release` 与构建产物的逐字节核对——这正是 `docs/release-sync-policy.md:9` 的要求。

## 5. 服务器节点

访问方式：沿用本机 `~/.ssh/config` 里已有的跳板与 `geohot_deploy_ed25519` 密钥，只跑读命令。按 `AGENTS.md:41` 的约束，本文不写主机 IP / 主机名。

### 5.1 HZ 节点（杭州：协调 + 执行，`WORKER_ROLE=all`）—— 实读

```
$ ssh <HZ节点> 'cat /home/geohot/geohot/.release; stat -c "%y %s %U:%G %a" /home/geohot/geohot/.release'
284c766ce8565fcb24a38060932de25140d11f5d
2026-11-20 19:19:48.936048221 +0800 41 geohot:geohot 644

$ ssh <HZ节点> 'systemctl show -p WorkingDirectory --value geohot-exec-worker'
/home/geohot/geohot
$ ssh <HZ节点> 'systemctl show -p ActiveEnterTimestamp --value geohot-exec-worker'
Sat 2026-11-21 07:37:36 CST
```

- 该节点**没有** `/opt/geohot/app`（`cat: /opt/geohot/app/.release: No such file or directory`）；代码目录是 `/home/geohot/geohot`，`.release` 是发布身份。
- 本机跑的是 `geohot-exec-worker`（内容执行）+ `geohot-magpie` + 两条 WorkBuddy 桥 + `role-day/night` 定时器；**没有** `geohot-api` / `geohot-web` 单元，也没有 `apps/web/build`（`ls: cannot access 'apps/web/build': No such file or directory`），Node 为 `v24.9.0`。
- `.release` = `284c766`（PR #351，2026-11-20 19:02），是本地 HEAD 的**严格祖先**（`git merge-base --is-ancestor 284c766 HEAD` → 是），落后 `git rev-list --count 284c766..HEAD` = **13** 个提交。
- worker 于 07:37 重启，晚于 `.release` 的 19:19，即当前进程加载的就是 `284c766` 这份代码。

**该节点 git HEAD 不可用作证据**（`AGENTS.md:25` 已预警的现象在此复现）：

```
$ ssh <HZ节点> 'git -C /home/geohot/geohot rev-parse HEAD'
651ba404b25822a52adc1246750d05e44f648e62       # 提交信息 "sync: 与主库 ae03c87 对齐"，2026-11-15
$ git cat-file -t 651ba404b25822a52adc1246750d05e44f648e62    # 本地
fatal: git cat-file: could not get object info
```

- `651ba404` 在 GitHub 上不存在（本地对象库无此提交），是一个停在 2026-11-15 的本地对齐提交。
- 工作树对它报 `139` 个已跟踪改动、`112` 个未跟踪文件——因为工作树内容比这个旧 HEAD 新，不能据此判断"有人改了线上代码"。

### 5.2 读者节点（PostgreSQL + API + Web，health 的实际来源）—— **not covered**

- `ssh root@<读者节点>` / `xxc@` / `geohot@`（经 HZ 跳板）均为 `Permission denied (publickey)`。
- 因此无法读取 `/opt/geohot/app/.release`、`apps/web/build` 产物指纹、`.env` 中的 `AIHOT_RELEASE`。
- health 的 `2e5edf22` 是该节点 API 自报值，本次**没有**独立文件级证据与之互证。

### 5.3 WH 节点（第二个执行节点）—— **not covered**

- 直连与经 HZ 跳板均为 `Connection timed out during banner exchange`（22 端口有响应但握手超时），无法读取其 `.release` 与代码目录。

## 6. 差异：HZ 节点可能滞后的文件

`284c766..2e5edf22` 的 13 个提交（由旧到新）：

```
e6e588b0 fix(admin): warm snapshots and stop caching unavailable usage
88ac8e45 feat(changelog): publish 7.0 source pool and 8.0 model ledger cards
3ae5c0c2 docs(changelog): keep 7.0/8.0 bodies within the three-line scan limit
4100ec48 Merge pull request #352 from xxc2007/fix/admin-snapshot-sources-20261120
574fa158 fix(reserves): bind participation mode instead of quoting it as a column
c73a6389 Merge pull request #353 from xxc2007/fix/reserve-replenish-quoting-20261120
ec0ec174 docs: record the reader API pool floor and the systemd override trap
7489e4ca Merge pull request #354 from xxc2007/docs/db-pool-20261121
41533a38 feat(sources): multi-engine discovery with quality gate and review queue
6e446c11 Merge pull request #355 from xxc2007/feat/source-discovery-engines-20261121
8b4d04c2 fix(discovery): give Jina search the measured 35s budget
8310405b docs(discovery): list the two remaining DSH engines and why they stay out
2e5edf22 Merge pull request #356 from xxc2007/fix/jina-timeout-20261121
```

`git diff --name-only 284c766..HEAD` 受影响文件（20 个）：

```
.env.example
AGENTS.md
apps/api/src/main.ts
apps/api/src/routes/admin.ts
apps/web/app/features/changelog/MajorRelease.tsx
apps/web/app/features/changelog/major-later.tsx
apps/web/app/routes.ts
apps/web/app/routes/admin/discovery.tsx
apps/web/app/routes/admin/layout.tsx
apps/web/app/routes/admin/runs.tsx
apps/web/app/routes/admin/sources.tsx
database/migrations/0126_source_discovery.sql
docs/source-discovery.md
industry/changelog.json
packages/backend/src/admin/runs.ts
packages/backend/src/admin/usage.ts
packages/backend/src/sources/discovery-probe.ts
packages/backend/src/sources/discovery-run.ts
packages/backend/src/sources/search-engines.ts
scripts/replenish-reserve-candidates.ts
tests/source-discovery-engines.test.ts
```

逐字节核对（`git hash-object`，两边同一算法可直接比对）：

| 文件 | HZ 节点实际 blob | 本地 `HEAD:path` | 判定 |
|---|---|---|---|
| `apps/api/src/main.ts` | `918e91ff134b83c8b4511fa199992beb0f4264e7` | `63b7a8597df99615154b6d1578b3c6f78ea37219` | 不同；HZ 的哈希等于 `284c766:apps/api/src/main.ts`，确认是旧版而非现场改动 |
| `package-lock.json` | `9b6d26bb929a103dbc935b6f4d1429ed74ea7df9` | `9b6d26bb929a103dbc935b6f4d1429ed74ea7df9` | **相同** |
| `apps/worker/src/main.ts` | `4452713d39d10d37e8c693d37269e2199376ce29` | `4452713d39d10d37e8c693d37269e2199376ce29` | **相同** |
| `packages/backend/src/sources/search-engines.ts` | MISSING | `481753e2096a896b5ed50fef7f7eace66dfb511d` | **缺失** |
| `database/migrations/0126_source_discovery.sql` | MISSING | `705c6b5a3bed066660f8f855695592fef2746ed5` | **缺失** |
| `scripts/replenish-reserve-candidates.ts` | MISSING | `18265a2567f0b1a85b936d9ce345ad4819f9353b` | **缺失** |

结论：
- HZ 节点内容与 `284c766` 一致（抽样文件哈希可对上），不是随机漂移，是**整节点没跟上最近一轮**。
- 3 个新文件在该节点上完全不存在，其余受影响文件为旧版本。
- 就该节点实际承担的角色（执行器）而言，可能受影响的是 `packages/backend/src/sources/discovery-*.ts`、`packages/backend/src/admin/{runs,usage}.ts` 与 `scripts/replenish-reserve-candidates.ts`；`apps/api/*`、`apps/web/*` 在该节点没有对应单元，属于"有文件但不是运行面"。
- `database/migrations/0126_source_discovery.sql` 缺失于该节点**不等于**生产库没跑这条迁移——迁移由部署端在 API 根目录执行，本次无法确认库内 schema 状态（见第 8 节）。

## 7. 判定口径

- 本地 / GitHub / health 三方 40 位 SHA 完全相同，且本地已跟踪工作树干净，可判定"源码端与 GitHub 发布分支一致，生产 API 自称同一发布号"。
- HZ 节点 `.release` 落后 13 个提交，属**未同步**，不能因为它的进程 `active`、health 200 或 git HEAD 看起来"更新"就判通过。发布身份只认 `.release`（`docs/release-sync-policy.md:9`）。
- 读者节点、WH 节点本次无访问，**不得**用 health 的 SHA 代替它们的 `.release` 读回。

## 8. 未覆盖清单（明确未验证）

1. 读者节点 `/opt/geohot/app/.release` 与 `apps/web/build` 产物指纹——SSH 公钥被拒。
2. WH 节点 `.release` 与代码目录——SSH 握手超时。
3. 读者节点 `.env` 中 `AIHOT_RELEASE` 是否为 `2e5edf22`（health 无法区分环境变量与 `.release` 两个来源）。
4. 生产数据库是否已应用 `0126_source_discovery.sql` 等迁移——本次未连库、未跑任何查询。
5. 静态资源指纹与页面行为验收——本审计只按要求核对 health，未做浏览器验收。
6. HZ 节点 139 个已跟踪改动 / 112 个未跟踪文件的逐项内容审计——只抽样 6 个文件做了 blob 比对。

## 9. 复验命令

```bash
# 本地（在 D:/地理热点网站/GEOHOT）
git rev-parse HEAD
git status -sb

# GitHub
gh api repos/xxc2007/GeoHot/git/ref/heads/main --jq .object.sha
git ls-remote origin refs/heads/main

# 生产
curl -sS https://xxc2007.me/geohot/api/health

# HZ 节点（.release 才是发布身份）
ssh <HZ节点> 'cat /home/geohot/geohot/.release'
ssh <HZ节点> 'systemctl show -p WorkingDirectory -p ActiveEnterTimestamp geohot-exec-worker'

# 读者节点（需要具备只读访问后执行）
ssh <读者节点> 'cat /opt/geohot/app/.release; sha256sum /opt/geohot/app/apps/web/build/index.html'

# WH 节点（同上）
ssh <WH节点> 'cat /home/geohot/geohot/.release'
```

判定：四处 40 位 SHA 全部等于 `2e5edf22ceb76548646fe92d20b0dc8fa7ec59b3` 才算四端同版；任何一处不同，按 `docs/release-sync-policy.md` 的发布流程处理，不以脚本退出码或 health 200 代替。

## 10. 本次未做的事

未部署、未重启任何单元、未执行迁移、未修改 `.env` 或 nginx/systemd 配置、未 `git fetch/push/commit`。本文件以未跟踪状态留在 `docs/history/`。
