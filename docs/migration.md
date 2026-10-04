# 搬家清单：换域名 + 换服务器

这份文档回答一个具体问题：**"验证通过该仓库可完成本地部署，并支持迁移到新域名和服务器"这句话，
要做什么才成立。** 它和 `docs/deploy.md`（第一次装起来）、`deploy/geohot/README-deploy.md` 第 10 节
（nginx/systemd 那台机器的搬家记录）同源，但视角不同：这一份是**读者拿着公开仓库就能自己走完**的清单，
每一步都给"跑什么命令"和"看到什么才算这一步真的过了"。

- **适用**：把本站搬到另一个域名、另一台机器，或从"共用域名的子路径"搬到"自己的域名根"。
- **不适用**：改行业（读 `docs/customize.md`）、改本机开发环境（读 `docs/manual.md` 第 3 节）。
- **本清单不写**：源站 IP、SSH 用户名、密钥文件名、任何密钥值。下面所有 `<…>` 都要你自己填，
  所有命令都假设你已经在目标机器上、用该用的账号。

---

## 1. 域名和 `/geohot` 前缀到底写在哪里

搬之前先分清三类，否则要么白改一通，要么改坏历史记录。**这一节是这份清单里唯一"逐条列位置"的地方**，
后面每一步都指回这里的表。

### A 类：可配置——改这些就够了

| 位置 | 管什么 | 怎么改 | 验证（命令 → 预期证据） |
|---|---|---|---|
| `.env` 的 `SITE_URL` | **一切绝对链接的唯一来源**：canonical、`og:url`、`og:image`、RSS `<link>`、sitemap `<loc>`、robots 的 `Sitemap:` 行、security.txt 的 `Canonical:`、**`llms.txt` 里的每一条站内链接**、MCP 的 host 锁 | 手工改成读者实际访问的地址。生产下留空或留 `localhost` 会**拒绝启动**（`packages/backend/src/config.ts` 里的 `assertProductionSecrets` 与 `str()`：缺值即抛 `Missing required environment variable`——**这里不写行号**，`grep -n "assertProductionSecrets\|Missing required environment variable" packages/backend/src/config.ts` 现查），compose 更早一步在解析阶段就报错（`docker-compose.yml:16`） | `curl -s https://<新域名>/ \| grep -o 'rel="canonical"[^>]*'` → 指向新域名；`node --env-file=.env apps/api/src/main.ts` 不起来说明这一行没填对 |
| **构建期** `BASE_PATH` | 站点挂在哪个前缀上（`/geohot`），烧进 bundle | `BASE_PATH=/<前缀> npm run build -w @aihot/web`。构建期读它的两处：`apps/web/vite.config.ts:13`（资源前缀）与 `apps/web/react-router.config.ts:8`（router `basename`）；运行期的 `apps/web/server.ts` 里那个 `const BASE = …` **不再读环境变量**，它从构建产物取 `basename`，所以**运行期再设没用** | 首页 HTML 里每个 `href`/`src` 都带新前缀：`curl -s https://<新域名>/<前缀>/ \| grep -o 'src="[^"]*"' \| head -3` |
| `SITE_URL` 的**路径部分** | 必须与构建期 `BASE_PATH` 一字不差 | 一起改。不一致时 web 进程启动会打一条 warn：`SITE_URL path and the built basename disagree`（紧跟在 `server.ts` 那个 `const siteBase = deployBase(process.env.SITE_URL)` 后面） | `deploy/geohot/verify-deploy.sh` 第 3 节会硬断言"资源不回落根"；不用那套装法就自己比一眼上面两行，并去日志里搜那句 disagree |
| `MCP_ALLOWED_HOSTS` | MCP 允许的 `Host`/`Origin` 白名单（逗号分隔） | 加上新域名。基线是 `SITE_URL` 的 hostname + `localhost`/`127.0.0.1`/`[::1]`（`apps/api/src/routes/mcp.ts:288-289`），不在表里的直接 **421 misdirected_request**（`:330-331`） | `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<新域名>/api/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → **200**（没加白名单时是 421） |
| `SITE_DOMAIN` | **只有 Caddy 那个 profile 读它**（`docker-compose.yml:91`） | 换成新域名 | `docker compose --profile https up -d` 后证书签的是新域名：`echo \| openssl s_client -servername <新域名> -connect <新域名>:443 2>/dev/null \| grep subject=` |
| `PORT` / `API_PORT` / `WEB_PORT` / `BRAIN_PORT` / `DEV_DB_PORT`、`API_BASE_URL` | 端口与进程互访地址 | `npm run env:init -- --db-port … --api-port … --web-port … --brain-port …` 一次写齐（`scripts/init-env.ts:35-40` 只认这四个开关） | `grep -E "^(SITE_URL\|API_BASE_URL\|WEB_PORT)=" .env` 三行互相自洽 |
| `TRUST_PROXY` | 访客地址从哪来（**web 与 api 两个进程都读**：`apps/web/server.ts:20`、`apps/api/src/app.ts:28`） | 前面有反代就 `true`，直接对外就 `false` | 提交一次反馈或登录一次，后台看到的不是代理那一个 IP |
| `EGRESS_PROXY_URL` | 出网抓取走不走代理 | 新服务器在墙内时才需要 | 后台"信源"页没有整片超时 |
| `deploy/geohot/` 的四个环境变量 | 安装目录 `GEOHOT_APP_ROOT`（默认 `/opt/geohot/app`）、前缀 `GEOHOT_BASE_PATH`（默认 `/geohot`，域名根部署要**显式写空串**）、nginx 站点文件 `GEOHOT_NGINX_SITE`、仓库地址 `GEOHOT_REPO_URL`（默认指向 `xxc2007/GeoHot`） | 起脚本前在环境里给 | 脚本第一步都会把生效值打出来 |
| `industry/site.ts:43` 的 `repoUrl` | 侧边栏"GitHub 开源"按钮指向谁 | fork 的人换成**自己**的仓库地址（这一行是行业层，不在 `.env` 里） | 侧边栏底部那个链接；`grep -n repoUrl industry/site.ts` |

**`llms.txt` 是这一族里最容易漏的那一个**：它不是静态模板，是读取层每次现拼的**绝对**链接——
`packages/backend/src/publication/llms.ts:5` 与 `:35` 用的就是 `SITE_URL`（经 `publication/links.ts` 的 `siteUrl`）。
一次干净克隆演练实测：`SITE_URL` 指到哪，`llms.txt` 里的每条链接就跟到哪（本机那一份写的是
`http://localhost:<端口>/feed.xml` 这种绝对地址）。**搬家后的断言**：
`curl -s https://<新域名>/<前缀>/llms.txt | grep -c '<旧域名>'` → **0**；同一件事也适用于 `og:image`
（`apps/web/app/lib/seo.ts:79` 拼的是 `<SITE_URL>/og/site.png`，`grep -o 'og:image[^>]*' <首页>` 一眼可核）。

### B 类：写死但惰性——**搬家时不用动它们**

这些地方确实带着 `xxc2007.me` 或 `/geohot` 字样，但**读代码的人会以为要改，其实改了也不影响行为**：

- `packages/backend/src/media/imgproxy.ts:14-16`、`packages/contracts/src/http-policy.ts:131`：都是**注释里的举例**。
  真正的值来自 `deployBase(config.siteUrl)`——也就是 `SITE_URL` 的 path，改 A 类那一行就够了。
- `apps/web/app/lib/public-path.ts:2`、`apps/web/app/lib/seo.ts:11`、`apps/web/app/root.tsx:45-51`、
  `apps/web/app/components/shell/Sidebar.tsx:25-28`、`apps/web/app/features/feed/Filters.tsx:30-32`、
  `scripts/smoke.ts:8,72`：同样是注释，讲的是"为什么子路径部署会出这类 bug"。
- `apps/web/app/features/report/Nameplate.tsx:3`：注释里那个 `<use href="/geohot/assets/…">` 是**已经被取消的**
  跨文档引用（现在报头字打进 chunk），不是还在跑的地址。
- `apps/web/tests/item-toolbar.test.ts:5,150-152`、`tests/egress-and-feedback.test.ts:67`：**测试夹具**。
  前者刻意在"没有 BASE_PATH 的根部署构建"上断言 `/geohot/hot` 认不出来，后者只是拿一个 URL 字符串测协议升级。
  换域名后它们照样绿，**不要为了"看起来一致"去改测试**。
- `industry/site.ts:26`：注释提到"占位域名 `geohot.local`"，但代码里 `defaultUrl` 是 `http://localhost:3000`
  （`:28`），全仓没有任何地方真的用 `geohot.local` 起服务。这句注释是历史遗留，改不改都不影响部署。
- `deploy/geohot/DEPLOYMENT.md`、`deploy/geohot/README-deploy.md`：那是**这一台机器那一次的实测记录**
  （含主站首页哈希、当时的坑）。新机器另写一份，别把旧的改成"看起来通用"。

### C 类：历史，**不要改写**

- `industry/changelog.json` 里带日期的条目（`xxc2007.me/geohot/` 于 2026-10-01 上线那几条）。
- `docs/known-issues.md` 里带日期的评审小节。
- git 历史与提交信息。

这三处写的是"当时发生过什么"，搬家不改变过去。要记录新事实，就加新条目、带新日期。

---

## 2. 新域名根上的第一件事：`robots.txt`（和 security.txt）

**在现部署里这是一条"已知问题"，在搬家时它是第一步**——因为 `docs/known-issues.md`
「本站的 sitemap 目前对搜索引擎不可发现」那条的整个前提是"域名根被别人的站占着"。
换到属于本站的域名（无论根还是子路径），这个前提就没了，事情变成你自己能做主的：

1. 在**新域名根**放一份 `robots.txt`。本站自带的那一份在 `<前缀>/robots.txt`，按 RFC 9309 爬虫**只读域名根那一份**，
   所以子路径部署下自带那份仍然是"写给自己看的"。
   ```text
   User-agent: *
   Allow: /api/v1/
   Allow: /api/mcp
   Disallow: /api/
   Disallow: /admin/
   Disallow: /starred
   Disallow: /feedback

   Sitemap: https://<新域名>/sitemap.xml
   ```
   挂子路径就把上面每条路径都换成带前缀的写法（`Disallow: /<前缀>/admin/` …），
   `Sitemap:` 也指向 `https://<新域名>/<前缀>/sitemap.xml`。
   **`Disallow` 按前缀匹配，别随手加尾斜杠**：`/starred` 与 `/feedback` 这两个页面本身就是无尾斜杠的地址，
   写成 `Disallow: /<前缀>/starred/` 匹配不到它们（本站在 2026-10-02 的第一版就踩了这个，10-03 复核时改回无斜杠；
   改完用 `curl -s https://<新域名>/robots.txt` 逐行比对真实路由，别凭形状判断）。
2. **验证**：`curl -s https://<新域名>/robots.txt` → 200 且**这一份**里有 `Sitemap:` 行指向本站；
   `curl -s https://<新域名>/sitemap.xml | head -c 200` → 200 且 `<loc>` 全是新域名。
3. `/.well-known/security.txt`（RFC 8615 同样只在域名根生效）：本站把它注册在 `<前缀>/.well-known/security.txt`，
   并且**只有 `industry/site.ts:38` 的 `contactEmail` 有值时才渲染**，现在是 `null`，所以线上是 404
   （`apps/api/src/routes/static.ts:169`，这是设计如此：宁可不发布也不挂一个没人收信的地址）。
   搬家时的决定只有一个：要么填真实邮箱并在部署层把**根路径**的 `/.well-known/security.txt` 也指过来，
   要么就接受"本站不发布 security.txt"，并在 `deploy/geohot/DEPLOYMENT.md` 里写明选了哪个。
4. IndexNow（如果开了 `INDEXNOW_SUBMIT_ENABLED`）：key 文件必须落在**域名根**的 `/<key>.txt`；
   子路径部署下落点是 `/<前缀>/<key>.txt`，可达性要自己实测，别照配置推断。
   **这一项要两个键一起配，而漏掉的那一个不会报错**：`INDEXNOW_SUBMIT_ENABLED=true` 只是开关，真正的值是
   `INDEXNOW_KEY`（`.env.example:190-191`，32 位小写十六进制，自己生成）。判定式写在
   `packages/backend/src/config.ts` 里 `indexNowKey:` 那一行（行号会漂，`grep -n indexNowKey packages/backend/src/config.ts` 现查）——
   `/^[0-9a-f]{32}$/.test(env.INDEXNOW_KEY ?? "") ? env.INDEXNOW_KEY! : null`，
   也就是**长度或字符集不合就当没配**：不抛错、不告警、日志里什么都没有，表现是"开关明明开了却从没提交过"。
   所以验证不能只 `grep` 开关：① `curl -s -o /dev/null -w '%{http_code}\n' https://<新域名>/<你的 key>.txt` → **200**
   （根上那份 key 文件真的可达，这一步在子路径部署下最容易假成功）；② 看提交侧的记录（后台/日志里有没有真的发出
   提交），而不是看 `.env` 里那行写了什么。搬家当天**先留在 false**，等新域名的 key 落根并验过再开。
5. **推送类开关一律先关**：`FEISHU_CONTENT_PUSH_ENABLED` 与 `FEISHU_INTERNAL_ENABLED`（`.env.example:87-88`，
   默认 false；读取处是 `packages/backend/src/config.ts` 里的 `feishuContentPushEnabled` 那一行）。它们背后是 webhook 地址，而 webhook 恰恰会跟着
   `.env.pipeline` 一起被"顺手搬过来"——**旧机器的群收不到新站的消息，新站的内容却会推到你不想给的那个群**。
   第 4 节那张"一枚都不要搬过来"的表里包含它们：搬家先置 false，验收完再决定要不要接、接到哪个群。

---

## 3. 在新服务器上把栈起来

```bash
git clone https://github.com/xxc2007/GeoHot.git geohot && cd geohot   # ★ 上游 KKKKhazix/AIHOT 是另一个站
npm ci
npm run env:init                       # 写 .env 与 .env.pipeline；已存在就拒绝覆盖（exit 1）
```

然后**手工做两件 `env:init` 不会替你做的事**，这两条是 `docs/deploy.md` 以前会误导人的地方：

1. 把 `.env` 的 `SITE_URL` 改成读者实际访问的地址（A 类第一行）。`env:init` 只在给了 `--web-port` 时才重写这一行，
   否则照 `.env.example:34` 留 `http://localhost:3000`，生产下 api 会反复重启。
2. 决定阀门。`env:init` 写出的 `.env` 里 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`
   （`.env.example:82-83`，`scripts/init-env.ts` 不碰这两个键），而 `apps/worker/src/main.ts` 里那句
   `if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss)` 一见到 false 就**一个抓取任务都不注册**——
   站起来了但永远没有新内容。
   要真的采起来就显式写 `COLLECT_ENABLED=true`。模型侧三选一：
   `MODEL_CALLS_ENABLED=false`（**抓到的条目一条都不会公开**——`providers/llm.ts:157` 直接抛错，见 `docs/deploy.md` 同一条更正）、或在新机器上起 `tooling/brain-stub.ts`
   并把 `LLM_BASE_URL` 指到它（**只听回环，绝不公网**）、或换成真服务商。

**Docker 那条一条命令的路是域名根部署**，复现不了线上那个 `/geohot` 前缀：`Dockerfile:21` 构建 web 时
没有带 `BASE_PATH`（也没声明成 `ARG`），`docker-compose.yml:78` 又把 `${PORT:-3000}:3000` 直接发出去。
要挂子路径就走 `deploy/geohot/` 那一套（nginx + systemd，`GEOHOT_BASE_PATH` 会作为构建期变量传进 `npm run build`），
或者自己在镜像构建时注入 `BASE_PATH` 并在前面加一层带前缀的反代。理由与逐条命令在 `docs/deploy.md`
「Docker 这条路是域名根部署」一节。

**这一步的验证**（起全栈之后）：

```bash
node scripts/smoke.ts --base https://<新域名>/<前缀>     # 17 个页面 + 18 个机器可读出口，全绿
curl -s https://<新域名>/<前缀>/api/v1/dailies | head -c 200
```

**`count: 0` 不是失败**：日报是 cron 出来的（`apps/worker/src/schedules.ts` 里那条 `reports.daily`，
`0 8 * * *`，Asia/Shanghai），新装的栈当天 08:00 那一档要么已经过了、要么还没到，`/daily` 就是一个诚实的空壳（smoke 会打一条
skip：`– reader copy  no daily paper yet (HTTP 404)`，见 `scripts/smoke.ts:210`，**skip 不算 ✗**）。想当天就有内容：
等 08:00，或者手工补一期——`node --env-file=.env --env-file=.env.pipeline scripts/recompose-report.ts --kind daily --key <YYYY-MM-DD>`
先看计划，确认无误再加 `--apply`（本机要两个 env 文件，因为模型端点在 `.env.pipeline` 里；生产只有一个 `.env` 时
**别把不存在的那个文件也 `--env-file` 上去**，Node 会以 `file not found` 直接退出）。别把这一格当成搬家搬坏了去回滚。

### 3.1 数据库前置：先有角色和库，再谈 migrate

`.env.example:57` 那串 `DATABASE_URL` 里的用户名、口令、库名都是**这台开发机的现状**，不是新机器上已经存在的东西。
三件事要分开做，顺序错了就报错：

1. **先有角色**：`CREATE ROLE <用户> LOGIN PASSWORD '<口令>'`（或发行版自带的 `createuser`）。没有角色就跑
   migrate，第一条连接就死在"角色不存在/口令不对"上。
2. **再有库，owner 是那个角色**：`CREATE DATABASE <库名> OWNER <用户>`。**`npm run env:init` 管不了库名**——
   `scripts/init-env.ts:74` 只替换 `DATABASE_URL` 里的**端口数字**，库名照模板留原值。同一个集群上跑两套站又没改
   库名，第二套的 `npm run db:migrate` 会**直接写进第一套的库**（一次搬家演练里是靠手工改 `.env` 末段才没踩到，
   这一步没有任何命令会拦你）。
3. **"迁移全过"的判据不是退出码 0**：`SELECT count(*) FROM schema_migrations` 要等于
   `ls database/migrations/*.sql | wc -l`（表与逐条登记见 `scripts/migrate.ts:9,18`；2026-10-04 本机两边都是 **40**，
   编号有跳号，跳号不等于漏跑）。只看"没报错"会把"一条都没跑"当成成功。

顺带一条新机器才有的坑：开发用的 embedded PostgreSQL 靠 postinstall 落地二进制，`npm ci` 时如果被
`allow-scripts` 那类策略挡过（演练里 npm 就报过 `@embedded-postgres/windows-x64 … postinstall … not yet covered`），
`npm run db:up` 会起不来。放行那一个包，别改成手工拷二进制。

### 3.2 自建反代必须照抄的三件事（`^~`、不剥前缀、保留裸路径 308）

`deploy/geohot/geohot.nginx.conf片段` 是这台机器上跑通过的写法，换任何反代（nginx / Caddy / Apache）都要保住
这三条事实，缺一条就有对应的症状：

1. **前缀 location 用 `location ^~ /<前缀>`，不是 `location /<前缀>`**。同一个 vhost 里如果有
   `~* \.(css|js|…)$` 这类静态资源正则，普通前缀 location 会被它抢走——症状是"页面 HTML 200，样式与 JS 全 404"。
2. **不要剥前缀**：`proxy_pass http://127.0.0.1:<web 端口>;` 结尾**不带 URI**。剥掉前缀，上游收到的就没有
   `/<前缀>`，而客户端路由的 `basename` 正是它 → 路由匹配不到，落到 404。（片段里 `…/api/mcp` 那一条是**带着**前缀
   写全的，照抄，不要"顺手统一"。）
3. **保留那条裸路径的 exact-match 跳转**：`location = /<前缀> { return 308 https://$host/<前缀>/; }`。
   删掉它不会让 404 消失，只会从服务端挪进浏览器（`basename` 是 `/<前缀>`，客户端把裸路径解析成空路径）。

验证（四条都要过）：

```bash
curl -sI https://<新域名>/<前缀>   | head -1        # 308
curl -sI https://<新域名>/<前缀>/  | head -1        # 200
curl -s https://<新域名>/<前缀>/   | grep -o 'src="[^"]*"' | head -3   # 每个资源都带前缀，不回落根
```

最后一条要手工点一次：打开 `/<前缀>/hot` 再点回「精选」，地址栏落在 `/<前缀>/`（带尾斜杠）。
"进去正常、点出去再点回来 404"就是这个症状，而 308 救不了它——**客户端跳转不过 nginx**，只有 URL 被规范化才治得干净。

### 3.3 边缘 TLS 模式与回源协议：那条 308 会被拼成 `http://`

**这是一次真实故障的形状，不是理论**：https 访客打开裸的 `https://<新域名>/<前缀>`，被送到 `http://…`，
再被边缘拉回来——表现是跳转风暴、循环，或者裸路径 404。

- **原因**：CDN/边缘的 SSL 模式是 Flexible（**明文回源**）时，边缘到源站这一段是 http，nginx 看到的连接协议就是
  http，于是任何 `return 30x /<相对路径>` 都按连接协议拼 `Location`。应用侧不会替你兜：`TRUST_PROXY`
  在两个进程里都**只用于取访客地址**（web 那边是 `apps/web/server.ts` 读 `CLIENT_IP_HEADER` / `X-Forwarded-For`
  的那两处，api 那边是 `apps/api/src/app.ts` 的 `trustProxy:` 一项），**不参与 scheme 推导**——
  所以正确地址永远得由边缘或反代给。
- **两个解法，二选一，都要实测**：① 把回源改成 Full / Full(strict)，让边缘到源站走 TLS；
  ② 所有显式跳转把 scheme 写死：`return 308 https://$host/<前缀>/;`。**本站选的是 ②**，代价写在
  `deploy/geohot/geohot.nginx.conf片段:51` 那条 `⚠️ 代价` 注释里：这个 location 从此**只能挂在真的有 TLS 的
  vhost 上**，明文 staging 挂它会把人送去一个没有 server 块的 https 地址。
- **验收**：`curl -sI http://<新域名>/<前缀> | grep -i '^location'` 与
  `curl -sI https://<新域名>/<前缀> | grep -i '^location'` 两条都必须以 `https://` 开头。
- **:80 与 :443 是两个 server 块时，两处都要有这些 location**。本站那套脚本是刻意硬失败的：只找到一个挂了
  这些 location 的块时，`deploy/geohot/fix-bare-path.sh` 打印 `only ONE server block carries the … locations`
  并**退出 3、一个字节都不写**（要真只有一个监听，得显式 `GEOHOT_ALLOW_SINGLE_VHOST=1` 授权）——别绕过它。

### 3.4 凭证目录：这些文件放哪儿

`.env`、`.env.pipeline`、`.env.ports`、TLS 私钥、IndexNow 的 key 副本、数据库备份，**都放在仓库目录之外**
（本站的装法是应用根下与代码目录平级的那个数据目录，见 `deploy/geohot/README-deploy.md` 第 1 节第 4 条），
权限 600。两点理由，都不是"看起来更严"：

- `.gitignore` 兜住的只是**放进仓库目录**的那些文件（`git check-ignore -v prod.env secrets.env id_ed25519 server.pem`
  2026-10-04 实测全部命中，规则见 `.gitignore:5-17`）；放在仓库外的密钥它一条也管不到，靠的是目录权限与备份制度。
- Windows 开发机上 `npm run env:init` 申请的 600 只是名义位（`statSync` 实测回 666），真正的保护是 ignore 规则，
  所以**别把仓库放进别人可读的共享目录**。

**本清单不写源站 IP、SSH 登录名、密钥文件名**——这一节也一样：要记录就记"放在应用根之外的那个目录"，
不要写绝对路径与真实主机名。

---

## 4. 密钥与信任边界：全部重新签发

搬家的定义是"信任边界变了"，所以**一枚都不要从旧机器搬过来**。

| 键 | 后果（不重发的代价） | 怎么验 |
|---|---|---|
| `SESSION_SECRET` | 旧机器上签出的会话在新机器上仍然有效（或反过来），而旧机器可能已经交给别人 | 登录后 `curl -sI https://<新域名>/<前缀>/admin` → 未登录是 **302** 到 `/admin/login` |
| `ADMIN_PASSWORD` | 同上 | 后台能进；`curl -s -o /dev/null -w "%{http_code}\n" https://<新域名>/api/admin/sources` → **401** |
| `IMG_PROXY_SIGN_SECRET` | 已分发的签名图片 URL 全部失效（这**是期望行为**，但要提前知道）；旧签名若还能验通才是问题 | 打开一张带图的条目页，图能出 |
| `INGEST_TOKEN` | 旧 token 继续能往新库里投毒 | 用旧 token 投一次 → **401**；用新 token → 200。**同时把新值发给每一个投递方**，别只改 `.env`（`docs/geohot-runbook.md` 2.2 节讲的是"从 `.env` 现读"，不是"手工编一枚"） |
| 数据库口令 / `DATABASE_URL` | 新库若沿用旧串，等于把旧机器的访问方式带过来 | `npm run db:migrate` 全过、`scripts/smoke.ts` 全绿 |
| `MCP_ALLOWED_HOSTS` | 新域名的 MCP 请求一律 **421** | 见 A 类最后一行那条 curl → 200 |
| `FEISHU_CONTENT_PUSH_ENABLED` / `FEISHU_INTERNAL_ENABLED` + 那两个 webhook 地址 | **内容推到你不想给的那个群**。webhook 恰恰会跟着 `.env.pipeline` 一起被"顺手搬过来"，而它背后是旧机器那个群的入站地址（读取处 `packages/backend/src/config.ts` 里的 `feishuContentPushEnabled` 那一行，模板默认 false：`.env.example:87-88`） | 搬家一律**先置 false**；要重新接，就在新群里新建一个 webhook、只写进新 `.env`，然后看一次推送落在哪个群。旧地址从 `.env` 里删干净：`grep -c FEISHU .env` 与 `grep -c FEISHU .env.pipeline` 都要对得上你的决定 |
| `INDEXNOW_KEY` / `INDEXNOW_SUBMIT_ENABLED` | 旧 key 跟着新域名继续提交，或（更常见）**配了开关但 key 不合格式，静默什么都不发**（`packages/backend/src/config.ts` 里 `indexNowKey:` 那一行的判定式，见第 2 节第 4 条） | 根上 `curl -s -o /dev/null -w '%{http_code}\n' https://<新域名>/<你的 key>.txt` → **200**，再看提交侧记录，不看 `.env` 那行字 |
| `NODE_ENV` 与 `AIHOT_ENVIRONMENT` | **两个都要 `production`**：拒启检查看的是 `NODE_ENV`（`packages/backend/src/config.ts:127`），免登录替身看的是 `AIHOT_ENVIRONMENT`，只设一个等于没设 | 见 `docs/manual.md` 第 11 节第 2 条 |

**cookie 这一层搬家时值得单独看一眼**（三条都是代码现状，不是建议）：

- 会话 cookie 叫 `aihot_admin`（`packages/backend/src/admin/auth.ts:9`），拼出来是
  `Path=/; HttpOnly; SameSite=Lax; Max-Age=…`，**没有 `Domain` 属性**（`auth.ts:57`）→ 它是 host-only 的，
  换域名后旧 cookie 不会跟过去（好事），但也意味着**所有管理员都要重新登录一次**。
- `Path=/` 意味着在同一台域名上它对该域名**所有路径**都发——现部署与主站、Artalk 共用 `xxc2007.me`，
  这就是 `deploy/geohot/DEPLOYMENT.md` 里那条提醒的来由。搬到独立域名后这条不再是问题。
- `Secure` 跟着 `SITE_URL` 的 `https://` 前缀自动加（`apps/api/src/routes/admin-auth.ts:26` 的 `const secure = …`）——
  所以 `SITE_URL` 写 `http://` 会让会话 cookie 丢掉 `Secure`。别为了省事写 http。

**读者侧会掉的东西，提前公告**：收藏（`/starred`）只存在读者自己浏览器的 `localStorage` 里、键名前缀
`aihot-*`（`industry/pages/privacy.md` 第 2 条第 2 点），**origin 变了就带不走**——搬家前提醒读者用页面上的
导出功能导成文件，到新域名再导入。这是本站唯一的同步方式。

---

## 5. 法律与身份文案：把域名写进句子里的那几段

这些句子描述的是**现在这台部署的拓扑**，换了域名/托管方就不再成立。它们在 `industry/`（行业层），
不在 `.env` 里，所以**必须改文件 + 重新构建 web**：

- `industry/pages/privacy.md:38`：「本站与站长的另一个站点共用 `xxc2007.me` 这个域名，域名托管在 Cloudflare……
  Cloudflare 的『Web Analytics』如果开启，会在它发给你的 HTML 里注入一个来自
  `static.cloudflareinsights.com` 的统计脚本」——**整段都要按新部署重写**：新域名还共用吗？前面还有
  Cloudflare 吗？那个信标还在吗？逐条实测之后再落笔。
- `industry/pages/privacy.md:83`：同一件事的第二次表述（"唯一可能出现在你浏览器里的第三方脚本是域名层
  Cloudflare 的那个统计信标"），与上一条**必须一起改**，否则隐私页自相矛盾。
- `industry/pages/terms.md:63` 与 `:106`：两段都写着"这条路由注册在子路径 `/geohot/` 下，按 RFC 8615
  扫描器取的是域名根"。搬到域名根，这个限制就消失了，措辞要跟着变。
- `industry/pages/terms.md:77`：MCP 工具清单。**这一行已经是对的**（2026-10-02 19:10 那轮把
  `geohot_get_weekly`、`geohot_get_monthly` 接上后一并改了，现在写着 7 个）。这一条留在这里是提醒
  **搬家后复测**，别照着老账去改：`curl -s -X POST https://<新域名>/<前缀>/api/mcp … -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
  数一数返回的 `name`，再和这一行对齐。
- `industry/site.ts`：`contactEmail`（`:38`）、`icp`（`:50`，备案号只能由主办者本人申请）、
  `organization.founder`（`:59`，愿意署名才写真名）、`repoUrl`（`:43`）。
- 托管地与适用法域：`docs/manual.md` 第 7 节第 7 条与第 10 节第 4 条按"境内还是境外没有决定"写着，
  搬家正好是把它决定的时候。

**改完必须重建**：`BASE_PATH=/<前缀> npm run build -w @aihot/web`，否则页面上还是旧文案
（`industry/**` 是构建期烧进 bundle 的，只重启单元不会变——`deploy/geohot/DEPLOYMENT.md` 的"改哪一层要重启哪个单元"表）。

---

## 6. 数据：搬走 or 从零

两条路都合法，选一条并写明：

- **从零开始**（推荐，如果不需要历史）：新库跑 `npm run db:migrate` + `node --env-file-if-exists=.env scripts/seed.ts`
  （导入 `industry/sources.json` 里的全部信源与 43 个主题）+ `npm run seed:curated -- --enforce-source`（人工语料；**compose 路线不含这一步**）。
  验证：`node scripts/smoke.ts --base …` 全绿，`/api/v1/dailies` 的 `count` 从 0 开始重新长。
- **整库搬走**：`docs/deploy.md` 的「恢复」一节六步（`pg_dump -Fc` → `pg_restore --no-owner --no-privileges` →
  **数七张关键表**跟旧机对得上 → 起全栈 → smoke → 重发密钥）。第 4 步那句"数一遍关键表，跟旧机对得上才算成功
  （不是'没报错'就算）"是这一步的全部要点，别跳。

不管哪条路：**`.env`、`.env.pipeline`、`.env.ports`、`.data/`、`.pgdata/` 都不进 git**（`.gitignore` 兜住了
`.env*` 这一族）。2026-10-03 起 `.gitignore` 还补了 `*.env`、`*.pem`、`*.key`、`*.p8`、`id_*`、
`*deploy_key*`、`secrets*`、`credentials*`——此前 `prod.env`、`secrets.env`、`config/production.env`、
`id_ed25519`、`server.pem` 这几类文件名**不被忽略**（`git check-ignore -v` 实测），新机器上顺手放在仓库里
就会被提交。补规则之后仍建议把密钥文件放在仓库目录**之外**（放哪儿见第 3.4 节）。

### 6.1 动手之前：两份备份 + 一次当场演练的恢复

搬家那天的第一个写操作不该是 `git clone`，而是备份。**没有当场演练过恢复的备份不算备份**——它只是一份你
没读过第二次的文件。

1. **整目录**（含 `.env`）：`tar -czf <仓库外的备份目录>/app-$(date +%F-%H%M).tar.gz <应用根>`。
   `.env` 必须在里面：五个密钥只在 `env:init` 那次打印一遍，丢了就要重发一轮（第 4 节那张表里每一行都会被打回来）。
2. **整库**：`pg_dump -Fc <库名> -f <备份目录>/db-$(date +%F).dump`。
   **开发机上照抄这条会失败**——embedded bundle 里没有 `pg_dump`（`docs/manual.md` §3.6 记的就是这个），
   这一条属于生产那台装了 `postgresql-client` 的机器。
3. **当场演练**：把那份 dump 恢复进一个**临时库**（`pg_restore --no-owner --no-privileges -d <临时库> …`），
   数七张关键表，跑完 `DROP DATABASE <临时库>`。完整序列写在 `deploy/geohot/README-deploy.md` 第 6.1 节。
4. **两份都要离开这台机器**：每日 `pg_dump | gzip`、每周一次 `-Fc`，推到另一台机 / 对象存储 / 私有仓
   （`README-deploy.md` 第 6 节给的就是这两条 cron）。只在原盘上的备份等于没有备份。
5. **`.data/` 不在 dump 里**：反馈截图与图片缓存是文件（`apps/api/src/routes/feedback.ts` 写盘），
   应用自己的备份逻辑本来就排除它——要么整目录 rsync，要么明确接受它丢，别以为 `pg_dump` 覆盖了全部。

### 6.2 搬砸了怎么退（回滚 ≠ 撤销 DNS）

- 工具是现成的，但**默认不动手**：`bash deploy/geohot/rollback.sh` 是幂等的 DRY-RUN，只打印计划；
  看过输出确认无误再加 `--apply`（`rollback.sh:2` 与 `:83` 打的就是当前模式）。它还原 nginx 片段与 systemd unit。
- **数据库默认保留**：`.pgdata` 与 `.data/` 留着，直到确认不再需要（`rollback.sh:161`）。要真删得显式
  `--purge-database`，而它**删前强制 `pg_dump` 一份**（`:146`）——这是刻意的两道闸，别嫌烦。
- **绝对禁止 `docker compose down -v`**：compose 的 db/data/caddy 卷里是数据库、上传的截图与证书。
- **回滚不回滚 DNS 与边缘**：第 9 节第 3 条（旧 RSS 地址 301）与第 6 条（外链 301）都不在 `rollback.sh` 的能力
  范围里。回滚之后旧域名如果还在解析，读者拿到的就是回滚前那份配置——这两件事要一起决定，别只回滚一半。
- 回滚后复验：`bash deploy/geohot/verify-deploy.sh`（它拿 `baseline-main.txt` 里的哈希比对**邻居站**首页，
  前提是改动 nginx 之前先跑过一次 `--save-baseline`），再过一遍第 8 节那串 curl。

---

## 7. 公开仓库与介绍页：远端、发布、验收、配图、数字

### 7.1 远端与发布

```bash
git remote -v                                   # 现状：origin → https://github.com/xxc2007/GeoHot.git
git remote set-url origin https://github.com/<你>/<的仓库>.git   # fork 的人换这里
gh auth status                                  # 前置：已登录、令牌有 repo 作用域
bash deploy/geohot/publish-to-github.sh --dry-run -m "搬家：新域名"   # 只算树、只报差异
bash deploy/geohot/publish-to-github.sh -m "搬家：新域名"              # 推 + 当场验收
bash deploy/geohot/verify-github-sync.sh        # 独立复跑一遍逐字节核对
```

- 发布要求工作区干净（脚本自己会查），并且是**快进推送**：不 force、不改写线上历史。
- `deploy/geohot/publish-excludes` **现在是空的** ⇒ 公开仓库与本地 HEAD 逐字节一致，一个文件都不缺。
  CI 定义的正本在 `tooling/ci-check.yml`（不在 `.github/`，原因写在那份文件头部与 `publish-excludes` 里）。
- "发布成功"的定义不是命令返回 0，而是 `verify-github-sync.sh` 全绿：两边每个 blob 哈希相等、
  每张配图从远端取回来验签名与尺寸、SVG 过严格 XML 解析、README 的相对引用逐个命中。

### 7.2 介绍页的每一个数字都要重测

搬家之后 `README.md` 里这些句子全部要重新量一遍。**规则：能写成命令的就写命令，不能重测的就写日期。**

| README 里的那句 | 复测命令 | 期望证据 |
|---|---|---|
| 信源条数（与 README 徽章「87+1」同一口径） | `node -e "console.log(require('./industry/sources.json').sources.length)"` | 与 `README.md` 普查段一致（现 87）；`sources` 表可能另有运维校验自动建的占位源 `ext-opscheck-ingest-probe`，本机 88 行，生产 90 行（其中 3 行是已暂停的 `cn-people-*`） |
| 主题 43 | `node -e "console.log(require('./industry/topics.json').topics.length)"` | 与新站 `/topics` 页自述的数一致 |
| 日报期数 | `curl -s https://<新域名>/<前缀>/api/v1/dailies` | 看 `count` 与 `items[].date`（**介绍页不写这个数**，只写"看 `/daily/archive`"） |
| 最新一期 | `curl -s https://<新域名>/<前缀>/daily \| grep -o '本期共 [0-9]* 条'` | 介绍页只写"最新一期"，具体期号属于 `/daily/<日期>` |
| MCP 7 个工具 | 上面第 5 节那条 `tools/list` | 数 `name` 的个数 |
| smoke「17 页 + 18 出口」 | `sed -n '12,32p' scripts/smoke.ts` 数两条表 | 与 `scripts/smoke.ts` 一致（改了脚本就改介绍页） |
| 主站首页哈希那一句 | `curl -s https://<旧域名>/ \| wc -c` | **搬家后这一句要重写**：新部署如果没有邻居，就把整句删掉，别留着当装饰 |
| **介绍页与文档里的域名、前缀字样** | `grep -n "xxc2007.me\|/geohot" README.md docs/*.md` | 每一处要么改成新域名/新前缀，要么属于第 1 节 C 类那种**带日期的历史记述**（"于 2026-10-01 上线"这种留着）。**三张配图的说明里那些 `路由 /geohot/…` 也算文案**——搬家后那就是错地址，读者照着点会 404 |

### 7.3 三张配图重拍

`docs/shots/` 下只有三张图，`scripts/check-shots.ts` 会保证"每张都被 README 引用、没有重复、明暗与命名一致"。
搬家 + 文案变化之后重拍一条命令即可（视口 **1440×900**，浅色主题，**桌面档**）：

```bash
npm run shots -- --base https://<新域名>/<前缀>          # 首页与热点榜
# 日报要拍固定日期，不拍 /daily：
"<chrome 路径>" --headless=new --hide-scrollbars --force-color-profile=srgb \
  --window-size=1440,900 --screenshot=docs/shots/daily-light.png \
  "https://<新域名>/<前缀>/daily/<一个固定日期>"
node scripts/check-shots.ts                              # 引用、尺寸、命名一致
```
（`scripts/shoot.ts` 自己找 Chrome：Playwright 的浏览器缓存 → 系统 Chrome/Edge；也可以 `--chrome=` 指路。）
按下面这张单子复核：

| 文件 | 拍哪个地址 | 拍完必须复核的点 |
|---|---|---|
| `docs/shots/home-light.png` | `https://<新域名>/<前缀>/` | 第一张卡片的标题是中文；顶部「当前热点」五条的**热度数字**与说明里写的一致（这个榜 5 分钟重排一次，说明里只能写"摄于某时刻"） |
| `docs/shots/hot-light.png` | `https://<新域名>/<前缀>/hot` | 页面自述的"X 月 X 日 HH:MM 更新"、事件条数、NO.01 的热度指数与参与者数，三个都要抄进说明 |
| `docs/shots/daily-light.png` | `https://<新域名>/<前缀>/daily/<一个固定日期>`（**不要拍 `/daily`**，它是"最新一期"，明天就不是这一版了） | 导读段与右侧「今日看点」三条**全部中文**；期号、件大事/来源/一手发布/读完分钟数抄进说明 |

重拍之后：**每张说明里写死拍摄日期（含 +0800）、路由、视口，并保留"线上才是事实来源"那句**。
**现存三张是 2026-10-04 14:07 的线上快照**（`ls -l docs/shots/` 的 mtime 与三张说明里的时间一致），拍的是 `3f7974f` 上线之后的线上：侧栏已经没有「板块」那一格，首页那张带上了有内容的「当前热点」条与它的「截至 X 时」。**其中首页与热点榜那两张有保质期**——榜老过 24 小时之后首页那一块会换成一行诚实说明、`/hot` 会显示空态，那是同一套代码的另一种正确样子，不是图与站不符；重拍前先 `curl -s "https://xxc2007.me/geohot/api/site/hot" | head -c 200` 看 `entries` 有没有内容，别凭印象决定要不要重拍。上一版本小节写的是"三张是 2026-10-04 11:08 的快照、已过期"——那句随重拍作废。
**重拍之前先确认改动已经在线上**（拿本地画面冒充线上就是伪造）：`curl -sI https://<域名>/<前缀> | head -1`、
`curl -s https://<域名>/<前缀>/ | grep -c '<那一版才有的文案>'`，两条都对得上再拍。

---

## 8. 收尾：一次跑完的验证清单

```bash
B=https://<新域名>/<前缀>
for u in / /hot /daily /daily/archive /topics /about /agent /changelog /terms /privacy /feedback \
         /feed.xml /llms.txt /robots.txt /sitemap.xml /openapi-v1.json /api/v1/items /api/v1/dailies /api/mcp; do
  printf "%-24s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$B$u")"; done
curl -s "$B/" | grep -o 'rel="canonical" href="[^"]*"' | head -1        # 新域名，且只有一条
curl -s "$B/robots.txt"                                                # 域名根那一份里有 Sitemap:
curl -s -o /dev/null -w "%{http_code}\n" https://<新域名>/robots.txt    # 200（第 2 步做的那一份）
curl -s -o /dev/null -w "%{http_code}\n" "$B/.well-known/security.txt" # 404 = 没填邮箱，设计如此
curl -s -o /dev/null -w "%{http_code}\n" "$B/admin"                     # 302 → /admin/login
curl -s -o /dev/null -w "%{http_code}\n" "$B/api/admin/sources"         # 401
curl -s -o /dev/null -w "%{http_code}\n" "$B/api/mcp"                   # 405 = 正常：这个端点只收 POST
curl -s "$B/llms.txt" | grep -c '<旧域名>'                               # 必须是 0：llms.txt 每条链接都是绝对地址（第 1 节 A 类）
curl -sI "https://<新域名>/<前缀>" | grep -i '^location' | grep -ci 'location: http://'   # 必须是 0：308 不能被拼成明文（第 3.3 节）
curl -s "$B/api/v1/dailies" | head -c 120                               # 新库首日 `count: 0` 是正常（第 3 节那条），404/5xx 才算坏
node scripts/smoke.ts --base "$B"                                       # 全绿
bash deploy/geohot/verify-github-sync.sh                                # 公开仓库逐字节一致
```

**逐条对照预期，任何一条不符合就回去改对应那一节**，不要"看起来差不多"。`docs/manual.md` 第 11 节
那句口径在这里同样成立：验证方式给的是"怎么证明现状"，不是"觉得应该没问题"。

---

## 9. 这次搬家会必然失效的东西（提前公告，别等读者来问）

1. 所有管理员会话（`SESSION_SECRET` 换了 + cookie 是 host-only）→ 重新登录。
2. 读者的收藏 → 换 origin 就带不走，先导出再导入（第 4 节最后一段）。
3. 已订阅的 RSS 地址 → 阅读器里的旧地址需要重新添加；旧域名若还在，**给 `/feed*.xml` 与页面做 301 到新域名**，
   否则订阅静默死掉。
4. 已接入的 MCP 客户端 → 工具名前缀不变（`industry/site.ts:33` 的 `mcpPrefix: "geohot"`，**已经有人接入就不要再改**），
   但 URL 与 host 白名单变了（第 4 节那一行 curl 用来验收）。
5. 签名图片 URL（`IMG_PROXY_SIGN_SECRET` 换了）→ 边缘缓存里的旧 URL 全部作废，会重新签一批。
6. 外链进来的旧地址 → 旧域名不保留就是 404；保留就把 `/<前缀>/story/<publicId>` 这类逐条 301 过去。
7. `og:image` / 分享卡片的缓存 → 各平台按各自的 TTL，改完不会立刻刷新，别据此判断"没生效"。
