# 读者优先的吞吐配比（891 MB / 2 vCPU / 单盘 ~250 IOPS）

这台主库只有一块慢盘。反复对照实验的结论是：**「采集 + 读者」可以共存，「分析 + 读者」在满载时会互相伤」**——
一个分析槽把磁盘占满，首页冷请求就从 35 ms 推到 2.4–5 s。所以读者面的速度不是靠「给读者更多名额」，
而是靠**让读者根本不落到数据库上**，再把剩下的磁盘时间全给后台。

## 一、读者面为什么不依赖数据库

| 层 | 位置 | 作用 |
| --- | --- | --- |
| nginx 页面缓存 | `deploy/geohot/public-cache.conf`、`geohot-public-cache.conf` | `proxy_cache_valid 200 60s` + `use_stale error timeout updating 5xx` + `background_update on`：上游慢就给上一版，读者永远不等 |
| 预热带 | `geohot-warm-hot.timer`（每 55–60 秒热首页与「全部」）、`geohot-warm-pages.timer`（2 分钟热其余四屏） | 缓存 60 秒过期，预热带在过期前后各刷一次，读者几乎不撞冷算 |
| 进程内快照 | `packages/backend/src/publication/timeline.ts` 的 30 秒快照 | 5 秒窗内的重复请求直接命中 |
| 落盘底稿 | `apps/api/src/pool-snapshot.ts`（`pool:` 与 `tl:` 两种 key，12 小时） | API 进程重启后第一条请求也不用等数据库 |
| 读取预算 | `packages/backend/src/publication/read-budget.ts` 的 `CapacityGate(4, 8)` + `statement_timeout` | 读库排队超限时快速失败，由 nginx 的 stale 兜住，而不是拖住连接 |

验收口径：`/geohot/`、`/geohot/all?tab=all`、`/geohot/topics`、`/geohot/daily`、`/geohot/hot`、
`/geohot/starred` 随机 20 次必须 **全部 200**，且 p90 < 300 ms（含 CF 之前的源站往返）。

## 二、后台怎么给（2026-11-15 实测稳态）

| 机器 | 角色 | 分析槽 | 合并/车道 | 采集并发 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 杭州 `<杭州主机>` | `all`（协调者 + 分析） | 4 | 8 / 4 | 4 | 只有它是协调者：`cron.sources.schedule` 由它注册 |
| 武汉 `<武汉主机>` | `content-executor` | 3 | 5 / 3 | 2 | |
| box | `content-executor` | 2 | — | — | 走隧道到主库 5432 |
| 本机 ThinkBook | `content-executor` | 2 | — | — | 夜间在线；白天 `PAUSED` |
| 主库 | readers-only | 0 | — | — | `geohot-worker` / `geohot-media` 停着 |

- 所有执行器的 systemd 都有 `zz-idle-io.conf`（`IOSchedulingClass=idle`、`Nice=15`）：后台只在磁盘空闲时抢。
- **名额以 `.env` 为准**：`geohot-exec-window-day/night.timer` 与 `50-window.conf` 已删除——它们每天 07:00 把槽位改回 1，
  而那个 1 就是「分析永远排不进去」的根因（2026-11-15 现场：`.env` 写 3，drop-in 写 1，systemd 让 drop-in 赢）。
- 采集节奏：启用源按 `interval_minutes = max(30, min(360, 原值/4))` 提到 30–360 分钟（986 个源），
  `next_fetch_at` 随机铺开 30 分钟避免同刻撞车；`fail_count > 10` 的源不动，避免锤坏站。

## 三、怎么再调

1. 先看 `head -1 /proc/pressure/io`：`avg10 > 60` 就说明后台已经贴到盘的上限，不要再加槽。
2. 再看 `pgboss.job` 的 `content.analyze` 里 `state in ('created','retry')`：持续下降 = 供给不足（去提采集），持续上涨 = 分析不够（先看 io）。
3. 每次只动一个旋钮，改完跑 `bash /tmp/soak.sh`（20 条读者路由）与 `probe.sh`（首页/全部各 3 次）：
   **出现任何 5xx、或 p90 > 500 ms，就把上一次的改动退回去**。
4. 读者面出问题时的顺序：先保 nginx 与预热（`systemctl start geohot-warm-hot.timer`），再降后台槽位，最后才考虑动 `CapacityGate`。
