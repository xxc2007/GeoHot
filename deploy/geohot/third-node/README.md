# 第三台机器：阿里云 ECS（杭州）

一台按量付费的国内 ECS，用来把「执行、备份、回归」从单机撑成三机。

| 项 | 值 |
| --- | --- |
| 实例 | `iZbp14vh9sicf5z7law47aZ`（华东1 · 杭州 B） |
| 规格 | 2 vCPU / 2 GiB / 40 GiB ESSD Entry / 100 Mbps 峰值（按流量计费） |
| 系统 | Ubuntu 22.04 64 位 |
| 公网 | `47.97.97.62` |
| 内网 | `172.23.110.180` |
| 已装 | Docker 社区版（可做镜像构建，不跑线上流量） |

## 它承担什么

| 角色 | 为什么是这台 | 落地 |
| --- | --- | --- |
| **分析执行器** | 2 GiB 内存比第二台（1 GiB）宽，能稳定吃 2–3 个分析槽 | `geohot-exec-worker.service` + `geohot-exec-tunnel.service` |
| **备份副本** | 与主库、第二台不同可用区/地域，逻辑备份再存一份 | `geohot-backup-pull.timer`（03:40，留 7 份） |
| **国内读者面探针** | 国内线路量出来的才是读者真实体感 | `geohot-probe.timer`（5 分钟，6 个出口） |
| **真浏览器回归** | 2 GiB 能跑 Chromium；1 GiB 跑不动 | `geohot-reader-regression.timer`（04:20） |

**不承担**：80/443 对外服务。国内服务器对未备案域名开放 80/443 是违规的，Cloudflare 那层继续由香港源站 + CF 边缘承担；这台只在非 80/443 端口跑内部工作负载。

## 安装

前提：这台机器的 `~geohot/.ssh/id_ed25519.pub` 已加进主库 `xxc@20.194.28.128` 的 `authorized_keys`（数据只走 SSH 隧道，不把 5432 暴露到公网）。

```bash
# 以 root 在新机器上
bash setup-exec.sh     # 依赖 / swap / Node 24 / 用户 / 仓库 / 隧道 + 执行器 / 两档 timer
bash setup-ops.sh      # 备份副本 / 国内探针 / Chromium 回归
```

两个脚本都是幂等的：重复跑只会补缺，不会重复建用户或覆盖已有 `/opt/geohot-exec/.env`。

## 怎么看它在干活

```bash
systemctl is-active geohot-exec-worker geohot-exec-tunnel
journalctl -u geohot-exec-worker -n 20 --no-pager | grep -E 'worker started|content.analyze'
systemctl list-timers --no-pager 'geohot-*'
ls -lh /var/backups/geohot | tail -3
journalctl -u geohot-probe -n 12 --no-pager
```

主库侧看它领了多少活：

```sql
select application_name, state, count(*)
from pg_stat_activity
where application_name like 'aihot-jobs%'
group by 1, 2;
```

## 三台机器的分工

| 机器 | 内存 | 角色 |
| --- | --- | --- |
| 主库 `20.194.28.128`（香港） | 891 MiB | 读者面（api/web）、采集与调度、唯一可写的 Postgres |
| 第二台 `8.148.65.89`（武汉） | 1 GiB | 24h 执行器（2 槽）、备份、curl 探针 |
| 第三台 `47.97.97.62`（杭州） | 2 GiB | 24h 执行器（2–3 槽）、备份副本、国内探针、真浏览器回归 |

读者面优先级不变：任何一台的执行器都只通过 `GEOHOT_INTAKE_*` 争抢同一个队列，主库的 `COMBINED_LIMIT=1` 保证它自己永远留有余量给 SSR。

## 边界

- 不要设 `WORKER_ROLE=all`：这台只做 `content-executor`，调度归主库。
- 备份是逻辑备份，不替代 PITR；主库那份是第一份，这里只是副本。
- 真浏览器回归只在夜间跑（`Nice=10`），白天不与读者抢 CPU。
- Cloudflare 对无头浏览器有机器人评分：`/topics` 这类页面可能落到挑战页。遇到就把该路由从回归清单里摘掉，用 curl 级探针兜底。
