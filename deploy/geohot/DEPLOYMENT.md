# 部署记录：xxc2007.me/geohot/

2026-10-01 实装。这份记录写的是**实际做了什么、怎么验证的、哪一步曾经猜错**，
不是计划。主站（南昌十五中纪念册）全程未被改动，每一步都有哈希可比。

## 结果

- 线上地址：`https://xxc2007.me/geohot/`
- 主站：`https://xxc2007.me/` = **51432 字节，sha256 `4edf0fc53636a680…`**，与开工前基线逐字节一致
- **2026-10-07 之后，上面这一行是历史记录**：域名根换成了站长自己的个人介绍站（`/var/www/intro`），
  南昌十五中纪念册搬到 `https://xxc2007.me/nc15/`（`/var/www/nc15`，首页 51557 字节 / `6313aabee215ccc7…`），
  而 `/var/www/nanchang15/index.html` 仍在盘上、逐字节未变（`4edf0fc53636a680…`）。所以"没动隔壁"这条不变量
  现在管的是**两个**站，`verify-deploy.sh --save-baseline` 一次记三个哈希：根首页、根 sitemap、`/nc15/` 首页。
  **介绍站自己还在动**：第四十八轮上线期间（10:43 记基线 → 10:59 复验）根首页哈希换了三次
  （`9d75c015… → 285c1e3a… → d6c98baf…`），`/etc/nginx/sites-available/xxc2007.me` 在 10:56 被改过一次，
  而 `/nc15/` 全程未变。所以第 1 节那条"根首页哈希变了"**在本轮是预期红**——判红之前先比 mtime 与基线的
  `captured_at`（脚本的失败提示里写了这一步），确认是本站动过才回滚；介绍站那轮收尾后重记一次基线即可。
- **域名根的 `robots.txt` 现在归介绍站所有**（`/var/www/intro/robots.txt`）。它保留了本站三条 `Disallow`
  （`/geohot/admin`、`/geohot/starred`、`/geohot/feedback`）并照旧放行 `/geohot/api/v1/` 与 `/geohot/api/mcp`，
  但搬家时**把本站的 Sitemap 行丢了**。2026-10-07 第四十八轮补回一行 `Sitemap: https://xxc2007.me/geohot/sitemap.xml`
  （改前备份在 `/opt/geohot/backups/robots.root.*.bak`）。robots.txt 是**按主机**读的——`/geohot/robots.txt`
  那份对爬虫不作数，所以这一行只能待在根文件里；介绍站以后重新部署 `robots.txt` 时要带上它，否则会再次静默失联。
- 四个常驻单元全部 `active`：`geohot-brain`(3055) · `geohot-api`(3001) · `geohot-worker` · `geohot-web`(3000)，
  只监听 `127.0.0.1`，每个都带 `MemoryMax`（160/200/240/320 MB），OOM 只会杀自己
- 服务器：Ubuntu 22.04，`<ssh-user>@<server-ip>`，Node v24.21.0，
  **PostgreSQL 17 本机（PGDG apt 源；Ubuntu 22.04 自带的 14 不在本站支持区间，见 bootstrap-server.sh 第 6 节）**，
  swap 2 GB（**部署前就存在**，不是这次加的）
- 安装目录：`/opt/geohot/app` —— 现在它是 `GEOHOT_APP_ROOT` 的默认值，bootstrap / install-units /
  verify-deploy / rollback 四个脚本都读这一个变量；`deploy/geohot/systemd/*.service` 是文本模板
  （systemd 在这里没有变量插值可用），写死的是同一个默认值，换路径时不能用模板
  （以前同一个包里有 `/opt/geohot/GEOHOT` 与 `/opt/geohot/app` 两套写法，`install-units.sh` 头里还把前者当 bug 写着）

## 验证过的证据（可复跑）

```bash
curl -s https://xxc2007.me/ | wc -c                      # 51432
curl -s https://xxc2007.me/geohot/ -o /tmp/g.html
grep -oE '/geohot/assets/[^"]+\.css' /tmp/g.html | head -1   # 再 curl 该 URL → 200 104016 字节
for u in all hot daily topics weekly monthly feed.xml sitemap.xml llms.txt api/health api/v1/items openapi-v1.json; do
  curl -s -o /dev/null -w "%{http_code} $u\n" https://xxc2007.me/geohot/$u; done   # 全 200
sudo systemctl is-active geohot-brain geohot-api geohot-worker geohot-web           # 全 active
sudo journalctl -u geohot-web -n 3                                                 # "web started"
```

## 实际执行的四步

1. **代码**：`git archive HEAD` 打包 → 服务器 `sudo tar -xzf … -C /opt/geohot/app --owner=geohot --group=geohot`。
   解包后必须 `sudo chown -R geohot:geohot /opt/geohot/app`——root 解出来的目录会让
   `npm run build` 在写 `apps/web/build/` 时拿到 `Permission denied (os error 13)`。
   两个细节值得写下来，因为 2026-10-02 的一次热更把这两句都跳过了：`--owner/--group` 与那句 chown
   **缺一个都会中招**，而报错点看着毫无关——构建删不掉 `build/` 是因为它是 `apps/web/` 里的一个条目，
   要的是**父目录**的写权限，`build/` 自己是不是 geohot owned 毫无关系。只改几个源文件时，同一对命令
   带上路径即可（`git archive HEAD apps/web/app/root.tsx …`），但第 2 步的带前缀构建一步都不能省。
   （这次实装走的是离线搬运；`bootstrap-server.sh` 第 2 节的默认路径是直接 clone 公开仓库
   `https://github.com/xxc2007/GeoHot.git`（`GEOHOT_REPO_URL` 可覆盖），并且它在 clone 前实测远端可达、
   连不上就把上面这套离线命令原样打给你 —— 不再拿一个占位地址去撞 git。）
2. **前端**：带子路径构建，且在 cgroup 内存上限内跑（非特权用户的 `systemd-run` 会要 polkit 交互认证，必须 sudo）：
   ```bash
   sudo systemd-run --quiet --pipe --wait --uid=geohot --gid=geohot \
     --property=MemoryMax=900M --property=MemorySwapMax=1500M \
     --property=WorkingDirectory=/opt/geohot/app \
     env HOME=/opt/geohot BASE_PATH=/geohot NODE_ENV=production npm run build -w @aihot/web
   ```
   `--property=WorkingDirectory=` 不能省：`systemd-run` 默认在 `/` 起进程，npm 会报
   `ENOENT /package.json`。`BASE_PATH=/geohot` 也不能省——**这是构建期的事**：vite 把前缀烧进 bundle，
   不带它打出来的页面 200、每个 `/geohot/assets/*` 都 404。bootstrap-server.sh 第 9 节把这一个值参数化为
   `GEOHOT_BASE_PATH`（默认 `/geohot`；域名根部署显式写 `GEOHOT_BASE_PATH=""`），nginx 片段与 `SITE_URL`
   的前缀都必须与它一致。
   **这一整条现在就是 `bootstrap-server.sh` 第 9 节跑的**（上限由 `GEOHOT_BUILD_MEMORY_MAX` /
   `GEOHOT_BUILD_MEMORY_SWAP_MAX` 参数化，默认仍是 900M/1500M）；本机没有 `systemd-run` 时它拒绝裸跑，
   要裸跑得显式 `GEOHOT_ALLOW_UNCAPPED_BUILD=1`——把 vite 放上限之外赌的是一台 891 MB 机器上的
   nginx、Artalk 与 PostgreSQL。
   `env HOME=/opt/geohot` 也不能省：`sudo -u geohot` 与 `runuser -u geohot` 都**保留调用者的 HOME**，
   而 geohot 没有登录 shell，于是 npm 把缓存写进操作者的家目录、构建时以 EACCES 收场。
   同一个道理，第 3/4/8/9 节所有以 geohot 身份跑 node/npm/git 的地方现在都走一个带 `env HOME=$APP_HOME`
   的前缀，`install-units.sh` 与 `systemd/*.service` 里的 `Environment=HOME=` 是它的运行期对应物。
3. **单元**：`bash deploy/geohot/install-units.sh`（见该脚本注释里的三条修正）。它写的是线上实际在跑的那组最小单元；   `deploy/geohot/systemd/*.service` 是同一批单元加一层 `ProtectSystem=strict` 等加固的版本，
   bootstrap-server.sh 第 10 节装的是后者——**一台机器只走一条路**，两者的 `APP_ROOT` 都来自 `GEOHOT_APP_ROOT`。
   这一节以前只有三个 unit 文件（`geohot-brain.service` 是 2026-10-02 补的）：`install-units.sh` 一直会写它，
   而 `systemd/` 里没有，于是照模板装的那台机器上四个单元变成三个，`MODEL_CALLS_ENABLED` 的缺省又是
   `true`（`packages/backend/src/config.ts:92`），分析调用就全部打给一个没人听的 127.0.0.1:3055。
4. **nginx**：把 `geohot.nginx.conf片段` 注入 `xxc2007.me` 的每个 server 块，`nginx -t` 通过后 `reload`。
   四条硬约束（`^~`、不剥前缀、两个监听都要、每一处 `/geohot` 必须等于构建期 `GEOHOT_BASE_PATH`）写在该片段头部，
   前三条都是**页面 200 而静态资源 404** 这类静默故障，只看状态码发现不了。

## 曾经猜错的地方（留档，免得下次再猜）

| 症状 | 真正原因 |
|---|---|
| `ssh ubuntu@…` 被拒 | 登录用户不是默认的 `ubuntu`（按你的机器填） |
| `node: .env: not found` + 单元反复重启 | 相对 `--env-file=.env` 相对的是单元自己的 `WorkingDirectory` |
| 公网 404、直连 443 却 200 | Cloudflare **80 端口明文回源**，`:80` 的 vhost 没有 location |
| 页面 200，CSS/JS 全 404 | 同 vhost 的 `~* \.(css\|js\|…)$` 正则覆盖了普通前缀 location，要用 `^~` |
| 页面 200，资源 404（另一种） | 反向剥了 `/geohot` 前缀，而应用带 BASE_PATH 构建、自己归一化路径，不能剥 |
| 改完 nginx 仍 404 | 注入了 `www.xxc2007.me` 那个 vhost——`www.xxc2007.me` 的字符串里含 `xxc2007.me`，必须按 server_name **整词**匹配 |
| 挂在子路径后，`/geohot/weekly` 与 `/geohot/monthly` 渲染成日报 | 服务端拿**原始请求路径**做前缀判断：`pathname.startsWith("/weekly")` 对 `/geohot/weekly` 永远不成立，于是静默退回日报（`apps/web/app/features/report/format.ts` 的 `kindFromPath`）。已改成按**路径段**匹配（`segments.includes("weekly")`），与挂在哪个前缀无关。注意先用 `appPath()` 剥前缀的写法在服务端 bundle 里**没有生效**，所以不要退回那种依赖构建期 base 的写法——`root.tsx` 的 `isAdminPath` 用的是 `appPath()`，它依赖服务端 bundle 里存在 `import.meta.env.BASE_URL` |
| 浏览器打开 `xxc2007.me/geohot`（无尾斜杠）看到应用的 404 | 那条 `return 308 /geohot/` 把 https 访客送去 **http**（CF 明文回源，Location 按连接协议拼）。**当时写的"已删除该跳转"是错的**：客户端路由的 basename 是 `/geohot`，裸路径照样解析不到首页，删了跳转只是把 404 从服务端挪到浏览器里。正解是保留这条 exact-match 跳转、把目标写死成 `https://$host/geohot/`（`fix-bare-path.sh` 插入的那个块、`geohot.nginx.conf片段` `# ---- ADD ----` 之后的第一块），同时把主 location 放宽为 `^~ /geohot`；应用对两种写法返回同一份页面，但**站内客户端跳转不过 nginx**，只有 URL 被规范化成 `/geohot/` 才治得干净 |
| 进去正常，点热点榜再点回来就 404 | **客户端路由匹配不了裸 basename**：basename 是 `/geohot`，客户端路由把 `/geohot` 解析成空路径，落到 404 路由（服务端 SSR 会归一化，所以直接打开是好的——这就是「一开始能看，点出去再点回来就不行」）。且客户端跳转不过 nginx，那条 308 救不了它。修法：首页入口（侧栏「精选」、移动底栏、Logo、各处「回到精选」）改成真实锚点指向 `<base>/`，即 `/geohot/`；实测 `pushState` 到 `/geohot` 渲染 404、`/geohot/` 渲染精选，是路由层面的确定性行为，不是猜测 |

## 子路径的第三次咬人：首页筛选标签（2026-10-01 深夜）

症状：首页点「一手 / 自然地理 / …」标签，地址变成 `xxc2007.me/geohot?category=physical`（**裸 basename + 查询串**），
客户端路由解析不了 → 404 页。

根因与前两次同源：React Router 在 basename 下把「根路径 + 查询串」解析成裸 basename。前两次分别修了
导航链接与 `kindFromPath` 的前缀判断，这次轮到首页那排 `CategoryTabs base="/"`。

修法：`TabItem` 增加 `hard` 标记，为真时渲染**真实锚点**而不是 router Link；`CategoryTabs` 在
`base === "/"` 时用 `publicPath()` 给出完整地址（`/geohot/?category=…`）。`/all` 那排（base="/all"）
不受影响，继续走客户端路由。

**这一类问题的判定标准**（下次直接照这个查）：凡是「目标指向应用根 + 带查询串」的链接，在 basename 下都会
退化成裸前缀；指向非根路径的（`/all`、`/hot`…）都正常。全站自检一行：
`grep -rn "base=\"/\"|to=\"/\"" apps/web/app` —— 每个命中都要确认它渲染的是真实锚点。

修完实测：首页 8 个标签目标全部 200（未筛选 25 条 → 一手 20、自然地理 20、人文 4、区域 12、地信 5、野外 2、观点 6）；
首页 59 个站内链接、/all 79 个、/hot 32 个、/topics 70 个、/about 29 个、/more 27 个**逐条访问全部 200，异常 0**。

## 二次修复：无尾斜杠的 404（2026-10-01 晚；2026-10-02 更正本节口径）

线上症状：访问 `https://xxc2007.me/geohot`（不带斜杠）看到应用自己的 404「这里没有内容」。

排查（都是实测，不是推断）：

```bash
curl -sI https://xxc2007.me/geohot | grep -i location    # Location: http://xxc2007.me/geohot/
curl -s -o /dev/null -w '%{http_code} %{num_redirects}\n' -L https://xxc2007.me/geohot   # 200 但 redirects=1
# 源站绕过 CF：
curl -k --resolve xxc2007.me:443:<server-ip> https://xxc2007.me/geohot   # 308 → https://…（443 直连时是对的）
# 应用本身：
curl http://127.0.0.1:3000/geohot  | wc -c    # 147116，标题与首页一致，无 404 标记
curl http://127.0.0.1:3000/geohot/ | wc -c    # 147116，同一份
```

结论：404 不是应用的错——应用对两种写法返回**同一份**首页。问题在那条 308 的**目标**：相对写法按连接协议
拼成 `http://`，而本站的 Cloudflare 是明文回源、且没有强制 http→https，于是访客被送到一个明文 URL，
链路在这里断掉。

### 这一节以前写错过一件事，现在按三份产物对齐

旧版这里写的是「修复 = 删掉 `location = /geohot` 跳转，把主 location 由 `^~ /geohot/` 放宽成 `^~ /geohot`，
两种写法都由应用直答」。**跳转没有被删，也不该被删**，三份产物现在口径一致：

| 产物 | 实际内容 | 与旧说法的关系 |
|---|---|---|
| `fix-bare-path.sh`（默认 DRY-RUN，`--apply` 才动文件） | 按花括号配平切出每一个顶层 `server` 块，只在**含 `^~ /geohot` 的那些块**里检查有没有 `location = /geohot`；有就跳过，没有就在该块的 `^~` 那行之前插一份 | 它要求这一条**存在**才叫装好，不是"确认它已被删掉"；以前它用 `replace(anchor, block+anchor, 1)` 只插**第一处**，另一个 vhost 漏掉 |
| 同上，找不到任何 `^~ /geohot` 时 | 打印 "no server block contains …" 并退出 2（片段还没贴就别跑这个脚本） | 主 location 确实放宽到不带尾斜杠了，这一条是真的 |
| 同上，只找到一个挂了 `/geohot` 的 server 块时 | 打印 "only ONE server block carries the … locations" 并退出 3，**一个字节都不写**；确实只有一个监听就 `GEOHOT_ALLOW_SINGLE_VHOST=1` 明确授权 | 片段第 3 条要求 :80 与 :443 两个都有（Cloudflare 明文回源），所以"只修一半"不再被静默接受 |
| `geohot.nginx.conf片段` 的 `# ---- ADD ----` 第一块 | 同一条 308，目标写死 `https://$host/geohot/` | 片段一直是这个口径 |

为什么必须保留：客户端路由的 basename 是 `/geohot`，裸 `/geohot` 被解析成空路径、落到 404 路由；
服务端 SSR 会归一化，所以"直接打开好的、点出去再点回来就 404"。站内跳转不过 nginx，只有把 URL 本身
规范化成 `/geohot/` 才治得住（上一节那排首页标签是同一根因的第三个面）。

代价也写进片段了（那条 `# ⚠️ 代价：scheme 写死成 https` 的注释）：`return 308 https://$host/...` 把 scheme 写死，**这个 location
只能挂在真有 TLS 的 vhost 上**；明文 staging vhost 里留它会把访客送去打不开的 https 地址。

### 现场判定（本次未连服务器，以下两条命令给执行者跑）

```bash
sudo nginx -T 2>/dev/null | grep -n 'location = /geohot' || echo "当前没有那条 308"
curl -s -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}\n' -L https://xxc2007.me/geohot
#   有 308 → 200 1 https://xxc2007.me/geohot/  （跳转在正常工作，这正是片段与脚本的口径）
#   没有   → 200 0 https://xxc2007.me/geohot   （旧版"删跳转"留下的状态；站内点回来会 404）
```

旧版记的 `200 0` 与"跳转仍在"互相矛盾，说明跑那次修复时这条 exact-match 不在站点文件里；要让线上回到
三份产物一致的形态，就按 `fix-bare-path.sh` 走一次：先不带参数跑（默认 DRY-RUN，它会把**每一个**挂了
`^~ /geohot` 的 server 块逐个列出来，标明"已有 308 / 将要插入"），确认计划对了再加 `--apply`——它先备份、
只对缺这一条的那些块各插一份（已有的不动、也不动别的行）、`nginx -t` 通过才 `reload`，测试不过就回滚备份，
`restart` 一律不许。它还会在"整个文件只有一个 server 块挂了 /geohot"时拒绝写入（片段第 3 条要求两个监听都有），
那种情况下要先把片段补进另一个 vhost。`verify-deploy.sh` 第 2 节有裸前缀断言，
跑一次就能看出是哪种状态。

浏览器端复核（真实 Chrome，非 curl，2026-10-01 那次）：`h1=精选`、无 404 文案、25 个条目链接、样式表
`/geohot/assets/root-*.css` 已加载（`cssRulesLoaded: true`）、body 底色 `rgb(250,249,246)` 即站点米白。

**给访客的提醒**：修好前浏览器可能缓存了那个 404，需要硬刷新（Ctrl+F5 / Cmd+Shift+R）才会看到新结果。

## 已知取舍：后台会话 cookie 的 `Path=/`（2026-10-02 记）

`packages/backend/src/admin/auth.ts:56-58` 的 `cookie()` 用 `Path=/`，没有随部署前缀收窄，所以
`aihot_admin` 会发给同域名下的**每一个**应用（本站与主站纪念册、Artalk 共用 `xxc2007.me`）。
本次**只记录、不改**，两个原因：

1. 改它不在这一轮的允许范围内（`admin/auth.ts` 归别的执行者），而在 `config.ts`/`app.ts` 侧另拼一份
   `Path` 会变成两处写 cookie，比现状更糟；
2. 收窄本身有代价：`Path=/geohot` 与老访客浏览器里已存的 `Path=/` 是两个不同的 cookie，登录会话会
   同时出现两份 `aihot_admin`，而 `parseCookies`（`admin/auth.ts:47-54`）取的是头部里**后出现**的那一个——
   老 cookie 到期前谁覆盖谁取决于浏览器排序。真要改，得同时把旧 cookie 以 `Path=/` 显式清一次
   （`Max-Age=0`），并准备好"上线后所有管理员重登一次"。

暴露面本身有限：会话令牌是随机串、库里只存 SHA-256（`admin/auth.ts` 头注），cookie 是 `HttpOnly` +
`SameSite=Lax`，且只在 https 下带 `Secure`（`routes/admin-auth.ts:23` 随 `SITE_URL` 的 scheme）；
同域下的其它应用能带上它、但不能读它（HttpOnly），除非那台应用有 XSS。所以要防的是"同域另一应用被攻破
后拿它当凭据"，属纵深防御，不是紧急漏洞。

**要改时的正确写法**（留给以后）：`Path` 用 `deployBase(config.siteUrl)`（`packages/contracts/src/http-policy.ts:129-137`，
`apps/api/src/routes/static.ts:75` 已经是这个用法），域名根部署返回 `""` → 保持 `Path=/` 不变；
`fix-bare-path.sh` 那类"浏览器路径"与 api 的根相对路径不冲突，因为浏览器看到的始终是 `/geohot/…`。

## 还没做的

- **日报/周报/月报尚未生成**（`reports` 表为空）：worker 在本机 16:17 才起，当天 08:00 的档期已过。
  上游有 catch-up 逻辑，下一次调度或手动触发后会出刊；在那之前 `/daily` 是诚实的空态。
- 未做外部监控与自动重启之外的自愈；日志用 `journalctl -u geohot-*`。
- 主站与 GEOHOT 共用 Cloudflare 的 SSL 模式（回源明文）。要改成 Full(strict) 属于主站配置变更，
  需站主决定，本次未动。
- **恢复与搬家**：备份一直有文档，恢复以前哪儿都没有。现在写在 `README-deploy.md` 第 6.1 节（`pg_dump -Fc` →
  传输 → `createdb` → `pg_restore -j`（custom 格式支持并行，PG 16/17 都是）→ 数一遍那七张关键表 → 重跑 smoke）与第 10 节（换域名/换服务器的清单，
  含"哪些密钥必须重新签发"和"改 `industry/**` 必须重建 web"）。本次没有在那台机器上跑过恢复——
  那一节是写给下一次真要搬的人的，第一次跑要人在旁边。
- `api`/`worker`/`web` 三个模板这轮补上了 `MemoryMax`（160/200/240/320 那一组，与 `install-units.sh`
  生成的线上单元一致）。`systemd/` 模板与 `install-units.sh` 生成的单元仍不完全相同：模板多一层
  `ProtectSystem=strict` 等加固，且 `TimeoutStopSec` 按进程分档（api/brain 30、web 90、worker 285——
  只有 worker 有 255 s 的 in-flight drain），而 `install-units.sh` 给四个单元一律 285（多给不伤，少给才会
  在 drain 中途 SIGKILL）。走哪条就用哪条，别混。

## 热更新：改了什么就重启谁（2026-10-02、2026-10-04 各踩到一次）

- **`industry/changelog.json` 是 api 进程在启动时读入的**：只改它（比如补一条发版说明）也必须
  `systemctl restart geohot-api`，否则 `/changelog` 与 `/api/site/changelog` 继续发旧内容。2026-10-02
  的一次热更新只重启了 web，页面 200、内容没变——状态码看不出这一类问题，要按内容断言（例如
  `curl …/api/site/changelog | grep <新标题>`）。
- **改了 `tooling/*.ts` 里的进程内代码（`tooling/brain-stub.ts`）→ 必须 `systemctl restart geohot-brain`。**
  这是 2026-10-04 查出来的第二个「状态码全绿而行为是错的」：`geohot-brain` 从 2026-10-01 16:17 起
  `active` 了三天，而这三天里 `tooling/brain-stub.ts` 被改过两次（`f35da0a` 2026-10-02 把 summarize
  缺稿默认值从 `condense` 改成 `empty`、`c9f893b` 2026-10-03 把中文门槛做成结构性的）。Node 在启动时把
  整个 `.ts` 读进内存，**它不热更新自己的代码**——`tooling/fixtures/**`、`industry/prompts/**`、
  `industry/taxonomy.ts` 是 mtime 热读的，所以「改了 taxonomy 就生效」很容易让人误以为这个进程也是
  热更新的。后果：进程一直按旧的 `condense` 行事，把**英文原标题与英文正文的机械截断**写进
  `title_zh` / `summary_zh`（`analyze.ts` 的中文闸门因此形同虚设），每天一两百到五百条条目带着
  拉丁文标题留在 `analyses` 里。
  判据不能靠 mtime：`git archive` 给整棵树的每个文件盖上的是**提交时刻**，整包升级后源码 mtime 必然
  晚于进程启动时刻。改用内容哈希——`brain-stub.ts` 在 healthz 里报出自己启动时读进内存那份代码的
  `source.sha256`，`verify-deploy.sh` 拿磁盘上同一文件重算比对，不一致就是「在跑旧代码」（硬失败）。
  这一条已在 `verify-deploy.sh` 第 2 节里落地，整包升级会自动查。
- 只改前端（`apps/web/**`）→ 重建 web（带 `BASE_PATH=/geohot`）并重启 `geohot-web`。
- 只改后端（`apps/api`、`packages/backend/**`）→ 重启 `geohot-api` 与 `geohot-worker`。
- **改了 `jobs/queue.ts` 的 `QUEUE_OPTIONS`（任务重试次数、过期窗口）→ 也是重启 api/worker 就生效**，
  但要知道它凭什么生效：pg-boss 的 `createQueue` 对已存在的队列是空操作（2026-10-06 实测：库里那一格
  一直停在旧值，代码改了三次都没进库），现在由 `ensureQueue` 在进程第一次碰到该队列时用 `updateQueue`
  把库里那行对齐代码——逐列 UPDATE，不重建队列，等待中的任务一条不掉。验收一条 SQL 就够：
  `SELECT name, expire_seconds, retry_limit FROM pgboss.queue WHERE name='content.analyze'`。
  两个例外：`policy` 与 `partition` 建好后改不了（只报 warn，要改得人工处理），对齐失败也只报不抛，
  因为入队是在业务事务里 await 的，抛出去会连带发布回滚。
- 改 `tooling/fixtures/**` → 不重启任何单元（编辑大脑 stub 按文件 mtime 热读），但要**重跑分析**：
  回执缓存会让同一个 revision 复用旧答案。用 `node scripts/refill-copy.ts --apply --ids …`（默认
  dry-run）或后台的「重跑分析」；两者都走 attemptTag 这条真新请求路径。
- 新增 npm 依赖 → 提取代码后先在应用目录装依赖再构建：
  `sudo systemd-run --quiet --pipe --wait --uid=geohot --gid=geohot --property=MemoryMax=700M --property=MemorySwapMax=1500M --property=WorkingDirectory=/opt/geohot/app env HOME=/opt/geohot NODE_ENV=production npm install <pkg> -w @aihot/backend --no-audit --no-fund`
  只提取不装依赖，api/worker 会倒在 import 上（2026-10-02 新增 `marked` 时走的就是这条）。
- **一句话记法**：`apps/`、`packages/` 里改的是「被 import 的模块」，进程重启才会重读；
  `industry/**`、`tooling/fixtures/**` 里改的是「运行时按 mtime 热读的数据」，不重启也对——
  而 `tooling/*.ts` **不属于后者**，它是程序本身。

## 整包升级（2026-10-03 第八轮上线时走的顺序，可照抄）

```bash
# 本机：导出被验收过的 HEAD（不含 .env / .data，tar 也不含 git 元数据）
git archive HEAD | gzip > /tmp/geohot-src.tar.gz
# 密钥文件名与登录名一律用占位符：这份文档在公开仓库里，别把真实的用户名和密钥路径写进来。
scp -i ~/.ssh/<你的密钥>.pem /tmp/geohot-src.tar.gz <ssh-user>@<主机>:/tmp/

# 服务器
sudo tar -czf /opt/geohot/backups/app-$(date +%Y%m%d-%H%M%S).tar.gz -C /opt/geohot app   # 先备份
sudo tar -xzf /tmp/geohot-src.tar.gz -C /opt/geohot/app --owner=geohot --group=geohot
sudo chown -R geohot:geohot /opt/geohot/app          # ★ 见下面那条坑
sudo -u geohot bash -lc 'cd /opt/geohot/app && node --env-file=.env scripts/migrate.ts'   # 有新迁移就先跑
sudo -u geohot bash -lc 'cd /opt/geohot/app && node --env-file=.env scripts/seed.ts'      # 只增不改，可重复
sudo -u geohot bash -lc 'cd /opt/geohot/app && BASE_PATH=/geohot NODE_ENV=production npm run build -w @aihot/web'
sudo systemctl restart geohot-api geohot-worker geohot-web
# 改了 tooling/brain-stub.ts（或任何 tooling/*.ts）就要连 brain 一起重启 —— 它不热更新自己的代码。
# 整包升级几乎总会带上新的 brain-stub.ts，所以整包升级的默认动作是四个单元全重启：
#   sudo systemctl restart geohot-brain geohot-api geohot-worker geohot-web
# 只改前端/后端而 brain-stub.ts 确实没动时，才可以把 brain 从这一行去掉。verify-deploy.sh 会用
# healthz 里的 source.sha256 与磁盘比对，漏重启 brain 会被它判成硬失败。
cd /opt/geohot/app && sudo -u geohot bash deploy/geohot/verify-deploy.sh   # 必须 ALL CHECKS PASSED
```

**那条 `chown -R` 不是例行公事**：2026-10-03 第一次构建倒在
`EACCES: permission denied, rmdir '/opt/geohot/app/apps/web/build'`——`build/` 自己是 geohot 的，
但它的**父目录 `apps/web` 是 root 的**（早先某次 root 身份解包留下的），而 `react-router build` 要
先删旧产物，删子目录要的是父目录的写权限。整包升级后一律把应用树交回 geohot，别等构建报错再查。

**只动文档或 `industry/changelog.json` 的最小更新**：`industry/changelog.json` 是 **api 进程启动时读入**，
改了它必须 `systemctl restart geohot-api`（否则 `/changelog` 发旧内容，状态码看不出来）；纯前端改动
只需重建 + 重启 web；后端改动重启 api 与 worker。
