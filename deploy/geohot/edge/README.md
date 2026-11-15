# 国内边缘节点（华为云广州）

主库在 Azure（国际），国内读者经 Cloudflare 回源要 1.9–5.1 秒。这台华为云广州的机器
（`hcss-ecs-6a39`，2 vCPU / 1775 MB）现在同时做两件事：

1. **内容执行器**：`WORKER_ROLE=content-executor`，2 个分析槽，走 SSH 隧道连主库与主库上的 magpie；
2. **国内边缘**：nginx 缓存反代 → 隧道 `8443` → 主库的 `https://127.0.0.1:443`，HTML 缓存 120 秒，
   另有 50 秒一轮的保温定时器。

实测（2026-11-15，同一时刻）：

| 入口 | 杭州 | 本机（上海） |
| --- | --- | --- |
| `http://<华为IP>/geohot/`（边缘） | **0.11 s** | **0.29 s** |
| `https://xxc2007.me/geohot/`（CF → Azure） | 2.10 s | 1.9–5.1 s |

> 域名 `xxc200707.me` 目前在公网是 **NXDOMAIN**，所以边缘只能先用 IP 访问；
> 一旦补上 A 记录指向这台机器，`certbot --nginx -d xxc200707.me` 就能拿到证书并开 443。

## 装法

```bash
# 1) 隧道：数据库 15432、magpie 3426、主库 https 8443
sudo bash install-edge.sh tunnel      # 写 /etc/systemd/system/geohot-exec-tunnel.service 并启动

# 2) 边缘：nginx 缓存反代 + 每分钟保温
sudo bash install-edge.sh edge
```

`install-edge.sh` 是幂等的：重复跑只会把配置改回本文件描述的状态。

## 为什么要保温

边缘的缓存只活 120 秒，而主库的 SSR 在后台流水线跑起来时要 1–3 秒。没有保温器时，
缓存一过期，第一位读者就会撞上这次冷算（实测 3.5 s）。保温器每 50 秒把六个常用地址
走一遍自己的缓存，读者永远命中。

## 与主库的关系

- 边缘**不连数据库**，它只反代主库的 https；主库读不到时会拿到主库 nginx 的 `use_stale` 旧页，
  边缘再用 `proxy_cache_use_stale` 兜一层，所以主库慢的时候国内读者仍然是毫秒级。
- 主库发布新版本后，边缘最多 120 秒自动跟上，不用重启。

## 国内入口的域名约束（2026-11-15 实测）

华为云对**未备案域名**做 HTTP 拦截：`Host: xxc200707.me` 直接返回 `403 非法阻断374`（`Server: ADM/2.1.1`），
而 `Host: xxc2007.me`、`Host: cn.xxc2007.me`、`Host: geohot.xxc2007.me` 以及裸 IP 都是 200 —— 拦的是「注册域」这一级，
`xxc2007.me` 已有备案，所以它的任何子域可以直接打到这台机器。

因此国内 HTTPS 的正确接法不是新域名，而是 **已备案主域的子域**：

1. 在 DNS 加一条 `cn.xxc2007.me A 113.45.66.100`（**灰云 / DNS only**，不要开橙云，否则又绕回 Cloudflare）；
2. `certbot --nginx -d cn.xxc2007.me`；
3. 把本目录 `geohot-domestic.conf` 的 `server_name` 改成 `cn.xxc2007.me`，监听 443 并 301 从 80 跳过来。

`xxc200707.me` 想用也可以，但要先在华为云做完 ICP 备案（管局 1–20 个工作日），期间它只会拿到 403。

## 一条命令把国内域名接上（需要 Cloudflare 的 DNS 权限）

```bash
CLOUDFLARE_API_TOKEN=*** CLOUDFLARE_ZONE=xxc2007.me \
EDGE_DOMAIN=cn.xxc2007.me EDGE_IP=113.45.66.100 \
  bash deploy/geohot/edge/set-edge-dns.sh --apply
```

脚本做三件事：`Zone.DNS:Edit` 权限下 upsert 一条**灰云** A 记录 → 等本机解析到位 → `certbot --nginx -d <域名> --redirect`。
Token 只有这一项权限就够，不需要 Global Key；`--apply` 之前是纯 dry-run。

为什么必须是 `xxc2007.me` 的子域：华为云按「注册域」拦截未备案站点（80/443 都拦，见上一节）；
`xxc200707.me` 想用，先去华为云做 ICP 备案。

## 2026-11-15 实测：`certbot --nginx` 在这条链路上走不通，证书得用 DNS-01

`cn.xxc2007.me` 的 A 记录（灰云）加好之后，`certbot --nginx -d cn.xxc2007.me` 仍然失败：

```
Detail: 113.45.66.100: Invalid response from
http://cn.xxc2007.me/.well-known/acme-challenge/<token>: 403
```

本机 `curl -H "Host: cn.xxc2007.me" http://113.45.66.100/.well-known/acme-challenge/probe` 是 **200**，
但 Let's Encrypt 的校验节点在境外，华为云对境外来源的 80 端口同样按「未备案注册域」拦掉（`Server: ADM/2.1.1`）。
所以 HTTP-01 这条路在这里是死的，只能用 DNS-01。

一条命令（`tls` 子命令，需要 `Zone.DNS:Edit` 的 token）：

```bash
CLOUDFLARE_API_TOKEN=*** sudo -E bash deploy/geohot/edge/install-edge.sh tls
```

它做四件事：
1. 装 `certbot` + `python3-certbot-dns-cloudflare`，把 token 写进 `/etc/letsencrypt/cloudflare.ini`（600）；
2. `certbot certonly --dns-cloudflare --cert-name cn.xxc2007.me`（自动建/删 `_acme-challenge` TXT）；
3. 写 `geohot-edge-tls.conf`（443 + HSTS）与 `geohot-edge-http.conf`（80 → 301），reload nginx；
4. 把保温器切到 https，并跑一次 `certbot renew --dry-run` 证明续期链路真的通。

实测（22:4x）：

| 入口 | 杭州 | 上海（本机） |
|---|---|---|
| `https://cn.xxc2007.me/geohot/`（命中边缘缓存） | **0.35 / 0.64 s** | **0.11 / 0.04 s** |
| 同一条路径经 Cloudflare（`xxc2007.me`） | 1.25 s（冷）/ 9.8 s（回源） | 1.9–5.1 s |

续期：`certbot renew` 由 `certbot.timer` 每天跑两次，认证方式已写入
`/etc/letsencrypt/renewal/cn.xxc2007.me.conf`（`authenticator = dns-cloudflare`），不需要人值守。
