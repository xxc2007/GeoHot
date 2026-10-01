# 部署记录：xxc2007.me/geohot/

2026-10-01 实装。这份记录写的是**实际做了什么、怎么验证的、哪一步曾经猜错**，
不是计划。主站（南昌十五中纪念册）全程未被改动，每一步都有哈希可比。

## 结果

- 线上地址：`https://xxc2007.me/geohot/`
- 主站：`https://xxc2007.me/` = **51432 字节，sha256 `4edf0fc53636a680…`**，与开工前基线逐字节一致
- 四个常驻单元全部 `active`：`geohot-brain`(3055) · `geohot-api`(3001) · `geohot-worker` · `geohot-web`(3000)，
  只监听 `127.0.0.1`，每个都带 `MemoryMax`（160/200/240/320 MB），OOM 只会杀自己
- 服务器：Ubuntu 22.04，`xxc@20.194.28.128`，Node v24.21.0，PostgreSQL 17 本机，
  swap 2 GB（**部署前就存在**，不是这次加的）

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
2. **前端**：带子路径构建，且在 cgroup 内存上限内跑（非特权用户的 `systemd-run` 会要 polkit 交互认证，必须 sudo）：
   ```bash
   sudo systemd-run --quiet --pipe --wait --uid=geohot --gid=geohot \
     --property=MemoryMax=900M --property=MemorySwapMax=1500M \
     --property=WorkingDirectory=/opt/geohot/app \
     env HOME=/opt/geohot BASE_PATH=/geohot NODE_ENV=production npm run build -w @aihot/web
   ```
   `--property=WorkingDirectory=` 不能省：`systemd-run` 默认在 `/` 起进程，npm 会报
   `ENOENT /package.json`。
3. **单元**：`bash deploy/geohot/install-units.sh`（见该脚本注释里的三条修正）。
4. **nginx**：把 `geohot.nginx.conf片段` 注入 `xxc2007.me` 的每个 server 块，`nginx -t` 通过后 `reload`。
   三条硬约束（`^~`、不剥前缀、两个监听都要）写在该片段头部，都是**页面 200 而静态资源 404** 这类
   静默故障，只看状态码发现不了。

## 曾经猜错的地方（留档，免得下次再猜）

| 症状 | 真正原因 |
|---|---|
| `ssh ubuntu@…` 被拒 | 登录用户是 **`xxc@`**，不是 `ubuntu@` |
| `node: .env: not found` + 单元反复重启 | 相对 `--env-file=.env` 相对的是单元自己的 `WorkingDirectory` |
| 公网 404、直连 443 却 200 | Cloudflare **80 端口明文回源**，`:80` 的 vhost 没有 location |
| 页面 200，CSS/JS 全 404 | 同 vhost 的 `~* \.(css\|js\|…)$` 正则覆盖了普通前缀 location，要用 `^~` |
| 页面 200，资源 404（另一种） | 反向剥了 `/geohot` 前缀，而应用带 BASE_PATH 构建、自己归一化路径，不能剥 |
| 改完 nginx 仍 404 | 注入了 `www.xxc2007.me` 那个 vhost——`www.xxc2007.me` 的字符串里含 `xxc2007.me`，必须按 server_name **整词**匹配 |
| 浏览器打开 `xxc2007.me/geohot`（无尾斜杠）看到应用的 404 | 那条 `return 308 /geohot/` 把 https 访客送去 **http**（CF 明文回源，Location 按连接协议拼）。已删除该跳转并把手位放宽为 `^~ /geohot`；应用对两种写法返回同一份页面，不需要跳转 |

## 二次修复：无尾斜杠的 404（2026-10-01 晚）

线上症状：访问 `https://xxc2007.me/geohot`（不带斜杠）看到应用自己的 404「这里没有内容」。

排查（都是实测，不是推断）：

```bash
curl -sI https://xxc2007.me/geohot | grep -i location    # Location: http://xxc2007.me/geohot/
curl -s -o /dev/null -w '%{http_code} %{num_redirects}\n' -L https://xxc2007.me/geohot   # 200 但 redirects=1
# 源站绕过 CF：
curl -k --resolve xxc2007.me:443:20.194.28.128 https://xxc2007.me/geohot   # 308 → https://…（443 直连时是对的）
# 应用本身：
curl http://127.0.0.1:3000/geohot  | wc -c    # 147116，标题与首页一致，无 404 标记
curl http://127.0.0.1:3000/geohot/ | wc -c    # 147116，同一份
```

结论：404 不是应用的错——应用对两种写法返回**同一份**首页。问题在那条 308：它按连接协议拼成 `http://`，
而本站的 Cloudflare 是明文回源、且没有强制 http→https，于是访客被送到一个明文 URL，链路在这里断掉。

修复：`sudo bash deploy/geohot/fix-bare-path.sh` —— 删掉 `location = /geohot` 跳转，把主 location 由
`^~ /geohot/` 放宽成 `^~ /geohot`，两种写法都由应用直答。修完实测：

```bash
curl -s -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}\n' -L https://xxc2007.me/geohot
# 200 0 https://xxc2007.me/geohot     ← 零跳转，全程 https
```

浏览器端复核（真实 Chrome，非 curl）：`h1=精选`、无 404 文案、25 个条目链接、样式表
`/geohot/assets/root-*.css` 已加载（`cssRulesLoaded: true`）、body 底色 `rgb(250,249,246)` 即站点米白。

**给访客的提醒**：修好前浏览器可能缓存了那个 404，需要硬刷新（Ctrl+F5 / Cmd+Shift+R）才会看到新结果。

## 还没做的

- **日报/周报/月报尚未生成**（`reports` 表为空）：worker 在本机 16:17 才起，当天 08:00 的档期已过。
  上游有 catch-up 逻辑，下一次调度或手动触发后会出刊；在那之前 `/daily` 是诚实的空态。
- 未做外部监控与自动重启之外的自愈；日志用 `journalctl -u geohot-*`。
- 主站与 GEOHOT 共用 Cloudflare 的 SSL 模式（回源明文）。要改成 Full(strict) 属于主站配置变更，
  需站主决定，本次未动。
