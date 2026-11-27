# InstaBox 沙箱（第五个执行器）

InstaBox 是一台按小时计的沙箱机（`4 vCPU / 8 GB / 20 GB /data`），跑 `content-executor` 的角色：
它对主库只做两件事 —— 通过 ssh 隧道读写同一个 Postgres、通过同一条隧道调 magpie 的模型门。

## 三条免费档限制（2026-11-15 实测）

| 限制 | 值 | 能不能改 |
|---|---|---|
| 空闲自动暂停 | `autoSuspendAfterSeconds: 1800`（30 分钟没人用） | **不能**：`PATCH` 返回 `403 spec_not_allowed` |
| 单次最长运行 | `maxRunMinutes: 120`（用得多会长到 480） | 不能 |
| 持久盘 | 只有 `/data`（`persistentDiskGiB: 20`、`storage.synced: true`） | 根盘可能被模板重置 |

**关键点**：沙箱里的执行器只往外连（ssh 隧道），平台看不到任何「入向活动」，所以「进程在跑」不等于「有人在用」。
保活必须从外面打进来。

## 保活：三层，任何一层失效都不至于让它冻住

2026-11-27 的事故说明了单层为什么不够：`/etc/geohot/instabox-token` 里的 key 早已被吊销
（`401 revoked_key`），`instabox-hold` 连续 11 天每分钟 401、日志里只有 error 没有人在看；
instabox 当天 **13:06→21:27 冻了 8.7 小时**，主库里 `cron.*` 到期触发堆了 841 条。

| 层 | 装在哪 | 节拍 | 做什么 |
|---|---|---|---|
| 1. `instabox-hold`（`deploy/geohot/bin/instabox-hold.mjs`） | 主库 xxc | 60 秒探一次，5 分钟一次 `exec` | `/start` 唤醒、执行器不在岗就重放 bootstrap |
| 2. `instabox-lease`（本目录三个文件） | 常驻机 hcss + 阿里云 | 10 分钟续一次，TTL 1 小时 | `PUT /activity-leases/geohot-worker`（平台认的「有人在用」），顺手 `systemctl start` 隧道与 worker |
| 3. 单元自身 | 沙箱内 | 崩了 5 秒后 | `Restart=always`、`StartLimitIntervalSec=0`、`is-enabled` |

第 2 层是 2026-11-27 加的：**`activity-lease` 比 `exec` 更直接**——它的语义就是「这个机器上还有任务在做」，
续租期间空闲计时器根本不会开始；`autoSuspendAfterSeconds` 是免费档固定值、PATCH 会 `403 spec_not_allowed`，
所以只能从外面一直续。装在 hcss 与阿里云而不是主库，是因为主库 891MB/250IOPS，能少一件事就少一件。

安装（在 hcss / 阿里云上，root）：

```bash
install -m 700 instabox-lease.txt /opt/geohot-exec/instabox-lease.txt
install -m 644 instabox-lease.service instabox-lease.timer /etc/systemd/system/
# key 与主库那份是同一个，600 root
install -m 600 /path/to/instabox-key /opt/geohot-exec/instabox.key
systemctl daemon-reload && systemctl enable --now instabox-lease.timer
systemctl start instabox-lease.service   # 立刻验一次
```

**换 InstaBox key 时必须同时改三处**，否则就是 11-27 那种「看起来在跑、其实每分钟 401」：

1. 本机 `C:\Users\理想与现实\.instabox_key`（仅运维用，不进仓库）；
2. 主库 `/etc/geohot/instabox-token`（`instabox-hold` 用）；
3. hcss 与阿里云 `/opt/geohot-exec/instabox.key`（lease 用）。

体检：`systemctl status geohot-instabox-hold` 的日志里应出现 `{"event":"active",...,"note":"executor=in-pool ..."}`；
`journalctl -u instabox-lease.service -n 3` 应出现 `lease ok ... state=running worker=active tunnel=active`。

## 首装（换一台新沙箱时照这个顺序）

```bash
# 机器上：把源码、运行时、env、两个单元准备好，然后把「重启后要用的那份」放进 /data
git clone --depth=1 https://github.com/xxc2007/GeoHot.git /data/geohot-src/geohot
# Node 需要 >=24.11：装到 /data/node24（不要用系统自带的 22）
sudo install -d -m 755 /opt/geohot-exec
sudo install -m 600 -o root -g root /data/ib.env /opt/geohot-exec/.env
sudo install -d -m 755 /data/geohot-boot
sudo cp /opt/geohot-exec/.env /data/geohot-boot/exec.env
sudo cp /etc/systemd/system/geohot-exec-*.service /data/geohot-boot/
sudo install -m 700 deploy/geohot/instabox/bootstrap.sh /data/geohot-boot/bootstrap.sh
sudo /data/geohot-boot/bootstrap.sh     # 幂等，跑一次就装好
```

注意两处坑（都踩过）：

- `DATABASE_URL` 的口令要用模板里那串，写成 `geohot:geohot` 会 `password authentication failed`；
- `sudo tee` 会因为 stdin 被 sudo 吃掉而写出空文件，先 `cat > /data/ib.env` 再 `sudo install`。

## 面板

心跳带 `GEOHOT_HEARTBEAT_LABEL=InstaBox`，后台「服务器」页按 `InstaBox` + 机器 id 显示，与杭州/武汉/华为云广州同构。
