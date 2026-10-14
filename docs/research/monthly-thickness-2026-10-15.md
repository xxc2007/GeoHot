# 第九十六轮：为什么历史月薄、十月厚（2026-10-15 00:00–01:20 CST 实测）

站长的问题：十月只有十几天就收集到 13,000+ 条，其他月平均只有一千多条。
答案是**结构性的**，不是"没登记信源"。下面每条都是生产库/代码实测，不是推断。

## 一、十月的量是怎么来的

按新闻日期所在月数（`timeline_at` 换北京时间）：

| 月 | 全部 | archive | first-import | 实时(NULL) | 参与源 |
| --- | --- | --- | --- | --- | --- |
| 2026-01…08 | 1,622–2,371 | 1,346–1,602 | 26–338 | 少 | 131–302 |
| 2026-09 | 5,252 | 1,481 | 1,540 | 2,184 | 491 |
| **2026-10（14 天）** | **22,238** | 940 | 2,268 | **16,967** | 519 |

十月那 16,967 条实时行里，**两扇门占 12,396 条（56%）**：
`json-nmc-weather-alarm` 8,474 条（中央气象台预警，几分钟一轮、每轮多条）与
`cn-chinanews-scroll` 3,922 条。第三名的量级是 370。
所以"十月厚"的真实含义是**实时侧在跑、且两扇高频门在灌**，不是覆盖变宽。

## 二、历史月薄在哪（三处，全部实测）

1. **只有 94/666 个启用源带"历史入口"**（`config.issn` 或 `config.archiveIndexUrl`；
   判据在 `packages/backend/src/sources/archive-site.ts` 的 `archiveDoorFilter`）。
   其余 549 个是"只看得到最近 N 条"的实时门，天生给不了历史。
2. **档案周期每轮只走访 6 片**（`GEOHOT_ARCHIVE_SLICES=6`），而 9 个月共 940 片 ⇒ 同一 (源,月) 约两天才被再访问一次。
3. **切片一旦 `done` 就永不再扫**（`backfill-archive.ts` 的 eligible 过滤：过去月 `!done.has(...)`）。
   台账里 828 片 done、112 片 pending——**历史月已经"扫完"了，所以不再变厚**。

**被证伪的两个猜测**（我先前都当成结论写过，实测推翻）：
- *"每片配额 16 太小"*：828 个 done 切片里**只有 9 片**的入库数顶到过 16。配额不是瓶颈。
- *"Crossref 摘要闸（<80 字）挡掉了大量内容"*：抽四扇门跑 2026-05 实测——
  `rss-copernicus-gmd` 37 条可判 / 摘要过短 0；`rss-copernicus-bg` 34 / 0；
  `rss-grl-toc` 60 / 1；`rss-ess-toc` 只有 2 条可判，但**无整日期 27 条**。
  真正吃掉量的是**没有日期**与**与实时重复**，不是摘要长度。
  （`--min-abstract` 这个闸我仍改成了可配置，默认 80 行为不变——见下。）

## 三、本轮按站点自己的工作流做了什么

1. **把 23 道包里有、库里没有的档案门落库**：`issn 87→110`、档案门 `94→117`。
   成因是 `scripts/seed.ts` 的 `ON CONFLICT DO NOTHING` **只新增不改**，配置漂移只能由
   `sync-source-config.ts` 推——而它强制要求把生产 DSN 写在命令行上（#174）。
   本轮给它加了 `--database-url-env=DATABASE_URL`（照 `backfill-papers.ts` 已有的形状），
   于是同步不再需要把带口令的地址放到 `ps` 里。同步后 DRY-RUN 复量：**差异 0 条（共比对 660 条）**。
2. **把 828 个 done 切片重置为 pending**（历史月重新可扫）。改前落 CSV 快照
   `.data/backups/archive-ingest-status-20261015T0015.csv`（940 行，可逐行还原 status）。
3. **`/etc/geohot/archive-cycle.conf`**：`MAX_ITEMS 100→240`、`SLICES 6→12`（每轮走访的门数翻倍）、
   `PER_MONTH 30→500`，并**删掉写死的 `GEOHOT_ARCHIVE_TO=2026-10-10`**，交回脚本默认的滚动今天。
   改前备份在 `/root/archive-cycle.conf.pre-thicken-<STAMP>`。
4. **`--min-abstract` 与 `--database-url-env` 两处代码改动**已提交、发布、上线，
   `npm run typecheck` = 0，`tests/archive-backfill-control.test.ts` 7/7 通过（含新加的一条：
   打错字的 `--min-abstract` 必须在门口拒绝，否则 `body.length < NaN` 恒 false，这道闸会静默失效）。
5. **效果已在跑**：重置后 25 分钟内，1—9 月各月新增 archive 行合计 223 条（≈535 条/时），
   待判从 2,473 降到 1,417。周期每 15 分钟继续推进，出刊由 `papers` 阶段逐日/逐周/逐月补。

## 四、出刊连续性现状（01:14 实测）

日报 280 期、周报 41 期、月报 9 期，**每一期都真有读者可见条目**；
缺的只有 `2026-W42`（本周未关窗）与 `2026-10`（本月未关窗），按设计不出。
仍欠的两天 `2026-08-27`、`2026-08-31` 各差 3 / 4 条判完，7 条全部已在 `content.analyze` 的 `created` 队列里
（08-31 另有一条撞上某扇门的**当日文本额度** 429，由重试阶梯自己走完）——
**没有手工插队**，因为那会让同一篇被付两次。

## 五、"最高速率"这件事的实测结论：不该动的别动

- 生产 `.env` 实测 `ANALYZE_CONCURRENCY=24`、`FETCH_CONCURRENCY=4`——**不是**子智能体报告里说的"2"。
- 熔断额度合计 127 次/分、5,160/时、72,000/天（`budgets` 五行），而实际判定约 33 次/分。
  **瓶颈是这台 891 MB / 2 核机器的槽位与内存**（worker `MemoryMax=240 MB`），不是额度。
  所以"按最高速率执行"的正确做法不是抬 `budgets`（抬了也不会有人用），
  而是：本轮把每轮走访的门数翻倍 + 让历史月重新可扫 + 判定队列按序消化。
  要再快一档需要加内存，那是站长的事。
- 摘门不减总 token（活被别家重付），省的是注定失败的调用——见 `model-pool-slim-2026-10-14.md`。

## 六、安全走查（三面）

**仓库（我做了一遍确定性扫描）**：768 个跟踪文件里
`sk-…`/`ghp_…`/`github_pat_…`/`AKIA…`/`-----BEGIN PRIVATE KEY-----`/`xoxb-`/长 Bearer **全部 0 命中**；
`git ls-files` 不含 `.env`/`*.pem`/凭据 json；`git log --all --diff-filter=A` 从未添加过这些路径；
`package-lock.json` 无 postinstall 段；生产 IP / SSH 用户名 / 私钥文件名在公开文件里 0 命中。
唯一残留是**本机开发库**的 `postgres://geohot:geohot@127.0.0.1:5433/geohot`（`.env.example`、`AGENTS.md`、CI 的 `ci@127.0.0.1`），
属既有待拍项 #117。

**站点**：`/geohot/admin`→302、`api/admin/*`→401、`.env`→404；
公开出口 feed.xml/daily/weekly/monthly/all/full 与 sitemap/llms.txt 全 200；`api/mcp` GET 405 属设计。
读者端安全头只有 `X-Content-Type-Options` 与 `Referrer-Policy`——**没有 CSP、没有 X-Frame-Options、HSTS 发不出去**（Cloudflare Flexible 回源走 HTTP），
且**源站 443/80 可被直连**（`--resolve` 实测拿到 `Server: nginx` 200），意味着可以绕开边缘 WAF/限流直接打源站。
`robots.txt` 里写着 `Disallow: /geohot/admin/`（自报内部面，风险低但确实是一条公开提示）。

**服务器**（只读走查，未改任何配置）：
SSH 是 `permitrootlogin without-password` + `passwordauthentication no`，但 `MaxAuthTries 6`、X11/TCP 转发开着；
`lastb` 自 10-01 起约 1,000 次/日爆破，fail2ban 在跑但用的是发行版默认参数（5 次/10 分钟/封 10 分钟）。
**四个主应用单元零沙箱加固**（`NoNewPrivileges=no`、`ProtectSystem=no`、`PrivateTmp=no`、
`CapabilityBoundingSet` 未裁），而同机的 workbuddy/archive 三个单元已经是 `ProtectSystem=strict`——
照抄那组 drop-in 即可。`ufw` inactive、`iptables -P INPUT ACCEPT`，
一个 **rclone 管理界面听在 `*:8080`**（公网实测 filtered，唯一屏障是云 NSG），
且它跑在 `session-*.scope` 里、不是服务（不会自启也不会被我误重启）。
`apt-get -s upgrade` 有 12 个待更新且**全部来自 `jammy-updates`**，而 Allowed-Origins 只列 `jammy` 与 `-security`
⇒ 自动更新永远修不到它们；另有 `reboot-required`（内核已装未重启，up 51 天）。
备份目录权限不齐：`migration/` 里两个 portable.tgz 是 `0600 root`（正确），
但同目录另有 `0660` 的含凭据 tgz 与一个 `0644` 的 tar.gz。

## 七、留给站长的四项（我不擅自做）

1. **源站可直连 + 无 CSP**：要么在 nginx 上只信 Cloudflare 回源 IP 段，要么给源站加 IP 白名单；CSP 需要一轮真实浏览器回归。
2. **systemd 沙箱 drop-in**（四个单元）与 **8080 收口 127.0.0.1**：都是改配置 + 重启，需要择窗。
3. **unattended-upgrades 的 Allowed-Origins 加上 `jammy-updates`** + 一次计划内重启（内核欠 6 周）。
4. **备份目录里 0644/0660 那三份含凭据的旧包**：改权限还是删除。

## 八、三端与备份（本轮收口读数）

- GitHub：`768 个 blob 逐字节全等 + 发布线独有 3 件按带过来处理`（本轮两次发布各自验收）。
- 生产：与 HEAD **哈希差 0**（768 个跟踪文件逐个 sha256 对过；唯一的 1 处差异是 Windows CRLF，已在服务器上归一）。
- 迁移备份：**`geohot-20261014T171807Z-portable.tgz`**（918,639,441 B，
  sha256 `48d70688…92fa`，包内自带 `SHA256SUMS` 复验 OK，30 个成员；
  包里的 `scripts/backfill-archive.ts`=`b176e775…`、`archive-cycle.sh`=`8df8bfbe…`、
  `sync-source-config.ts`=`a00572d1…`、`industry/sources.json`=`9025fb2f…` 与 HEAD 一致）。
  ⇒ 取代 `geohot-20261014T150658Z`（889,452,105 B）；旧的没删，删除不可逆，归站长。
