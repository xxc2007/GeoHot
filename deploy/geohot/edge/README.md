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
