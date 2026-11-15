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

## 保活：主库每 60 秒看一次，缺什么补什么

`deploy/geohot/bin/instabox-hold.mjs` + `deploy/geohot/systemd/geohot-instabox-hold.service`（装在**主库**上，不依赖任何人的电脑）：

1. 读 `GET /v1/machines/<id>`；`state !== "running"` 就 `POST /wake`；
2. 醒着时每 10 分钟 `POST /exec` 跑一条极短命令 —— 这是平台能看到的「有人在用」，顺手确认执行器还在岗；
3. 执行器不在岗（或根盘被重置过）就重放 `/data/geohot-boot/bootstrap.sh`。

token 只从 `/etc/geohot/instabox-token`（600 root）读，日志里只打状态，不打 key。

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
