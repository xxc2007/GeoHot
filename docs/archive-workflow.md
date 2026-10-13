# 历史资料回填与同步出刊

入口是 `deploy/geohot/archive-cycle.sh`。脚本默认按北京时间从 2026-01-01 查到执行当天，也可通过 `GEOHOT_ARCHIVE_FROM/TO` 固定目标范围，使用已有信源、归档游标、队列、评分与预算机制。默认只读计划；写入必须显式设置 `GEOHOT_ARCHIVE_APPLY=1`。脚本不会启动 worker、修改信源或改写筛选门槛，也不绕过模型回执。

本次长程生产任务已在 `/etc/geohot/archive-cycle.conf` 固定 `2026-01-01..2026-10-10`，防止跨午夜后新闻断点的日期范围键变化而重扫全年。常规实时采集继续运行。最终轮若跨到下一日期，需单独补齐新增日期并记录与固定快照的联合覆盖，再按最终目标范围刷新刊物；不能将旧快照冒称最终验收当天的“到现在”。

## 每轮顺序

1. 用 `flock` 锁定状态目录，同一状态目录只允许一个周期运行；定时与手工执行要使用相同目录。
2. `archive-status.ts` 保存运行前的月度观察账本，包含处理积压、失败、公开投影、已出刊和未配置历史入口的信源。
3. 从数据库读取启用且具备历史入口的信源，与目标月份形成切片；已结束月份的 `done` 切片跳过，当前月始终可复查。`next-slice` 保存轮转索引，每轮最多选择六个切片（可配置 1–12），在采集前推进索引，失败切片也不阻塞后部信源。每片分别以 `--source` 和单月范围运行 `backfill-archive.ts`，沿用 `archive_ingest` 游标。每片新增配额为 `floor(本轮总限额 / 已选切片数)`，默认总限额 100 条、每信源每月最多 30 条，分页间隔 1200 毫秒。`slices.json` 保存选择与配额证据；已有材料判重，不把有限抓取量解释成完整覆盖。
4. 已有单实例 worker 继续处理材料。脚本立即运行 `backfill-papers.ts`，只为已经 settled 且窗口关闭的日报、周报、月报出刊；未完成的日子等下轮。每轮默认跳过已有刊期，不传 `--force`。
5. 从 `industry/news-archives.json` 中与数据库启用信源求交集，用 `next-news` 每轮轮转一个新闻档案入口，最多五页、100 条候选，间隔 1200 毫秒；与论文切片共用锁和 40 分钟总期限。新闻与论文分别记账，一轮候选上限合计 200，实际付费分析仍由现有预算闸门限制。
6. 单个切片失败后继续其他切片并尝试补刊，整轮保留非零退出码。保存运行后账本、每个阶段的退出码以及最终结果。没有材料的月份、无历史入口的信源和空精选期均不代表完整检索。

归档入口当前覆盖的是代码支持的历史信源；新增普通 RSS 并不自动得到全年历史。更广的新闻资料需要为信源增加可验证的历史入口，或由另一个经过来源、日期与许可核验的摄入流程导入，随后仍走同一筛选队列。

## 运行与限制

在默认服务器目录中，先做只读计划：

```bash
sudo -u geohot /bin/bash /opt/geohot/app/deploy/geohot/archive-cycle.sh
```

确认目标环境、现有 worker 正常以及预算后执行一轮写入：

```bash
sudo -u geohot env GEOHOT_ARCHIVE_APPLY=1 /bin/bash /opt/geohot/app/deploy/geohot/archive-cycle.sh
```

环境文件由 Node 主进程用 `--env-file` 加载，数据库确认只传 `--database-url-env=DATABASE_URL`，连接地址不进入命令行。不要 `source .env`、不要开启 `set -x`，也不要把私有阶段日志复制到公开报告。生产默认只读 `.env`；本机需要叠加一次性环境时，设置 `GEOHOT_ARCHIVE_ENV_OVERLAY` 指向该文件，并保持基础 `.env` 的安全阀策略。

每个阶段默认最多 600 秒，超时先发 TERM，30 秒后才 KILL。整个周期共享 40 分钟时限，最后一分钟留给结束账本，预算耗尽的后续阶段以 124 记录；systemd 另设 45 分钟总上限、320 MB 内存与 40% CPU。强制终止可能留下一页重读或未完成状态，下轮依靠归档游标和材料判重恢复——**但这不适用于被掐断的付费调用**：那条请求的回执停在 pending，半小时后被 `ops.recover` 判成 unknown 并自动放行一次，扔掉的回答要靠下一轮重问。出刊阶段因此读 `GEOHOT_PHASE_SECONDS`（由 `run_phase` 导出）：剩余时间放不下一次完整调用（240 秒上限加余量）时自己正常收尾（退出码 0），不再留 124。采集不是付费模型处理预算；worker 的预算熔断仍是唯一付费入口。

可配置 `GEOHOT_APP_ROOT`、`GEOHOT_NODE`、`GEOHOT_ENV_FILE`、`GEOHOT_ARCHIVE_STATE_DIR`、`GEOHOT_ARCHIVE_FROM`、`GEOHOT_ARCHIVE_TO`、`GEOHOT_ARCHIVE_SOURCE`（逗号分隔）、`GEOHOT_ARCHIVE_MAX_ITEMS`、`GEOHOT_ARCHIVE_PER_MONTH`、`GEOHOT_ARCHIVE_PHASE_SECONDS`、`GEOHOT_ARCHIVE_SLICES`。数量和阶段时限有硬上限；总周期时限固定。自定义日期须有效且有序，切片选择器和下层 CLI 会再次校验。

状态文件默认位于 `.data/archive-cycle/<UTC时间>-<进程号>/`，权限由 `umask 077` 限制，`latest` 记录最后一轮目录。查看 `result.txt`、`exits.tsv`、前后 `status-*.json` 和 `papers.json`。退出码 124 表示阶段超时；137 可能是强制终止，需结合 systemd 日志确认。私有日志按阶段保存在同一目录。磁盘清理前先将月度账本和结果归入迁移备份；不要删数据库游标、模型回执或既有刊期。

## 定时部署模板

`deploy/geohot/systemd/geohot-archive.service` 和 `.timer` 是待安装模板，此文档与脚本本身不安装、不启用服务。默认安装目录以 `/opt/geohot/app` 为准；改目录时应同时更新 WorkingDirectory、ExecStart、ConditionPathExists 与 ReadWritePaths。安装前先确保 `.data` 存在且 geohot 用户可写，检查 Node 路径和以下命令：

```bash
bash -n deploy/geohot/archive-cycle.sh
systemd-analyze verify deploy/geohot/systemd/geohot-archive.service deploy/geohot/systemd/geohot-archive.timer
```

将模板安装到 `/etc/systemd/system/`，`daemon-reload` 后先手工运行一次 service 并检查账本。写入模式通过管理员维护的 `/etc/geohot/archive-cycle.conf` 配置 `GEOHOT_ARCHIVE_APPLY=1`；文件只保存运行选项，不重复数据库与模型密钥。模板定时器每十五分钟一次，增加最多一分钟随机延迟，补跑错过的周期；同一个 oneshot 服务运行中不会再启动另一实例，手工启动同状态目录也受 flock 限制。确认后启用 timer，并用 `systemctl status geohot-archive.service`、`systemctl list-timers geohot-archive.timer`、`journalctl -u geohot-archive.service` 观察成功、超时和失败。

## 最终刊期重排与验收

日常周期不重排已有刊期。历史资料全部进入预定范围且积压已处理之后，操作者显式设置 `FINAL_REFRESH=1` 执行最终轮，配合 `GEOHOT_ARCHIVE_APPLY=1` 才会刷新。不要将 FINAL_REFRESH 写入长期 timer 配置。后补较早日报可能影响后续期去重，最终轮需覆盖整个目标日期范围；缺材料或未 settled 的月份不能宣称已经完整出刊。

最终验收要比较月度前后账本与来源覆盖，检查各类刊期、选材日期、公开 API/RSS/MCP、实际浏览器与移动端，并确认 GitHub、服务器代码与构建版本一致。使用 `deploy/geohot/portable-backup.sh` 准备迁移包，依据它的运行选项与恢复说明验证；内容数据库、归档游标、刊期、回执、上传文件和必要私密配置应作为独立迁移备份保存。本脚本账本只是观察证据，不替代数据库备份或恢复测试。
