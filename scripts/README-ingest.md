# scripts/seed-curated.ts —— 人工精选内容入库

无 LLM Key 的地理站，精选内容必须走框架自己的入口，才能吃到判重（identity）、修订（revision）、
时间轴规则，然后让真实管道（prefilter → 打分 → understand → structure → 归组 → 热度 → 成刊 → 日报）
跑在它上面。这个脚本就是那条入口的批量投递器。

输入 `tooling/corpus/curated-materials.jsonl`（内容合并 agent 产出、已进仓库，每行一个 JSON；行数不要抄文档，
`npm run seed:curated -- --dry-run --enforce-source` 会打印 `117 material line(s)`，`wc -l` 给 118 是因为末尾
还有一个空行）。实测形状：

`{kind:"item", id, sourceId, sourceName, url, title, originalTitle, author, bodyText,
publishedAt, timelineAt, discoveredAt, language, sourceTier, firstParty, raw:{geohot:{theme,fragment,…},_aihot:{}}}`。
`kind` 认 `item` 与 `material` 两种（早期片段文件用后者）；`//` 注释行、`{}` 之外的行、
`kind` 不符的行都会被跳过并逐行打印。上游的 `raw.geohot` 溯源原样保留，脚本的投递决策写在
`raw._geohot`；`id` 合法时直接作为 `articles.id`；`discoveredAt` 用于还原"事件发生后多久被发现"。

上游认可的投递入口是 `POST /api/ingest/items`（`docs/sources.md`）。它的实现
`packages/backend/src/ingest/items.ts` 本身只做参数清洗，真正落地全靠
`packages/backend/src/content/materials.ts` 的 `upsertMaterial()` —— 注释写得很清楚：
"The single entrance for new material from every channel"。因此：

| 路线 | 命令 | 说明 |
|---|---|---|
| `--route inproc`（默认） | `npm run seed:curated` | 直接 `import { upsertMaterial, queueProcessing }`，与 webhook 调的是同两个函数。能带 `bodyText`（精选正文）、能带 `language`、能指定 `discoveredAt`。`scripts/seed.ts` / `scripts/regroup-events.ts` 早就这么直接 import 后端模块（模型与数据库只在后端），脚本目录里这样做是框架一致的。 |
| `--route http` | `npm run seed:curated -- --route http` | 打真 webhook：Bearer `INGEST_TOKEN`、每请求 ≤50 条、每 IP 每分钟 10 次（脚本自动分组分批并限速）。**局限**：`ingestItems()` 只送 title/url/publishedAt/author/raw，正文得靠 `content.extract-body` 回源抓页面，且发现时间永远是服务端 now。单条人工投递优先用它。 |

## 参数

- `--input <path>`：默认 `tooling/corpus/curated-materials.jsonl`（相对仓库根或其上一级都会解析；测试夹具 `tooling/corpus/curated-sample-test.jsonl` 也在同一个目录）。
- `--dry-run`：只读，不落库、不排队，打印将要做什么。
- `--as-of <ISO>`：把整批材料当作"那一天到达"。见下面 48 小时陷阱。
- `--keep-times`：按材料原始时间入库。此时脚本会明确报出"多少条落在实时 48h 热度窗口之外、今天上不了热点榜"。
- `--enforce-source`：输入里任何 `sourceId` 不在 `sources` 表 → **停止，什么都不写**，退出码 2。
- `--allow-unknown-source`：复刻 webhook 行为，自动建 `external` 信源（`T2`/`isolated`，站上不可见）——只在确实要先占位时用。
- `--no-queue`：只写材料，不进 `content.analyze` 队列。
- `--route`、`--batch-size`、`--base-url`、`--limit`。

输出打印 created / updated（新修订）/ skipped（内容哈希未变）/ 各类丢弃原因，并在最后回读数据库，
报告 `backfill`、`historical`、是否仍在 48h 热度窗口内。

> 历史实测（2026-09-30，那时语料还是仓库外的 `.brief/curated-materials.jsonl` 99 行）：`--enforce-source` 当场拦下
> **6 个未登记的 `sourceId`**，它们带着 10 条材料：`atom-gdal-releases`、`rss-gsc-europa`、`rss-qgis-blog`、
> `rss-osm-blog`、`web-spacemapper-news`、`web-mwr-news`（正是 WAVE3 §H 列出的待补信源）。那 6 个源后来已经由
> `industry/sources.json` 登记。**现状（2026-10-01 本机与干净克隆各跑一次，都一致）**：
> `npm run seed:curated -- --dry-run --enforce-source` → `117 material line(s), 117 to ingest; dropped 0 …`
> 与 `sources: 34/34 registered in the sources table, 0 missing, 0 not editorial`。
> 要新加的 `sourceId` 仍然必须先登记再投，否则只会落进 `isolated` 的自动信源、永远不可见。

## 48 小时陷阱（WAVE3 §E，必读）

`events/group.ts` 用 `isHistorical()`（`content/materials.ts` 的 `STALE_ON_DISCOVERY_MS = 48h`）判定：
发现时间比来源时间晚超过 48 小时的材料 = 历史，**不成事件、不给热度**。语料横跨数月，直接跑就是
精选流有货、热点榜与事件页全空。

脚本的处理：把整批材料的**事件时间做一次保序仿射重映射**，压进锚点前 ~45 小时（`--as-of`，默认现在）；
每条的 `discovered_at` = 它自己的事件时间 + **语料自带的发现间隔**（`discoveredAt − publishedAt`，实测 0.8–39 小时），
没有该字段时退回由 identityKey 哈希决定的 3–25 分钟（**确定性**，所以重跑完全一致），并夹在锚点之前。
于是 `discovered_at - published_at` 恒 ≤ 45 小时 ⇒ 永不被判 stale ⇒ 全部能成事件、进热度。
原始时间一个字节都不丢，写在 `articles.raw._geohot.authoredPublishedAt / authoredTimelineAt / authoredDiscoveredAt`。

同一事件的多条报道原来相距多久，重映射后仍按比例相距，聚簇不会因为压缩而失配。
`articles.timeline_at`（首页时间轴信息流的排序键）由框架的 `decideTimeline()` 决定：不是 backfill 就用
发现时间，于是精选条目按"到达"排在今天，而 `published_at` 仍是它的地理事件时间——两个时间各司其职，
都是 `upsertMaterial` 自己写的，脚本没有绕过任何一个。
重映射的跨度（45 小时 + 1 小时提前量）是刻意选的：即便走 webhook（发现时间只能是服务端 now），
最旧的一条离 now 也只有 46 小时，仍不会被判 stale。若 `--route http` 配一个 48 小时以外的 `--as-of`，脚本会警告。
注意：时间只在**首次创建**时写入；`upsertMaterial` 的 UPDATE 不改时间（框架行为，后来的报道不重写事件时间），
所以换 `--as-of` 重跑不会挪动已有条目——要重排就得换一批新 URL 或清库。

## 幂等

identity 是规范化 URL（`normalizeUrl`：统一 https、去 `www.`、去跟踪参数、去 fragment、去尾斜杠），
`articles.identity_key` 上有 UNIQUE。同一输入第二次跑：`created 0, updated 0, skipped N`，
`article_discoveries` 每行仍只有 1 条，pg-boss 作业不重复。同一请求内重复 URL 第一条胜出（与 webhook 一致）。
正文真变了才会 `revision+1`、`processing_state='new'` 并重新排队。
落库后每条是 `processing_state='new'`（`upsertMaterial` 的 INSERT 默认值）+ `processing_queued_at=now()`
（`queueProcessing` 写的），作业进 `content.analyze` 队列；worker 起来（`.env.pipeline` 那两个阀）就往下跑
prefilter → 打分 → understand → structure → 归组 → 成刊 → 日报。脚本不碰这些阶段，也不写任何评分。

## 人工补一条（野外与考察 / 国内官方一手记录就是这样加）

`WAVE3 §G` 的方案：`fieldwork` 与 12379／民政部／自然资源部 这类采不到的信源，登记成 `kind=external`，
靠人工投递带路线、站位、样品、仪器、影像的记录。先用后台或 SQL 把信源建成
`participation_mode='editorial'`（脚本会警告非 editorial 的信源——那些条目会被
`settleNonEditorial()` 标成 `skipped`，不分析、不进精选），然后：

### token 从哪来、怎么生成

`POST /api/ingest/items` 只认 `Authorization: Bearer <INGEST_TOKEN>`，服务端从环境变量读
`INGEST_TOKEN`（`apps/api/src/routes/ingest.ts:13` → `credential("auth","INGEST_TOKEN")`，也就是 `.env` 里那一行）。
四种情况一律 **401**（不区分原因，回一个纯文本 `Unauthorized`）：没填 / 少于 16 位 /
整串是占位词（`changeme` `change-me` `placeholder` `xxx+` `todo` `test` `dev` `your[-_]?token*`，正则见 `ingest.ts:9`）/
头写错（`Bearer` 前缀大小写不敏感，比较用 `timingSafeEqual`）。改完 `.env` 必须**重启 api**（`--env-file` 只在启动时读）。

`npm run env:init` 会直接把这一行写成 48 位十六进制随机串（`.env.example` 里它是空值键，空值 = 接口恒 401，
等于这个入口关着）。手工要一枚的话用 Node 自带的（本机没有 openssl）：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # 48 位十六进制
```

限流与批量：每 IP 每分钟 10 次（超了 429 + `Retry-After: 60`），单请求 ≤50 条（超了 413，整条请求不落地）。
下面的 `-H "Authorization: Bearer $(…)"` 从 `.env` 现取，不要把 token 抄进脚本或文档。
**端口照你的 `.env` 改**：`API_PORT` 默认 3001，本机 3001 被无关进程占着、本站 api 实际在 3199（README §3.7）。

```bash
# 变量：INGEST_TOKEN（从 .env 取，兼容 CRLF）；API=你这套栈的 api 端口
API=3199
TOK=$(node -e "const fs=require('fs');const l=fs.readFileSync('.env','utf8').split(/\r?\n/).find(x=>x.startsWith('INGEST_TOKEN='));console.log(l?l.slice(13):'')")

curl -sS -X POST http://127.0.0.1:$API/api/ingest/items \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  --data-binary @item.json
# item.json 的形状（正文只能回源抓，见下表 --route http 的局限）：
# {"sourceId":"ext-second-qht-obs","sourceName":"第二次青藏科考（人工投递）",
#  "items":[{"title":"…（含站位与深度）","url":"https://itpcas.example.org/record/2026-0930",
#            "publishedAt":"2026-10-01T09:00:00+08:00","raw":{"_geohot":{"theme":"fieldwork"}}}]}
```

实测（2026-09-30 本机 api；2026-10-01 在**干净克隆**里重跑一遍：`git clone` + `npm ci` +
`npm run env:init -- --db-port 5455 --api-port 3288 --web-port 3090 --brain-port 3065` + 起栈，token 就是 env:init
生成的那一枚，api 在 3288；`--data-binary @item.json` 这种写法两次都通过，把 JSON 直接写进 shell 单引号里带全角
括号则被 Node 判成非法 JSON、回 400 `invalid-request`，所以文档保留文件形式）。

| 请求 | 结果 |
|---|---|
| 无 `Authorization` 头 | `401` |
| `Bearer shorttoken`（<16 位） | `401` |
| `Bearer dev`（占位词） | `401` |
| `Bearer $TOK` 一条新记录 | `200 {"ok":true,"created":1}` |
| 同一 url 再投一次 | `200 {"ok":true,"created":0}`（身份键去重，不产生新行） |
| 一分钟内第 11 次授权请求 | `429` |
| 一个请求 51 条 | `413 {"ok":false,"error":"items[] exceeds max 50 per request"}` |

上表里"无 `Authorization` 头 401"、"`Bearer $TOK` 一条新记录 `200 {"ok":true,"created":1}`"、"同一 url 再投一次
`created:0`" 三行复现过两次：2026-10-01 上午的干净克隆（api 在 3288，库是克隆自己的 `.pgdata`，不是主库），以及
同日中午第二个临时克隆从头跑完 §3.2 全流程后（`git clone` → `npm ci` → `env:init --db-port 5455 --api-port 3288
--web-port 3090 --brain-port 3065` → `db:up` → migrate/seed → api 起 3288）再次得到 **401 / 200 created:1 / 200
created:0**，同时 `/api/admin/sources` 无会话 401；`shorttoken`/`dev`/429/413 四行是 2026-09-30 本机那一轮的记录，
两轮都没有复现——它们是同一套 `ingest.ts` 代码路径，但请以你自己复跑的结果为准。克隆里也顺手复现了"投进来的条目在任何公开出口都查不到"：
`GET /api/site/pool?q=Lake%20area%20shrunk` → `"items":[], "total":0`，`publications` 里该 URL 的 public 行 0 条。

未登记的 `sourceId` 会被自动建成 `kind=external`、`tier=T2`、`participation_mode=isolated`
（`ingest/items.ts:33-38`），`publication/publish.ts:185` 把 isolated 条目的 visibility 直接写成 `withdrawn`，
所以它**不会出现在任何公开出口**（`/all`、`/feed/all.xml`、条目页都没有）。要让它可见，必须先由
`industry/sources.json` 的 owner 登记、跑 `scripts/seed.ts`，并把信源改成 `participation_mode='editorial'`
（非 editorial 的条目会被 `settleNonEditorial()` 标成 `processing_state='skipped'`，不分析、不进精选）。

## 后台脚本化调用（`DEV_AUTH_ROLE` 已经摘掉）

`.env` 里**不再**设 `DEV_AUTH_ROLE`，所有 `/api/admin/*` 都要真实会话（`admin/auth.ts:166` 的那个
`csrf:"dev"` 替身不会再发）。要免登录进后台 = 敞开的写接口，实测代价见「上线前检查」。用密码登录换 cookie：

```bash
API=3199   # 你这套栈的 api 端口：API_PORT 默认 3001，本机本站实际在 3199（README §3.7）
PW=$(node -e "const fs=require('fs');const l=fs.readFileSync('.env','utf8').split(/\r?\n/).find(x=>x.startsWith('ADMIN_PASSWORD='));console.log(l.slice(15))")
curl -sS -c /tmp/geohot-jar.txt -X POST http://127.0.0.1:$API/api/auth/password \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "password=$PW" --data-urlencode 'return=/admin'      # 303 + Set-Cookie: aihot_admin=…
CSRF=$(curl -sS -b /tmp/geohot-jar.txt http://127.0.0.1:$API/api/admin/me | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).csrf))")
curl -sS -b /tmp/geohot-jar.txt http://127.0.0.1:$API/api/admin/sources              # 200
curl -sS -b /tmp/geohot-jar.txt -H "x-csrf-token: $CSRF" -X PATCH … /api/admin/…    # 写操作要带这一句
```

2026-10-01 在干净克隆上复现过前四步的返回值：不带 cookie `GET /api/admin/sources` → **401**、
`GET /api/admin/me` → **401** `{"detail":"Sign in to the admin first."}`、密码登录 → **303**、
带 cookie 再 `GET /api/admin/sources` → **200**。浏览器侧的 `/admin` 也确认是 **302 → /admin/login?return=%2Fadmin**、
`/admin/login` 200。

会话 30 天（`SESSION_DAYS`），令牌只在 cookie 里、库里只存 SHA-256；CSRF 是每个会话一个随机串，
所以 `x-csrf-token: dev` 现在是 **403**。登录尝试限速：每 IP 15 分钟 10 次、全局 50 次（`admin-auth.ts:29-41`）。
浏览器侧照旧：打开 http://localhost:3000/admin/login 输 `.env` 里的 `ADMIN_PASSWORD`，
登录后侧栏显示"管理员"且**没有**"开发"角标（有角标就说明某处又把 `DEV_AUTH_ROLE` 加回来了）。
注意 cookie 是按主机绑定的：一直用 `localhost:3000` 或一直用 `127.0.0.1:3000`，混用会看起来"登录不上"。


## 命令

```bash
npm run env:init                                                     # 干净克隆里先跑：写出 .env 与 .env.pipeline
npm run db:up                                                        # 默认前台；--daemon 后台
npm run seed:curated -- --dry-run --enforce-source                   # 先看会不会落进未登记信源
npm run seed:curated -- --enforce-source                             # 正常投喂（默认 --route inproc，输入是仓库内的 tooling/corpus/）
npm run seed:curated -- --input tooling/corpus/curated-sample-test.jsonl --dry-run --as-of 2026-10-01T08:00:00+08:00
npm run seed:curated -- --route http --batch-size 20                 # 走真 webhook（需要 api + INGEST_TOKEN）
```

`tooling/corpus/curated-sample-test.jsonl` 是这个脚本的 3 行测试夹具（合成正文，不是站点内容，别投进 `geohot`；
2026-10-01 从仓库外的 `.brief/` 搬进仓库并纳入版本控制，因为原来那条 `--input ../.brief/…` 命令在干净克隆里必然
`--input not found` 退出）。上面最后一条 dry-run 的实跑输出：`3 material line(s), 3 to ingest; dropped 0 …`、
`sources: 3/3 registered in the sources table, 0 missing, 0 not editorial`。

一次性验证库（不碰主库 `geohot`；端口按你的 `.env` 改，本机主集群在 5433）：

```bash
node --input-type=module -e "import p from 'postgres';const a=p('postgres://geohot:geohot@127.0.0.1:5433/postgres',{max:1});await a.unsafe('CREATE DATABASE geohot_curatedtest');await a.end()"
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_curatedtest node scripts/migrate.ts
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_curatedtest node scripts/seed.ts     # 建好 industry/sources.json 的信源
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_curatedtest node scripts/seed-curated.ts --input tooling/corpus/curated-sample-test.jsonl --enforce-source
DATABASE_URL=postgres://geohot:geohot@127.0.0.1:5433/geohot_curatedtest node scripts/seed-curated.ts --input tooling/corpus/curated-sample-test.jsonl --enforce-source  # 第二次：created 0
# 用完删除：node --input-type=module -e "import p from 'postgres';const a=p('postgres://geohot:geohot@127.0.0.1:5433/postgres',{max:1});await a.unsafe('DROP DATABASE geohot_curatedtest');await a.end()"
```

## 上线前检查（运维侧，本节由 security-and-operations 维护）

这一节是给"能浏览的本地演示"到"能公开访问的站"之间那段路写的。每条都给了命令和**实测**结果，
照做即可；不做就等于把敞开的新站发出去。

**1. 摘掉开发身份（本机已摘，别再装回去）。** `.env` 与 `.env.pipeline` 都不再有 `DEV_AUTH_ROLE`（`npm run env:init`
生成的两个文件里也没有这个键）：

```bash
grep -n DEV_AUTH .env .env.pipeline            # 期望：只有 .env.example 里的注释行，两个 env 文件都无输出
```

带着它会发生什么（2026-09-30 实测，无任何 cookie）：`GET /api/admin/sources` **200**、
`GET /api/admin/monitor/events` **200**、`GET /api/admin/me` **200 `{"csrf":"dev","dev":true}`**，
而写操作只被常量挡住——`PATCH /api/admin/feedback/999999` 带 `x-csrf-token: dev` 返回 **404**（说明请求
已经进了业务处理器，鉴权被绕过）；不带该头才是 403。摘掉之后同样四项：**401 / 404 / 401 / 403**。
界面并不是看不见这个风险：后台侧栏在 `me.dev` 为真时会挂一个"开发"角标（`admin/layout.tsx:92`），
但它只是标记、不拦任何操作，所以别拿"看得见"当"安全"。改完 `.env` 必须**重启 api 与 worker**
（README §3.3 那条 `node --env-file=…` 不带 `--watch`，`--env-file` 只在启动时读一次）。

**2. `NODE_ENV=production` 的后果，以及一个真陷阱。** 两道闸门比的是**两个不同的变量**：
`assertProductionSecrets`（`config.ts:92`）只在 `NODE_ENV === "production"` 时执行，缺 `SESSION_SECRET`
或 `IMG_PROXY_SIGN_SECRET`、值 <8 位、命中占位正则（`changeme|placeholder|dummy|test|xxx+|your…|<…>`）、
出现任何 `DEV_AUTH_*` 键、或 `ALLOW_PRIVATE_NETWORK_FETCH` 为真 → **拒绝启动**（api 还额外要求
`ADMIN_PASSWORD` ≥12 或配了飞书登录，`apps/api/src/main.ts:12`）。而"开发身份替身"是否生效看的是
`config.environmentName`（= `AIHOT_ENVIRONMENT`，默认随 `NODE_ENV`）。**只改 `AIHOT_ENVIRONMENT=production`
而 `NODE_ENV` 留 `development`，拒启检查根本不会跑**；两个都要 production 才是真生产形态。
副作用清单：告警文案不再带部署名前缀；`SITE_URL` 若换成 https 则 cookie 自动加 `Secure`（`routes/admin-auth.ts:23`）。

**3. 真实的联系与备案信息。** `industry/site.ts:39` 现在是 `contactEmail: "editor@geohot.local"`（占位域，
发不出去），`:46` 是 `icp: ""`（页脚没有备案号）。上线前换成使用者本人确认真实邮箱与 ICP 号，
同时把 `SITE_URL` 改成正式域名、`TRUST_PROXY=true`（前面挂了 Caddy/Nginx 时不开这个，登录限速和反馈限速
会把所有人算成同一个 IP）、必要时补 `MCP_ALLOWED_HOSTS`。条款与隐私页（`industry/pages/`）仍是模板，
内容归使用者本人确认。

**4. HTTPS。** 本机没有 Docker，这一步属于部署时：`docker compose --profile https` + `SITE_DOMAIN=…`
起 Caddy 自动证书，`SITE_URL` 改 `https://域名`。为什么必须：会话 cookie 的 `Secure`、图片代理签名、
以及 `safeReturn()` 对跳转目标的校验都跟站点地址绑定；HTTP 明文对外等于把 `aihot_admin` 会话裸传。

**5. 备份：embedded-postgres 不带 `pg_dump`。** `node_modules/@embedded-postgres/windows-x64/native/bin/`
里只有 `initdb.exe`、`pg_ctl.exe`、`postgres.exe`——`docs/deploy.md:60` 那句
`docker compose exec -T db pg_dump …` 在本机跑不通，`DB_BACKUP_STORE_*` 那条每日对象存储备份也只服务 Docker 版。
本交付的实用办法有两条：
- **冷拷贝整个集群目录**（推荐，最接近"能整站还原"）：`npm run db:down`（`pg_ctl stop`）→ 复制 `.pgdata/`
  （本机实测 143 MB）→ `npm run db:up`。恢复就是把目录换回去。停库那几分钟是唯一的一致性窗口，别在
  worker 还在写的时候复制。
- **逻辑导出**（不停库、可挑选）：`COPY (SELECT …) TO 'D:/ascii/path.csv' CSV HEADER`——`geohot` 角色是
  超级用户，实测可写。**注意路径必须是纯 ASCII**：同一个语句写到本仓库那种含中文的目录下报
  `could not open file … for writing: No such file or directory`（已复现）。恢复只能逐表 `COPY … FROM`，
  外键顺序和 jsonb 列都要自己处理，所以它是"抽数据"而不是"备份"。
- 别忘了库外还有一样：`.data/`（图片缓存、日报存档、导出）。语料**已经不需要单独备份**了——
  `tooling/corpus/*.jsonl` 在仓库里、跟着 Git 走（旧写法说的"仓库外的 `.brief/curated-materials.jsonl`，
  丢了它演示数据就重建不出来"已经不成立，见本文开头）。

**6. `aihot_*` 前缀的决定：保留，不改名。** 会话 cookie `aihot_admin`、OAuth state cookie
`aihot_oauth_state`、localStorage 键前缀 `aihot_`、npm 包名 `@aihot/*` 与目录名 `industry/` 都是同一批上游遗留
标识（简报 §2.6）。理由：改名会把所有已登录管理员踢下线、把读者本地状态（主题偏好、已读标记）清零，
而它们不出现在任何面向用户的文案里——面向用户的字符串一律 GEOHOT / 地理热点，MCP 工具名已经换成 `geohot_*`。
如果将来真的换 cookie 名，记得同时换 `SESSION_COOKIE` 与前端读取处，并预期一次全员重新登录。

### 本轮运维校验在主库 `geohot` 留下的行（可直接清理）

```sql
-- 实测遗留：articles 1 行、publications/article_revisions/article_discoveries 各 1 行（都随 articles cascade）、
-- ingest_events 10 行、pgboss.job 历史 1 行（无害，可留）。顺序要紧：articles→sources 的外键是 NO ACTION。
DELETE FROM articles WHERE source_id = 'ext-opscheck-ingest-probe';
DELETE FROM sources WHERE id = 'ext-opscheck-ingest-probe';
DELETE FROM ingest_events WHERE summary->>'sourceId' = 'ext-opscheck-ingest-probe';
```

外加：`admin_users` 里那行 `admin@local`（首次密码登录就会建，留着即是正常状态）、`admin_sessions`
里本轮的 1 行会话（要立刻失效就 `DELETE FROM admin_sessions`；读者看不到它）、`audit_log` 里 1 行
`auth.login`。校验条目本身是 `isolated` 信源、visibility `withdrawn`，`/all`、`/feed/all.xml`、
条目页与 `/api/site/pool?q=ops-check` 均查不到（实测 0 行），不清理也不会上任何公开出口。

