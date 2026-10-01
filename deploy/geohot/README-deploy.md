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
| 3 | **公开仓库用干净单初始提交**（放弃 5 提交波次历史，删 `docs/assets/*.png`） | bootstrap 的 clone 地址以 GitHub 新仓库为准（脚本里的 `REPO_URL` 是占位） |
| 4 | **子路径 `/geohot/` 的实现待验证**（vite base、basename、约 40 处根绝对字面量的改造由其他 agent 进行中） | nginx 片段按"剥前缀"写并给了不剥前缀的切换法；**verify-deploy.sh 第 3 节会硬断言资源不回落根**——改造没完成就上线必红 |

## 1. 动手前先备份（owner 在服务器上执行）

1. 主站/nginx：`sudo cp -a /etc/nginx/sites-available/xxc2007.me{,.bak-$(date +%F-%H%M)}`；`sudo ufw status numbered > ~/ufw-before.txt`。
2. 基线哈希（**必须在任何 nginx 改动之前**）：`bash verify-deploy.sh --save-baseline`（记录主站首页与 sitemap 的 sha256）。
3. Artalk 是 systemd + SQLite（不占 PostgreSQL），它的 db 文件照常纳入 owner 现有备份；本部署不碰它。
4. GEOHOT 侧无历史数据可备（新库），但 `.env` 一旦生成立刻 `cp .env .env.bak-日期`——密钥只打印一次。

## 2. 顺序（不可颠倒）

```text
① 预检/澄清（bootstrap DRY-RUN 打印）→ ② 建用户/目录/clone/npm ci/建 .env（bootstrap --apply）
→ ③ PostgreSQL 角色与库（bootstrap --apply 第 5 节）→ ④ migrate/seed/seed:curated/build（同脚本）
→ ⑤ 人工核对 .env（§5 清单！）→ ⑥ 贴 nginx 片段：nginx -t 过了才 reload（片段尾部流程）
→ ⑦ systemctl enable --now 三个 unit → ⑧ bash verify-deploy.sh 全绿 → ⑨ 每日备份 cron（§6）
```

- 为什么 nginx 在服务启动之后：先 502 可控，先改 nginx 再把主站搞挂不可控。
- `reload` 永远不是 `restart`；`nginx -t` 不过就停手，不许带病 reload。
- 回滚一律走 `rollback.sh`（默认 DRY-RUN；`--purge-database` 才会删库，且删前强制 pg_dump）。

## 3. 需要 owner 提供 / 确认的（脚本里全部做成 PREFLIGHT CHECK，不假定）

| 项 | 取值处 |
|---|---|
| 服务器进入方式（`xxc` 用户公钥 + `sudo -l`，不给 root 口令） | 人工 |
| 有没有 Docker/Compose；PostgreSQL 是否已装、版本、`psql`/`pg_dump` 是否可用 | bootstrap 预检只读探测 |
| 3000/3001 是否空闲（纪念册站口占用则改 `WEB_PORT/API_PORT` 并同步 nginx 片段） | 预检 `ss -ltnp` |
| 允许 `CREATE ROLE geohot` + `CREATE DATABASE geohot`（非 superuser，不改 pg_hba 现有行） | bootstrap 第 5 节 |
| 机器规格（上游建议 2c/4G，`docs/deploy.md:5`）与常驻进程数（api/worker/web(+brain stub 若留在生产)=3~4 个 Node 进程） | 预检打印，人工判 |
| 子域 `geohot.xxc2007.me` 是否可作退路（若 §0-4 验证失败） | 决定权在 owner |

## 4. 组件与端口（代码实测）

- api：`apps/api/src/main.ts:17` 绑 `API_HOST||127.0.0.1`，`API_PORT` 缺省 3001（`config.ts:38`）。健康路径 `GET /api/health`（`app.ts:60`）。
- web：`apps/web/server.ts:12-13` 绑 `WEB_HOST||127.0.0.1:3000`；api-owned 路径由 web 自己转给 3001（`server.ts:135-149` × `contracts/http-policy.ts:110-122`）⇒ **nginx 只需指向 3000**。
- worker：无监听口；pg-boss 全 cron 队列 `policy:"singleton"`（`schedules.ts:102`）⇒ **只许一个实例**（详见 unit 文件注释）。停机 grace 195 s（`jobs/queue.ts:63`），`TimeoutStopSec=210`。
- 上传：截图 ≤ 8 MB（`operations/feedback.ts:64`）< Fastify bodyLimit 10 MB（`app.ts:26`）⇒ `client_max_body_size 10m`。
- MCP：`/api/mcp` 方法集 GET/POST/DELETE(+OPTIONS 204, PUT/PATCH→405)（`routes/mcp.ts:293-305`）；SSE 订阅流带 `X-Accel-Buffering: no`（`mcp.ts:285`）⇒ 专用 location 关缓冲、读超时 1 h；host 锁只比 hostname（`mcp.ts:219-220,254-255`），前缀路径不需要 `MCP_ALLOWED_HOSTS`。

## 5. `.env`：生产必须与本机不同的取值（逐项核对表）

| 键 | 生产值 | 为什么 |
|---|---|---|
| `NODE_ENV` | `production` | 触发 `assertProductionSecrets`（`config.ts:12,92-102`）：占位密钥/`DEV_AUTH_*`/`ALLOW_PRIVATE_NETWORK_FETCH` 直接拒启 |
| `AIHOT_ENVIRONMENT` | `production` | **另一个**门禁：开发免登录后门看它（`config.ts:55` + `admin/auth.ts`），`ADMIN_PASSWORD≥12` 的启动检查也看它（`apps/api/src/main.ts:12-14`）。只设 NODE_ENV 不设它 = 后门还在 |
| `DEV_AUTH_ROLE` 等 | **整行删除** | 残留即拒启（`config.ts:99`）——这是特性：以"起进程看不肯起"验证，README §10.1 |
| `SITE_URL` | `https://xxc2007.me/geohot` | 一切绝对链接唯一来源（`config.ts:42`）；cookie `Secure` 随 https 前缀自动正确（`routes/admin-auth.ts:23`） |
| `TRUST_PROXY` | `true` | `server.ts:20` 决定信不信 X-Forwarded-For（反馈限流/登录尝试按真实 IP）；api 侧 `trustProxy` 恒开（`app.ts:24`） |
| `SESSION_SECRET` `IMG_PROXY_SIGN_SECRET` | `openssl rand -hex 32` 各一 | 生产占位/短值拒启（`config.ts:97`）；`init-env.ts:15-18` 生成等价随机 |
| `ADMIN_PASSWORD` | ≥12 位真值 | `main.ts:12-14`；`changeme/placeholder/test/xxx/your-*` 会被 `PLACEHOLDER` 正则拦（`config.ts:89`） |
| `INGEST_TOKEN` | `openssl rand -hex 16` 起（≥16 位） | 人工投递通道（README §5）；本机现在没配所以一律 401，上线按内容计划要不要开 |
| `DATABASE_URL` | `postgres://geohot:<新密码>@127.0.0.1:5432/geohot` | **不要搬本机 5433 embedded 串**（README §3.6 那套是 Windows 开发机专用） |
| `WEB_HOST`/`API_HOST` | `127.0.0.1`（缺省即对，显式写死） | 保证不对外监听；systemd 段里也硬覆盖 |
| `COLLECT_ENABLED` | `true`（免费 RSS 照采） | 缺省为开（`schedules.ts:36`）但必须显式写；采集本身不花钱（README §3.5） |
| `MODEL_CALLS_ENABLED` | **决定 1 的两条腿**：留 stub 进程则 `true` 且 `LLM_BASE_URL=http://127.0.0.1:3055/v1`（stub 只听回环、无鉴权，绝不暴露公网，README §4）；不留 stub 进程则 `false`，管道不再问模型，新料只进"全部"不进精选 | 缺省为开（`config.ts:57`）——不显式设 = 拿着 `LLM_API_KEY=local-brain` 占位去调真接口然后失败 |
| `FEISHU_CONTENT_PUSH_ENABLED` `FEISHU_INTERNAL_ENABLED` | `false` | 没接飞书（README §3.5 阀门表） |
| `INDEXNOW_SUBMIT_ENABLED` | `false` | 前缀部署下 key 文件落 `/geohot/<key>.txt` 的可达性未确认（DEPLOY-PLAN §3） |
| `TZ` | `Asia/Shanghai` | cron 表已按 tz 注册（`schedules.ts:103`），worker/api 日志与 beijingDate 口径一致；unit 的 EnvironmentFile 里带 |
| `LLM_API_KEY` | 若走 stub：保持非空占位（如 `local-brain`）并**人工**确认 LLM_BASE_URL 指向回环 | 注意 `local-brain` 不在占位黑名单（11 字符、不匹配 `config.ts:89`），代码拦不住，靠本表核对 |

上线验收口径（README §10.1）：起进程**应该**在密钥没配好时拒绝启动；配好后 `curl -i https://xxc2007.me/geohot/api/admin/sources` 必须 401/403。

## 6. 备份制度

- 应用内建 `ops.backup` 每日 04:10（`schedules.ts:74`）**需要两件事**：外部 `pg_dump` 二进制（`operations/backup.ts:83` 调它；本机 embedded bundle 里没有，README §3.6/§10.6）+ 配齐 `DB_BACKUP_STORE_SECRET_ID/KEY/BUCKET/REGION` 四个（`backupConfigured()`）。**预检会实测服务器有没有 pg_dump**；生产 PostgreSQL（apt 装 `postgresql-client` 后）会有。
- 推荐照抄 owner 纪念册的既有模式：每日 cron `pg_dump | gzip` 推到私有仓库：
  ```cron
  30 4 * * * sudo -u postgres pg_dump geohot | gzip > /opt/geohot/backups/geohot-$(date +\%F).sql.gz && <git 推送私有仓>
  ```
  反馈截图目录（`.data/feedback-screenshots`，`feedback.ts:67`）不进 pg_dump；应用备份逻辑本来就排除它（`backup.ts:90`），量小可整目录 rsync 或不管。
- 若决定用应用内建路线：装对象存储凭据进 `.env`，cron 自动注册，无需上面的 crontab。二选一，不要都做。

## 7. 预期故障模式与日志签名

| 症状 | 日志签名（journalctl / nginx error） | 根因与处置 |
|---|---|---|
| api/worker 起不来即退 | `Refusing to start in production: <键名列表>`（`config.ts:101` throw） | §5 的密钥有占位/短值/`DEV_AUTH_*` 残留；按签名里点名的键修 |
| api 起不来另一形态 | `Refusing to start in production: set ADMIN_PASSWORD ...`（`apps/api/src/main.ts:13`） | `AIHOT_ENVIRONMENT=production` 但密码 <12 位 |
| web 崩溃循环 | `ERR_MODULE_NOT_FOUND ... build/server/index.js`（`server.ts:39` 动态 import） | 忘了 `npm run build -w @aihot/web`，或 build 后 `npm ci` 清了目录 |
| 端口冲突 | `EADDRINUSE 127.0.0.1:3000` | 预检没做/主站占了口：改 `WEB_PORT` 并同步 nginx 片段 |
| 页面 200 但全站无样式、控制台 MIME/404 | nginx access log 里 `/assets/...` 打到主站根 location | **决定 4 的子路径改造未完成**：verify §3 会红。停滚动回 nginx，等构建带 base/basename 后重验 |
| 带截图的反馈 413 | nginx error `client request body ... too large`（默认 1 m） | 忘贴 `client_max_body_size 10m`（上限依据 `feedback.ts:64`+`app.ts:26`） |
| MCP 客户端报 misdirected | 应用返回 `{"error":"misdirected_request"}` 421（`mcp.ts:255`） | location 没传 `proxy_set_header Host $host`；X-Forwarded-Host 被改写 |
| MCP 订阅流几分钟就断 | 客户端见流中断，nginx 无错误 | 没给 `/geohot/api/mcp` 单独 location：`proxy_buffering off; proxy_read_timeout 1h` 缺失（SSE 依据 `mcp.ts:285`） |
| 精选/热榜空、日报 0 节 | `/api/health` 正常、worker `worker started`，但 `job_runs` 里 `reports.daily` 成功而空 | 不是故障是内容口径：决定 1（stub 默认分进不了精选、默认 UNRELATED 不成事件）。补 fixture 或按需重跑 `npm run seed:curated -- --enforce-source` |
| 定时任务重复跑 | `journalctl -u geohot-worker` 两个 pid 交错 `worker started` | 有人 scale/复制了 unit——**singleton 假设被破**（`schedules.ts:102`），只留一个 |
| 中文搜索恒空 | 无错误日志；`similarity('三角洲','河流三角洲')` 返回 0 | 集群 locale 不是 UTF-8/ICU 口径（README §3.6 坑二）；Ubuntu 系统 PG 一般 en_US.UTF-8 可用，**上线时在库内实测一条 similarity**（列在 §8 第 4 步后） |
| 重启后反馈/图片目录写失败 | systemd `Read-only file system` + errno EROFS | `ReadWritePaths=` 没覆盖 `AIHOT_DATA_DIR` 实际路径（unit 里默认 `/opt/geohot/GEOHOT/.data`） |

## 8. 我方拿到访问权后要跑的命令（精确序列）

```bash
cd ~/.deploy                       # 本目录拷贝到服务器后的位置
bash bootstrap-server.sh           # 看预检与 DRY 输出，逐项人工确认
bash verify-deploy.sh --save-baseline   # ★ 主站基线，nginx 改动之前
bash bootstrap-server.sh --apply   # 第 2~8 节
vim /opt/geohot/GEOHOT/.env        # §5 清单逐项核对（尤其两个 production 变量与阀）
sudo -u postgres psql -d geohot -tAc "SELECT similarity('三角洲','河流三角洲')"   # locale 实测
# 贴 nginx 片段 → sudo nginx -t → sudo systemctl reload nginx（片段尾部流程）
sudo systemctl start geohot-api geohot-worker geohot-web
bash verify-deploy.sh              # 全绿才算上线完成
node /opt/geohot/GEOHOT/scripts/smoke.ts --base https://xxc2007.me/geohot
```

任何一步红：`bash rollback.sh`（DRY 看清单）→ `bash rollback.sh --apply`。

## 9. 明确不做的事

- 不 `docker compose down -v`（会删 db/data/caddy 卷，`docs/deploy.md:63`）；本包根本不用 Docker，除非预检发现服务器有且 owner 选容器路线。
- 不改 `pg_hba.conf` 现有行、不建其它 role/database、不 DROP 任何非 geohot 对象。
- 不 restart nginx、不动根 location、不动 Artalk 与 ACME stanza。
- 不把 brain stub 暴露公网（无鉴权，`README §4`）；不删主站任何文件。
