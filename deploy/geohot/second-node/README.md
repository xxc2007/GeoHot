# 第二台服务器：分析执行器 + 备份落地 + 国内探针

主库那台机器只有 **2 vCPU / 891 MiB**，白天一个执行名额就是读者体验的上限（两个名额时首页曾被打到 25 秒）。
2026-11-06 起多了一台国内的轻量应用服务器（阿里云 `Ubuntu-rfen`，2 vCPU / 1 GiB / 30 GiB，公网 `8.148.65.89`），
它不参与读者面，只做三件事：

| 角色 | 做什么 | 为什么放在这台机器上 |
| --- | --- | --- |
| **24h 分析执行器** | `WORKER_ROLE=content-executor`，白天 2 条分析并发、夜里 2 条，连主库的 `pgboss` 队列领 `content.analyze` | 分析是「等模型」的活，不吃主库的 CPU；主库省下的名额全给读者面 |
| **备份落地** | 每天 03:20 在主库 `pg_dump -Fc`，拉回本机 `/var/backups/geohot`，留 4 份 | 备份不能和主库同盘；导出用主库自己的 `pg_dump`，版本永远对得上（Ubuntu 24.04 自带客户端是 16，主库是 17） |
| **国内探针** | 每 5 分钟 `curl` 一遍 `/`、`/all`、`/topics`、`/changelog`、`/feed.xml`、`/api/health`，超 5 秒记 `SLOW`，非 200 记 `FAIL` | 本机走 TUN 代理，看不到国内读者真正的路径与耗时 |

## 数据怎么过来

不复制数据库，也不开公网 5432。用一条常驻 SSH 隧道（`geohot-exec-tunnel.service`）：

```
ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 -L 127.0.0.1:3426:127.0.0.1:3426 xxc@20.194.28.128
```

- `15432` 是主库 Postgres；执行器 `.env` 里的 `DATABASE_URL` 只把端口改成 `15432`。
- `3426` 是主库上的 magpie 网关，`*_BASE_URL` 因此**不用改写**，模型池与冷却表仍然是同一份。
- 新机器有自己的 `~/.ssh/id_ed25519` 出站密钥，主库 `authorized_keys` 里按 `from="8.148.65.89"` 限源。

## 安装顺序

四段脚本都在本目录，幂等，可重复执行：

1. `bootstrap1.sh`（root）：基础包、2 GiB swap、Node 24（走 npmmirror）、建 `geohot` 用户与公钥、`git clone` 仓库、`npm ci`。
2. `/opt/geohot-exec/.env`：从主库 `/opt/geohot/app/.env` 整份拷来，改三处 —— `DATABASE_URL` 端口改 `15432`、`WORKER_ROLE=content-executor`、把 `COLLECT_ENABLED` 与 `MODEL_CALLS_ENABLED` 显式写 `true`（执行器不接受缺省）。
3. `bootstrap2-exec.sh`：`geohot-exec-tunnel.service` + `geohot-exec-worker.service`（`MemoryHigh=430M`、`MemoryMax=520M`、`MemorySwapMax=1024M`）。
4. `bootstrap3-ops.sh`：备份与探针（`geohot-backup.timer` 03:20、`geohot-probe.timer` 每 5 分钟）。
5. `bootstrap4-window.sh`：两档并发（01:00 起 2、07:00 起 2 —— 目前两档都是 2，留这个开关是为了日后按读者面回调）。

## 怎么看它在干活

```bash
# 隧道在不在
ssh root@8.148.65.89 'systemctl is-active geohot-exec-tunnel; ss -ltnp | grep -E "15432|3426"'
# 执行器领没领活（主库上数）
sudo -u postgres psql -d geohot -tAc \
  "select count(*) from pgboss.job where name='content.analyze' and completed_on > now()-interval '30 min'"
# 备份有没有落地
ssh root@8.148.65.89 'ls -lh /var/backups/geohot; journalctl -u geohot-backup -n 5 --no-pager'
# 国内读者的实际耗时
ssh root@8.148.65.89 'journalctl -u geohot-probe -n 8 --no-pager'
```

## 已知边界

- **不要**在这台机器上跑 `WORKER_ROLE=all`：它会注册采集、日报、定时任务，和主库的协调者抢同一批 cron。
- 无头浏览器在这台机器上只做到「首页与 `/all` 能渲染」，`/topics` 会被 Cloudflare 的机器人评分拦成挑战页（45 秒超时）。
  真正的界面回归仍在主库那台机器上用 `_diag/browser/verify-*.mjs` 跑；这台机器只做 curl 级探针。
- 备份是逻辑备份，恢复要 `pg_restore`；它不替代主库上的 PITR 归档。
