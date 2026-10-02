# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
npm run env:init                       # 写出 .env 与 .env.pipeline，已存在就不覆盖；管理员密码只打印一次
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。它**只认四个端口开关**
`--db-port / --api-port / --web-port / --brain-port`（`scripts/init-env.ts:35-40`）——**没有 `--llm-key` 这种参数，
未知参数会被静默忽略**：写 `--llm-key <key>` 不报错，但那个 key 一个字节都不会落进 `.env`。模型接口要用
真服务商时，生成完再手工改 `.env` 的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 三行（本机默认指向
`tooling/brain-stub.ts` 那个本地"编辑大脑"，`LLM_API_KEY=local-brain` 是占位串）。

`.env` 里 `SITE_URL` 这一行在 `NODE_ENV=production`（compose 已写死，`docker-compose.yml:11`）时**不能留空也不能留
`http://localhost:3000`**：现在会直接拒绝启动（`packages/backend/src/config.ts:54-68`），因为那个回落会把 localhost
写进 canonical、OpenGraph、RSS、sitemap、robots 的 Sitemap 行和 security.txt，还会让 MCP 的 host 锁拒掉真域名。
第一次起容器前就把它改成读者实际访问的地址（下面"配域名和 HTTPS"那一节）。

机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）、`INGEST_TOKEN`、`SITE_URL` 和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读（web 与 api 两个进程都读这一行）
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。这一行**两个进程都读、写法一致**（`apps/web/server.ts:20` 与 `apps/api/src/app.ts:28` 的 `trustProxy`）：不设为 `true`，登录与反馈的每地址限流就会把全体访客算成代理那一个 IP；直接对外（前面没有代理）时才保持 `false`，那时信 `X-Forwarded-For` 等于让客户端自报地址。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它；生产下留空或留 `localhost` 会拒绝启动（`packages/backend/src/config.ts:54-68`）。挂在子路径（如 `/geohot`）上还要带构建期变量 `BASE_PATH=/geohot` 重新 `npm run build -w @aihot/web`，并把 `SITE_URL` 写成带前缀的地址——`deploy/geohot/` 那一套（nginx 片段、systemd 单元、`bootstrap-server.sh` 的 `GEOHOT_BASE_PATH`）是这条路线的完整装法。

### 更新

```bash
git pull
docker compose up -d --build
```

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
docker compose exec -T db pg_dump -Fc -U aihot aihot > myhot-$(date +%F).dump   # 恢复用这一份
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 恢复（把数据搬到新机器也是这一套）

备份一直有文档，恢复以前没有——真出事时就没有写下来的办法。编号做，别跳：

1. 确认新机器上容器能起（`docker compose up -d db`），并且 `db` 卷是**空的**：`docker compose exec -T db psql -U aihot -d postgres -tAc "SELECT datname FROM pg_database"` 只应有 `postgres`/`template0`/`template1`/`aihot`（`aihot` 由镜像的 initdb 建好，空的就直接用）。
2. 把 dump 放进容器能读到的地方：`docker compose cp myhot-<日期>.dump db:/tmp/d.dump`。
3. 灌回去（custom format 用 `pg_restore`，不是 `psql`）：
   ```bash
   docker compose exec -T db pg_restore -U aihot -d aihot --no-owner --no-privileges /tmp/d.dump
   ```
   纯文本那份 `.sql.gz` 则是 `gunzip -c myhot-<日期>.sql.gz | docker compose exec -T db psql -U aihot -d aihot`。
4. 数一遍关键表，跟旧机对得上才算成功（不是"没报错"就算）：
   ```bash
   docker compose exec -T db psql -U aihot -d aihot -tAc \
     "SELECT 'topics',count(*) FROM topics UNION ALL SELECT 'sources',count(*) FROM sources
      UNION ALL SELECT 'publications',count(*) FROM publications UNION ALL SELECT 'digests',count(*) FROM story_digests
      UNION ALL SELECT 'articles',count(*) FROM articles UNION ALL SELECT 'reports',count(*) FROM reports"
   ```
5. `docker compose up -d` 起全栈，再跑仓库自带的冒烟：`node scripts/smoke.ts --base http://<服务器地址>:3000`。
6. 搬家还必须**重新签发**`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`ADMIN_PASSWORD`、`INGEST_TOKEN` 和数据库口令，
   并把 `SITE_URL` 改成新地址——详见 `deploy/geohot/README-deploy.md` 第 6.1 与第 10 节（那份是 nginx/systemd 路线，
   清单本身两条路线通用：改什么、重发什么、为什么改 `industry/**` 必须重建前端）。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL **16 或 17**，而且集群里必须能用 `pg_trgm`
（第一条迁移 `database/migrations/0001_core.sql:4` 就是 `CREATE EXTENSION IF NOT EXISTS pg_trgm`；事件归并与
中文搜索靠它）。Ubuntu 22.04 自带的是 PostgreSQL 14、contrib 还拆成另一个包，两条都要先解决：

```bash
sudo apt install postgresql-contrib                       # 14 那条路：版本仍然不达标，迁移会报 pg_trgm.control 找不到
# 推荐装 PGDG 源的 17：https://apt.postgresql.org/  → sudo apt install postgresql-17-pgdg postgresql-client-17-pgdg
# （已上线那台机器的 17 就是这么装的）
psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm'"   # 必须返回一行
```

`deploy/geohot/bootstrap-server.sh` 第 6 节把这两条做成了硬预检（不达标就 exit 1 并给出包名），
`docs/manual.md` 第 3 节是本机开发机的跑法（embedded PostgreSQL 17，端口 5433），与这里的系统装法不同。

```bash
npm ci
npm run env:init                      # 生成 .env 与 .env.pipeline，已存在不覆盖；管理员密码只打印一次
createdb myhot
```

`init-env.ts` 只接受 `--db-port / --api-port / --web-port / --brain-port` 四个开关（`scripts/init-env.ts:35-40`），
**其它参数会被静默忽略、也不报错**——没有 `--llm-key`，模型 key 请在生成后的 `.env` 里改
`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 三行。

在 `.env` 里加上（`SITE_URL` 在 `NODE_ENV=production` 下必填、且不能是 localhost，否则拒绝启动，见上面第 10 行那段）：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，可以设 `DEV_AUTH_ROLE=admin`——**但要知道它到底关掉了什么**：带这个键时，后台不只是省掉一次登录，而是 `/api/admin/*` 全部写接口都不再鉴权（`packages/backend/src/admin/auth.ts` 会发一个 `csrf:"dev"` 替身，而 `routes/admin-auth.ts` 只比对那个常量）。本站的 `.env` 与 `.env.pipeline` 都不含这个键，本机也用 `ADMIN_PASSWORD` 登录后台。

"生产环境会拒绝启动"这句要拆开看，两个变量各管一半，只设一个等于没设：`assertProductionSecrets`（`packages/backend/src/config.ts`）看的是 **`NODE_ENV`**，而那个免登录替身是否生效看的是 **`AIHOT_ENVIRONMENT`**。所以 `AIHOT_ENVIRONMENT=production` 而 `NODE_ENV=development` 时，拒启检查根本不会跑。上线前两个都要 production，并按 `docs/manual.md` 第 10 节清单用 curl 实测 `/api/admin/sources` 返回 401、`/admin` 返回 302，不要靠"觉得应该没问题"。
