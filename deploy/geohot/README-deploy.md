# GEOHOT 部署手册（README-deploy.md）

目标：把站点上线到 `https://xxc2007.me/geohot/`，**不影响根路径主站（纪念册）与 Artalk 评论服务**。
本目录（`deploy/geohot/`）是给"人"执行的部署包；执行者是我方之外的运维（服务器只有 owner 有凭据）。

> 本文所有结论都对着仓库代码实测过，标注 `文件:行`；与 `docs/deploy.md`（上游 Docker 文档）冲突处以代码与本手册为准。

---

## 0. 已拍板的四个决定

| # | 决定 | 对部署的影响 |
|---|---|---|
| 1 | **保留人工策划的编辑大脑**（`tooling/brain-stub.ts` fixture 判断，不接真 LLM Key） | 精选只随人工语料增长；新采材料落默认值（打分 20、归组 UNRELATED），站点会随 48 h 窗口变旧（`packages/backend/src/events/hot.ts:8-10`）。阀的取值见 §5 |
| 2 | **about 页/`site.ts` 措辞改为诚实口径**（不再声称"用模型打分"，或明示判断由人写） | 纯代码/文案改动，随公开仓库一起部署，不涉及服务器操作 |
| 3 | **公开仓库用干净单初始提交**（放弃 5 提交波次历史，删 `docs/assets/*.png`） | 仓库已经建好：`bootstrap-server.sh` 的 `REPO_URL` 默认值就是 `https://github.com/xxc2007/GeoHot.git`（开发机 `git remote -v` 看到的 origin），不再是占位串。要装 fork 或离线搬运就 `GEOHOT_REPO_URL=…` 覆盖，第 2 节 clone 前会实测可达性 |
| 4 | **站点挂在 `/geohot/` 子路径下**（2026-10-01 已上线并逐条验证；前缀是**构建期**变量） | 前缀由 bootstrap-server.sh 的 `GEOHOT_BASE_PATH`（默认 `/geohot`）作为 `BASE_PATH` 传给 `npm run build`，烧进 bundle；nginx 的 location 前缀与 `SITE_URL` 的路径必须与它一致。**要挂域名根就显式 `GEOHOT_BASE_PATH=""`**（空串是合法取值，含义是"这个站占域名根"：构建不带 BASE_PATH、nginx 不需要前缀 location、那条补斜杠的 308 也不要）。`verify-deploy.sh` 第 3 节会硬断言资源不回落根 |

## 1. 动手前先备份（owner 在服务器上执行）

1. 主站/nginx：`sudo cp -a /etc/nginx/sites-available/xxc2007.me{,.bak-$(date +%F-%H%M)}`；`sudo ufw status numbered > ~/ufw-before.txt`。
2. 基线哈希（**必须在任何 nginx 改动之前**）：`bash verify-deploy.sh --save-baseline`（记录主站首页与 sitemap 的 sha256）。
3. Artalk 是 systemd + SQLite（不占 PostgreSQL），它的 db 文件照常纳入 owner 现有备份；本部署不碰它。
4. GEOHOT 侧无历史数据可备（新库），但 `.env` 一旦生成立刻 `cp .env .env.bak-日期`——密钥只打印一次。
   备份与 `.env` 都放在 `$APP_HOME`（默认 `/opt/geohot`，即 `GEOHOT_APP_ROOT` 的父目录），不要放进代码目录里。

## 2. 顺序（不可颠倒）

```text
① 预检/澄清（bootstrap DRY-RUN 打印）→ ② 建用户/目录/clone/npm ci/建 .env（bootstrap --apply 第 1~4 节）
→ ③ 人工核对 .env（§5 清单！bootstrap 第 5 节会逐项断言，过不去就 exit 1，数据库一个字节都不碰）
→ ④ PostgreSQL 版本与 pg_trgm 预检（同脚本第 6 节）→ ⑤ 建角色与库 + 用 .env 实测连接（第 7 节）
→ ⑥ migrate/seed/seed:curated + 带 BASE_PATH 构建 web（第 8~9 节）
→ ⑦ 贴 nginx 片段：nginx -t 过了才 reload（片段头部那段"生效顺序"，不是尾部）
→ ⑧ 启动四个 unit（brain/api/worker/web）—— bootstrap 第 10 节只 `enable` 不 `--now`，核对完 .env 再
      `sudo systemctl start …`；自己贴模板装的那台机器上才用 `systemctl enable --now`
→ ⑨ bash verify-deploy.sh 全绿
→ ⑩ 每日备份 cron（§6），并且按 §6.1 当场演练一次恢复
```

- 为什么 `.env` 的核对排在**所有**数据库操作之前（2026-10-02 修正）：以前 `--apply` 先 migrate/seed 再让人
  核对 `.env`，那一刻 `DATABASE_URL` 还是模板里的 `127.0.0.1:5433`（开发机 embedded 库，服务器上不存在）、
  角色口令还是占位串 `CHANGE_ME_bootstrap`，一次性装法走不完。现在 `DATABASE_URL` 由脚本按它自己建角色用的
  `PG_*` 值写回 `.env`（第 5 节），两边不可能对不上；对不上的那一种（角色早就存在、口令不是这次的）由第 7 节
  的连接实测拦下。
- 为什么 nginx 在服务启动之后：先 502 可控，先改 nginx 再把主站搞挂不可控。
- `reload` 永远不是 `restart`；`nginx -t` 不过就停手，不许带病 reload。
- 回滚一律走 `rollback.sh`（默认 DRY-RUN；`--purge-database` 才会删库，且删前强制 pg_dump）。
- 安装目录只有一个变量：`GEOHOT_APP_ROOT`（默认 `/opt/geohot/app`）。bootstrap、install-units、
  verify-deploy、rollback 四个脚本都读它；`systemd/` 里那批 `*.service` 是文本模板（systemd 没有变量插值），
  写死的是同一个默认值 —— 换过路径就不能用模板，`bootstrap-server.sh` 第 10 节会当场拦住并让你改走
  `install-units.sh`（它按变量渲染）。别再往脚本里写第二条路径。

## 3. 需要 owner 提供 / 确认的（脚本里全部做成 PREFLIGHT CHECK，不假定）

| 项 | 取值处 |
|---|---|
| 服务器进入方式（`xxc` 用户公钥 + `sudo -l`，不给 root 口令） | 人工 |
| 有没有 Docker/Compose；PostgreSQL 是否已装、**版本是否 16/17**、`pg_trgm` 是否可用、`psql`/`pg_dump` 是否可用 | bootstrap 预检只读探测；--apply 时第 6 节硬断言（Ubuntu 22.04 自带 14，contrib 是另一个包） |
| 3000/3001 是否空闲（纪念册站口占用则改 `WEB_PORT/API_PORT` 并同步 nginx 片段） | 预检 `ss -ltnp` |
| 允许 `CREATE ROLE geohot` + `CREATE DATABASE geohot`（非 superuser，不改 pg_hba 现有行） | bootstrap 第 7 节 |
| 机器规格（上游建议 2c/4G，见 `docs/deploy.md`「用 Docker（推荐）」第一句）与常驻进程数（**四个** Node 进程：brain/api/worker/web，见 §5 与 `systemd/`） | 预检打印，人工判 |
| 子域 `geohot.xxc2007.me` 是否可作退路（若 §0-4 那条子路径路线出问题） | 决定权在 owner |

## 4. 组件与端口（代码实测）

- api：`apps/api/src/main.ts:17` 绑 `API_HOST||127.0.0.1`，`API_PORT` 缺省 3001（`packages/backend/src/config.ts:72` 的 `apiPort: int("API_PORT", 3001)`）。健康路径 `GET /api/health`（`apps/api/src/app.ts` 里 `app.get("/api/health", …)` 那一条）。
- web：`apps/web/server.ts:12-13` 绑 `WEB_HOST||127.0.0.1:3000`；api-owned 路径由 web 自己转给 3001（`server.ts` 里 `if (isApiOwned(appPath))` 那一整块 × `packages/contracts/src/http-policy.ts` 的 `API_OWNED_PATTERNS`）⇒ **nginx 只需指向 3000**。
- worker：无监听口；pg-boss 全 cron 队列 `policy:"singleton"`（`apps/worker/src/schedules.ts:102`）⇒ **只许一个实例**（详见 unit 文件注释）。停机 grace 255 s（`packages/backend/src/jobs/queue.ts` 的 `STOP_TIMEOUT_MS`，一次开了思考的调用上限 240 s），`TimeoutStopSec=285`。
- brain（编辑大脑 stub）：`tooling/brain-stub.ts:26` 读 `BRAIN_PORT`（缺省 3055），`:1012` 的 `server.listen(PORT, "127.0.0.1")` 只绑回环、无鉴权。它是第四个常驻进程，`systemd/geohot-brain.service` 就是它的 unit（以前只有 install-units.sh 会写它，模板目录里缺文件）。
- 上传：截图 ≤ 8 MB（`packages/backend/src/operations/feedback.ts:64`）< Fastify bodyLimit 10 MB（`apps/api/src/app.ts:30`）⇒ `client_max_body_size 10m`。
- MCP：`/api/mcp` 方法集 GET/POST/DELETE(+OPTIONS 204, PUT/PATCH→405)（`routes/mcp.ts:293-305`）；SSE 订阅流带 `X-Accel-Buffering: no`（`mcp.ts:285`）⇒ 专用 location 关缓冲、读超时 1 h；host 锁只比 hostname（`mcp.ts:219-220,254-255`），前缀路径不需要 `MCP_ALLOWED_HOSTS`。

## 5. `.env`：生产必须与本机不同的取值（逐项核对表）

| 键 | 生产值 | 为什么 |
|---|---|---|
| `NODE_ENV` | `production` | 触发 `assertProductionSecrets`（`config.ts:12,127-137`）：占位密钥/`DEV_AUTH_*`/`ALLOW_PRIVATE_NETWORK_FETCH` 直接拒启 |
| `AIHOT_ENVIRONMENT` | `production` | **另一个**门禁：开发免登录后门看它（`config.ts:90` + `admin/auth.ts`），`ADMIN_PASSWORD≥12` 的启动检查也看它（`apps/api/src/main.ts:12-14`）。只设 NODE_ENV 不设它 = 后门还在。`SITE_URL` 那道新闸门两个都看（`config.ts:20`） |
| `DEV_AUTH_ROLE` 等 | **整行删除** | 残留即拒启（`config.ts:134`）——这是特性：以"起进程看不肯起"验证，README §10.1。bootstrap 第 5 节也会把它当场挑出来 |
| `SITE_URL` | `https://xxc2007.me/geohot` | 一切绝对链接唯一来源（`config.ts:77`）；cookie `Secure` 随 https 前缀自动正确（`routes/admin-auth.ts:23`）。**2026-10-02 起生产不再容忍缺值或 localhost**：`NODE_ENV`/`AIHOT_ENVIRONMENT` 有一个是 production 时，缺值或 `http://localhost:3000` 直接拒启（`config.ts:54-68`），因为回落会把 localhost 写进 canonical/OG/RSS/sitemap/robots/security.txt，并让 MCP 的 host 锁（`routes/mcp.ts:219`）拒掉真域名。路径部分必须等于 `GEOHOT_BASE_PATH`（bootstrap 第 5 节实测这一条） |
| `TRUST_PROXY` | 本站这台：`true`（前面确实有 nginx）。**它是拓扑事实，不是一律 true** —— 前面没有反代就必须 `false` | **两个进程都读它**，写法一致（只有字符串 `true` 算开）：`apps/web/server.ts:20` 与 `apps/api/src/app.ts:28` 的 `trustProxy`。api 侧以前是写死 `true`、与这一行无关，2026-10-02 起改成读同一个开关——于是"设 false 就保护登录与反馈限流"这句话第一次变成真的，反过来**这一行没写 = api 也不再信 XFF**，反代同机时全体访客都算成 127.0.0.1（`routes/admin-auth.ts:26-41` 的每地址 10 次会变成全局共用）。写 true 而前面没有反代同样有代价：那等于允许客户端自报 `X-Forwarded-For`，这两个限流当场失效（`docs/deploy.md`「配域名和 HTTPS」一节写明了两端取舍）。bootstrap 第 5 节因此不再无条件写 `true`：给了 `GEOHOT_TRUST_PROXY` 就用给的，否则实测 `nginx.service` 在不在跑再决定，判成 `false` 时会大声提示 |
| `SESSION_SECRET` `IMG_PROXY_SIGN_SECRET` | `openssl rand -hex 32` 各一 | 生产占位/短值拒启（`config.ts:132`）；`scripts/init-env.ts` 里的 `secret()`（`randomBytes(32).toString("hex")`）生成等价随机 |
| `ADMIN_PASSWORD` | ≥12 位真值 | `main.ts:12-14`；`changeme/placeholder/test/xxx/your-*` 会被 `PLACEHOLDER` 正则拦（`config.ts:124`） |
| `INGEST_TOKEN` | `openssl rand -hex 16` 起（≥16 位） | 人工投递通道（README §5）；本机现在没配所以一律 401，上线按内容计划要不要开 |
| `DATABASE_URL` | `postgres://geohot:<新密码>@127.0.0.1:5432/geohot` | **不要搬本机 5433 embedded 串**（README §3.6 那套是 Windows 开发机专用）。现在这一行由 `bootstrap-server.sh` 第 5 节按它自己建角色用的 `PG_*` 值写回，第 7 节再拿它真连一次（`psql … SELECT version()`），连不上就 exit 1 —— 以前只打印一句"照着抄"，两边各说各话 |
| `WEB_HOST`/`API_HOST` | `127.0.0.1`（缺省即对，显式写死） | 保证不对外监听；systemd 段里也硬覆盖 |
| `COLLECT_ENABLED` | `true`（免费 RSS 照采） | 缺省为开（`schedules.ts:36`）但必须显式写；采集本身不花钱（README §3.5） |
| `MODEL_CALLS_ENABLED` | **决定 1 的两条腿**：留 stub 进程则 `true` 且 `LLM_BASE_URL=http://127.0.0.1:3055/v1`（stub 只听回环、无鉴权，绝不暴露公网，README §4）；不留 stub 进程则 `false`，管道不再问模型，新料只进"全部"不进精选 | 缺省为开（`config.ts:92`）——不显式设 = 拿着 `LLM_API_KEY=local-brain` 占位去调一个可能没人听的端口，然后安静失败。bootstrap 第 5 节按 `GEOHOT_MODEL_CALLS`（默认 `true`）显式写入，`systemd/geohot-brain.service` 保证 true 那一侧真有进程 |
| `FEISHU_CONTENT_PUSH_ENABLED` `FEISHU_INTERNAL_ENABLED` | `false` | 没接飞书（README §3.5 阀门表） |
| `INDEXNOW_SUBMIT_ENABLED` | `false` | 前缀部署下 key 文件落 `/geohot/<key>.txt` 的可达性未确认（DEPLOY-PLAN §3） |
| `TZ` | `Asia/Shanghai` | cron 表已按 tz 注册（`schedules.ts:103`），worker/api 日志与 beijingDate 口径一致；四个 unit 的 `Environment=TZ=` 里也写死 |
| `LLM_API_KEY` | 若走 stub：保持非空占位（如 `local-brain`）并**人工**确认 LLM_BASE_URL 指向回环 | 注意 `local-brain` 不在占位黑名单（11 字符、不匹配 `config.ts:124`），代码拦不住，靠本表核对 |

上线验收口径（README §10.1）：起进程**应该**在密钥没配好时拒绝启动；配好后 `curl -i https://xxc2007.me/geohot/api/admin/sources` 必须 401/403。

## 6. 备份制度

- 应用内建 `ops.backup` 每日 04:10（`schedules.ts:74`）**需要两件事**：外部 `pg_dump` 二进制（`operations/backup.ts:83` 调它；本机 embedded bundle 里没有，README §3.6/§10.6）+ 配齐 `DB_BACKUP_STORE_SECRET_ID/KEY/BUCKET/REGION` 四个（`backupConfigured()`）。**预检会实测服务器有没有 pg_dump**；生产 PostgreSQL（apt 装 `postgresql-client` 后）会有。
- 推荐照抄 owner 纪念册的既有模式：每日 cron `pg_dump | gzip` 推到私有仓库：
  ```cron
  30 4 * * * sudo -u postgres pg_dump geohot | gzip > /opt/geohot/backups/geohot-$(date +\%F).sql.gz && <git 推送私有仓>
  ```
  反馈截图目录（`.data/feedback-screenshots`，`feedback.ts:67`）不进 pg_dump；应用备份逻辑本来就排除它（`backup.ts:90`），量小可整目录 rsync 或不管。
- 若决定用应用内建路线：装对象存储凭据进 `.env`，cron 自动注册，无需上面的 crontab。二选一，不要都做。
- **每周再加一份 custom format**（`-Fc`），因为下面 6.1 的恢复用的是 `pg_restore`：纯文本 `.sql.gz` 只能 `psql -f` 整库灌回去，`-Fc` 才能按表挑（`pg_restore -l` / `-n` / `-e`）、自带压缩、而且 dump 里有 `--if-not-exists` 之类的余地。**`-Fc` 也支持 `pg_restore -j` 并行恢复**（本站支持的 PostgreSQL 16 与 17 的 pg_restore 文档都写着 "Only the custom and directory archive formats are supported with this option"）—— 有资料说"并行只能 `-Fd`"，那是旧版本的口径，别照着它把这条改回去。上面那条 cron 是 owner 已有的作业，不改它；另加一条：
  ```cron
  45 4 * * 0 sudo -u postgres pg_dump -Fc geohot -f /opt/geohot/backups/geohot-weekly-$(date +\%F).dump && <git-lfs 或 rsync 推离线>
  ```
  两份都要**离开这台机器**一份（另一台机、对象存储、或 owner 的私有仓）——只在原盘上的备份等于没有备份。

### 6.1 恢复（restore）——把线上数据搬到新机器也是这一节

以前只有备份有文档、恢复没有：真要把数据搬到新服务器时没有任何写下来的办法。下面这条序列就是那个办法，
按序号做，**每一步都不许跳**。默认新机器已经按 §2 的 ①~③ 装好代码、`.env` 已人工核对（但还没跑过 migrate/seed）。

1. **在旧机上出一份 custom format dump**（不要在同一台机器上直接灌，先落地）：
   ```bash
   sudo -u postgres pg_dump -Fc --no-owner --no-privileges geohot -f /opt/geohot/backups/geohot-$(date +%F).dump
   ls -l /opt/geohot/backups/geohot-*.dump    # 大小和日期看一眼，0 字节的 dump 比没有 dump 更危险
   ```
   `--no-owner --no-privileges` 是因为新机器的角色表不同：带着旧 OID 的属主信息会在 `pg_restore` 时报一堆没用的错。
2. **传到新机**（scp 或 rsync，别用会被压缩改动的通道）：
   ```bash
   scp <ssh-user>@<server-ip>:/opt/geohot/backups/geohot-<date>.dump /tmp/
   sudo chown geohot:geohot /tmp/geohot-<date>.dump && sudo chmod 600 /tmp/geohot-<date>.dump
   ```
3. **在新机上建空库并交给 geohot 拥有**（两种写法任一种，角色必须已存在——即 §2 的第 ⑤ 步之前先做好第 ⑤ 步的角色部分）：
   ```bash
   sudo -u postgres createdb -O geohot geohot        # 或者：
   sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE geohot OWNER geohot"
   ```
   库名与属主要和 `.env` 的 `DATABASE_URL` 一致；新库必须是**空的**（`pg_restore` 不会先清表，往有表的库里灌会 duplicate/冲突）。
4. **灌进去**。`-j` 对 `-Fc` 是有效的（见上面 §6 那条：PG 16/17 的 pg_restore 都支持 custom 与 directory 两种格式并行恢复），并行度按核数但别超过 4 —— 891 MB 的机器上每个 job 是一条独立连接、各自吃一份工作内存：
   ```bash
   sudo -u geohot pg_restore -d postgres://geohot:<口令>@127.0.0.1:5432/geohot -j 2 --no-owner --no-privileges /tmp/geohot-<date>.dump
   ```
   `-j` 的三条真限制（不是格式）：**输入必须是磁盘上的文件或目录**（管道与 stdin 会让它被忽略）、不能与 `--single-transaction` 同用、只在与数据库直连时生效（`--file` 出脚本时它被忽略）。上面这条命令三条都满足。
   报 `extension "pg_trgm" does not available` 之类的话 → 就是 §2 第 ④ 步那个坑（contrib 没装 / 版本不在 16–17），先按第 6 节那个消息装包再重来。
5. **数一遍七张关键表**（数量与旧机对得上才算恢复成功，不是"没报错"就算）。这七张表都实测存在于 `database/migrations/`：`topics`（0002）、`sources`/`publications`/`articles`/`selected_ledger`（0001）、`story_digests`/`reports`（0002）：
   ```bash
   sudo -u postgres psql -d geohot -tAc "SELECT 'topics',       count(*) FROM topics
                                       UNION ALL SELECT 'sources',       count(*) FROM sources
                                       UNION ALL SELECT 'publications',  count(*) FROM publications
                                       UNION ALL SELECT 'digests',       count(*) FROM story_digests
                                       UNION ALL SELECT 'articles',      count(*) FROM articles
                                       UNION ALL SELECT 'reports',       count(*) FROM reports
                                       UNION ALL SELECT 'selected',      count(*) FROM selected_ledger;"
   ```
   旧机跑同一条对比；差一条就要么是 dump 不完整，要么是中途 `pg_restore` 报错被吞了（`pg_restore` 的退出码对单表错误不敏感，务必看它的 stderr）。
   顺手实测一条中文相似度，locale 不对的话搜索会在恢复之后仍然"恒空"：
   `sudo -u postgres psql -d geohot -tAc "SELECT similarity('三角洲','河流三角洲')"`。
6. **起服务并重跑冒烟**（顺序：brain → api → worker → web，四个都要 active）：
   ```bash
   sudo systemctl start geohot-brain geohot-api geohot-worker geohot-web
   bash verify-deploy.sh                                   # 全绿
   node /opt/geohot/app/scripts/smoke.ts --base https://xxc2007.me/geohot
   ```
   `smoke.ts` 是只读的（它打 GET、比状态码与形状），可以在线上直接跑。
7. **最后清场**：删 `/tmp` 里那份 dump（里面是全部读者内容与后台身份数据），确认新库的定时任务真的在跑——
   看应用自己记账的那张表就行（`sudo -u postgres psql -d geohot -tAc "SELECT job, status, finished_at FROM job_runs ORDER BY id DESC LIMIT 10;"`，
   列名以 `database/migrations/0004_admin_ops.sql:97-104` 为准；pg-boss 自己的表在 `pgboss` schema 下，不用手查），
   以及 `.data/`（反馈截图、图片缓存）真的 rsync 过来了——那部分**不在 dump 里**。

搬机器最常见的两个"看起来成功了"：忘了同步 `.data/`（反馈截图 404）、`.env` 里的 `SITE_URL`/口令还是旧机的（页面能开，RSS 与分享图里的链接指向旧域名）。第 10 节那张清单就是把这两个坑写全的。

## 7. 预期故障模式与日志签名

| 症状 | 日志签名（journalctl / nginx error） | 根因与处置 |
|---|---|---|
| api/worker 起不来即退 | `Refusing to start in production: <键名列表>`（`config.ts:136` throw） | §5 的密钥有占位/短值/`DEV_AUTH_*` 残留；按签名里点名的键修 |
| api/worker 起不来，点名 SITE_URL | `Refusing to start in production: SITE_URL is "http://localhost:3000" — set it to the address readers actually use …`（`config.ts:54-68`） | `.env` 里 `SITE_URL` 没改或写成本机串：绝对链接会全写成 localhost，MCP 还会 421。填读者实际访问的地址（含前缀），两个 production 变量都要有 |
| api 起不来另一形态 | `Refusing to start in production: set ADMIN_PASSWORD ...`（`apps/api/src/main.ts:13`） | `AIHOT_ENVIRONMENT=production` 但密码 <12 位 |
| web 崩溃循环 | `ERR_MODULE_NOT_FOUND ... build/server/index.js`（`server.ts:39` 动态 import） | 忘了 `npm run build -w @aihot/web`，或 build 后 `npm ci` 清了目录 |
| 端口冲突 | `EADDRINUSE 127.0.0.1:3000` | 预检没做/主站占了口：改 `WEB_PORT` 并同步 nginx 片段 |
| 页面 200 但全站无样式、控制台 MIME/404 | nginx access log 里 `/assets/...` 打到主站根 location | **构建没带 BASE_PATH**（或带了但和 nginx 前缀不一致）：verify §3 会红。用 `GEOHOT_BASE_PATH=<前缀>` 重新构建（bootstrap 第 9 节），别去改 nginx 的前缀凑数 |
| 首页能开、点进 `/all` 再点回来 404 | 浏览器地址栏是裸 `/geohot`（无尾斜杠），控制台是应用自己的 404 | 那条 `location = /geohot { return 308 … }` 不在了 —— 它是承重的（`fix-bare-path.sh` 开头那段 "the trailing-slash redirect is load-bearing and must stay"）。按 `geohot.nginx.conf片段` 里 `# ---- ADD ----` 之后第一块补回去（**:80 与 :443 两个 server 块都要**，见片段第 3 条），或跑 `bash fix-bare-path.sh` 先看计划再 `--apply`；`nginx -t` 通过才 reload |
| 带截图的反馈 413 | nginx error `client request body ... too large`（默认 1 m） | 忘贴 `client_max_body_size 10m`（上限依据 `feedback.ts:64`+`app.ts:30`） |
| MCP 客户端报 misdirected | 应用返回 `{"error":"misdirected_request"}` 421（`mcp.ts:255`） | location 没传 `proxy_set_header Host $host`；X-Forwarded-Host 被改写；或 `SITE_URL` 的域名与实际访问域名不同（`mcp.ts:219`） |
| MCP 订阅流几分钟就断 | 客户端见流中断，nginx 无错误 | 没给 `/geohot/api/mcp` 单独 location：`proxy_buffering off; proxy_read_timeout 1h` 缺失（SSE 依据 `mcp.ts:285`） |
| 精选/热榜空、日报 0 节 | `/api/health` 正常、worker `worker started`，但 `job_runs` 里 `reports.daily` 成功而空 | 不是故障是内容口径：决定 1（stub 默认分进不了精选、默认 UNRELATED 不成事件）。补 fixture 或按需重跑 `npm run seed:curated -- --enforce-source` |
| 同上，但日志里有 `connect ECONNREFUSED 127.0.0.1:3055` | worker/api 每次分析调用都失败，站点却全绿 | **`geohot-brain` 没在跑而 `MODEL_CALLS_ENABLED=true`**（`config.ts:92` 的缺省就是 true）。`systemctl start geohot-brain`，或显式把这一行写成 false（§5 那条"决定 1 的两条腿"） |
| 全体访客都进不了后台登录 | `POST /api/auth/password` 303 到 `/admin/login?error=too-many` | `TRUST_PROXY` 没写 true（现在 api 也读它，`app.ts:28`），于是每个请求的 `req.ip` 都是 127.0.0.1，共用同一份每地址额度。改 `.env` 后**两个进程都要重启** |
| 定时任务重复跑 | `journalctl -u geohot-worker` 两个 pid 交错 `worker started` | 有人 scale/复制了 unit——**singleton 假设被破**（`schedules.ts:102`），只留一个 |
| 中文搜索恒空 | 无错误日志；`similarity('三角洲','河流三角洲')` 返回 0 | 集群 locale 不是 UTF-8/ICU 口径（README §3.6 坑二）；Ubuntu 系统 PG 一般 en_US.UTF-8 可用，**上线时在库内实测一条 similarity**（列在 §8 第 4 步后） |
| migrate 第一步就死 | `could not open extension control file ".../pg_trgm.control": No such file or directory` | 集群没有 `pg_trgm`（`database/migrations/0001_core.sql:4`）。Ubuntu 22.04 自带 PG 14 且 contrib 是另一个包：`sudo apt install postgresql-contrib`；线上那台是 PGDG 源的 17。bootstrap 第 6 节会先拦一道 |
| 重启后反馈/图片目录写失败 | systemd `Read-only file system` + errno EROFS | `ReadWritePaths=` 没覆盖 `AIHOT_DATA_DIR` 实际路径（模板里默认 `/opt/geohot/app/.data`；换过 `GEOHOT_APP_ROOT` 就要连这一行一起改，见 install-units.sh 与 bootstrap 第 10 节的那个警告） |

## 8. 我方拿到访问权后要跑的命令（精确序列）

```bash
cd ~/.deploy                       # 本目录拷贝到服务器后的位置
bash bootstrap-server.sh           # ① 看预检与 DRY 输出，逐项人工确认（版本/pg_trgm/端口/现状都在这里）
bash verify-deploy.sh --save-baseline   # ★ 主站基线，nginx 改动之前
bash bootstrap-server.sh --apply   # ② 建用户/目录/clone/npm ci/生成 .env，然后在**第 5 节**停手
                                   #    （.env 没核对过就不可能走到建角色、建库、迁移）
vim /opt/geohot/app/.env           # ③ §5 清单逐项核对（尤其两个 production 变量、SITE_URL 的前缀、各阀）
bash bootstrap-server.sh --apply   # 重跑：幂等，已建好的都跳过；这次第 5 节的断言应当全过并继续 ④~⑩
                                   #    非交互环境用 GEOHOT_I_REVIEWED_ENV=1 bash bootstrap-server.sh --apply
# 想改安装目录或前缀就在环境里带上：GEOHOT_APP_ROOT=… GEOHOT_BASE_PATH=… （根路径部署写 GEOHOT_BASE_PATH=""）；
# 拓扑不是"nginx 在前面"这一套时再带上 GEOHOT_TRUST_PROXY=true|false（见 §5 那一行的说明）
sudo -u postgres psql -d geohot -tAc "SELECT similarity('三角洲','河流三角洲')"   # locale 实测
# ⑦ 贴 nginx 片段 → sudo nginx -t → sudo systemctl reload nginx（片段头部那段"生效顺序"；
#   前缀必须与 GEOHOT_BASE_PATH 一致，且 :80 与 :443 两个 server 块都要 —— 片段第 3 条）
sudo systemctl start geohot-brain geohot-api geohot-worker geohot-web   # ⑧ 四个，顺序 brain→api→worker→web
bash verify-deploy.sh              # ⑨ 全绿才算上线完成（第 2 节会逐个断言四个单元 active）
                                   #    上线当天日报/热榜为空只记 note；过了第一个 08:00 就要带
                                   #    GEOHOT_DEPLOYED_AT=<上线日> 重跑，那两项会变成硬失败
node /opt/geohot/app/scripts/smoke.ts --base https://xxc2007.me/geohot
# ⑩ 备份 cron（§6）+ 当场按 §6.1 演练一次恢复，别等真出事才第一次跑它
```

任何一步红：`bash rollback.sh`（DRY 看清单）→ `bash rollback.sh --apply`。

## 9. 明确不做的事

- 不 `docker compose down -v`（会删 db/data/caddy 卷，出处是 `docs/deploy.md`「备份」一节末尾那句「`docker compose down` 不会删除它们；`docker compose down -v` 会」）；本包根本不用 Docker，除非预检发现服务器有且 owner 选容器路线。
- 不改 `pg_hba.conf` 现有行、不建其它 role/database、不 DROP 任何非 geohot 对象。
- 不 restart nginx、不动根 location、不动 Artalk 与 ACME stanza。
- 不把 brain stub 暴露公网（无鉴权，`README §4`）；不删主站任何文件。

## 10. 搬到新域名或新服务器（checklist）

换域名（`xxc2007.me` → 别的）、换机器、或从子路径搬到域名根，都是同一件事：**改四个地方、重发五枚密钥、重建一次前端**。
没有一份文档写过这个，所以这里逐条列全。按顺序做，每条后面都给了"怎么证明改到位"。

**A. 必须改的（改一处不够，四处是绑在一起的）**

| # | 要改的 | 位置 | 怎么证明 |
|---|---|---|---|
| 1 | `SITE_URL` | 新机 `.env` | `curl -s <新地址>/feed.xml \| grep -o 'https\?://[^<]*' \| sort -u` 只出现新域名；`curl -s <新地址>/ \| grep -o 'rel="canonical"[^>]*'` |
| 2 | **构建期** `BASE_PATH`（即 `GEOHOT_BASE_PATH`） | `bash bootstrap-server.sh` 的环境变量，第 9 节构建 | 首页 HTML 里每个 `href`/`src` 都带新前缀（`verify-deploy.sh` 第 3 节硬断言）；根路径部署要显式写 `GEOHOT_BASE_PATH=""` |
| 3 | nginx 的 `server_name` 与 `location` 前缀 | `/etc/nginx/sites-available/<新站点>`；前缀必须与第 2 条同值 | `sudo nginx -T \| grep -n 'server_name\|location'`；`:80` 与 `:443` 两个 vhost 都要（片段硬约束 3） |
| 4 | TLS 证书与 Cloudflare 的回源方式 | 新域名的 ACME/CF 设置 | `curl -sI https://<新域名><前缀>/` 是 200 且不是 52x；CF SSL 模式与回源协议对得上（本站是明文回源，所以那条 `return 308 https://$host/...` 才必须写死 https） |

**B. 必须重新签发的（不要把旧机器上的值搬过去——搬家是唯一一次"换密钥"的正当理由）**

1. `SESSION_SECRET`（签飞书 state 与反馈图 HMAC）；
2. `IMG_PROXY_SIGN_SECRET`（图片代理 HMAC：搬过去等于两个部署共用一枚签名密钥）；
3. `ADMIN_PASSWORD`（新机器上重设一枚 ≥12 位的；旧的若已经出现在终端历史里就更该换）；
4. `INGEST_TOKEN`（人工投递入口；`scripts/README-ingest.md` 那套 curl 要跟着换）；
5. 数据库角色口令（`ALTER ROLE geohot PASSWORD …` 或新机重建角色 + `.env` 的 `DATABASE_URL` 同步，`bootstrap-server.sh` 第 5~7 节会把两边对齐并实测连接）。

做法：`openssl rand -hex 32` 各一枚（或在新机上重跑 `node scripts/init-env.ts` 生成一份全新 `.env`，再把 §5 那张表的取值填进去），
**不要**把旧 `.env` 直接 scp 过去当新机配置（`.env` 里那五枚就是这次要换的）。旧机器继续跑的话，新机器换掉
`INGEST_TOKEN`/口令之后，旧机器上的对应入口会立刻失效——这是预期的，不是 bug。

**C. 内容与代码侧**

- `industry/**` 里任何改动（站名、文案、分类、信源、提示词、门槛、品牌、条款页）都**必须重建 web** 才生效：
  `BASE_PATH=<前缀> npm run build -w @aihot/web`。原因同 B/2——前缀和这些字符串都在构建期烧进 bundle，
  运行时改 env、重启进程都看不到（`apps/web/vite.config.ts:12-17`、`react-router.config.ts:7-12`）。
- 域名/主体信息在 `industry/site.ts`：`contactEmail`（`security.txt` 会公开它）、`icp` 备案号、`organization.*`
  ——这些只能站主本人填（`docs/manual.md` 第 10 节第 4 条）。
- 若新域名要求新的 MCP 访问主机名：`MCP_ALLOWED_HOSTS` 加上（`mcp.ts:219-220` 只比 hostname；
  `SITE_URL` 的域名本来就自动在允许表里）。
- 换的是**同一域名的根路径 ↔ 子路径**：`BASE_PATH`、`SITE_URL` 路径、nginx location 三处一起改（第 10 节 A 表），
  另外根路径部署要**删掉**那条 `location = /geohot` 的 308（根没有裸 basename 要规范化）。

**D. 搬家当天的验证（跑完再走）**

```bash
bash verify-deploy.sh                                   # 把 GEOHOT_BASE 指到新地址：GEOHOT_BASE=https://<新域名><前缀>
node <APP_ROOT>/scripts/smoke.ts --base https://<新域名><前缀>
sudo -u postgres psql -d geohot -tAc "SELECT count(*) FROM publications;"   # 与 §6.1 第 5 步那个数字一致
curl -s https://<新域名><前缀>/robots.txt | grep -i sitemap                 # Sitemap 行必须已经是新域名
```

旧机器什么时候下线：新域名连续跑过一整套 `verify-deploy.sh` 全绿、且确认旧库不再被写之后，再按 `rollback.sh`
的口径停单元；**数据库和 `.data/` 不要立刻删**，留到确认回滚不再需要为止（`rollback.sh` 默认也不删，这是刻意的）。
