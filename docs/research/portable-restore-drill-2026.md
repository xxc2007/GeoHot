# 私有迁移包隔离恢复演练（2026-10-10）

执行者：第 15 个检查 agent。完成时间：2026-10-10 17:45 Asia/Shanghai。

## 结论与范围

既有私有迁移包的 PostgreSQL 数据可以恢复：在生产服务器另建唯一测试库 `geohot_a15_restore_test`，以单线程 `pg_restore --exit-on-error --no-owner --no-acl` 完成真实恢复，逐表比对备份 COPY 数据行数及序列状态，全部一致。随后删除该唯一测试库与本次私有解压目录，原备份保留，生产库和四个常驻服务均正常。

演练对象是 `geohot-20261010T092931Z-portable.tgz`，大小 197803907 bytes、权限 0600。这是本轮信息源扩充完成前的快照；它的内容计数不能作为最终网站计数，也不能代替最终版本备份验收。包内包含私密环境配置，必须存放于服务器非公开目录，禁止进入 GitHub、公开下载目录或报告附件。

本次没有启动第二套 API/web/worker/brain，没有连接模型或采集服务，没有安装额外软件；因此结论覆盖数据恢复和包内必要源码检查，不覆盖另一台主机上的依赖安装、前端重建、域名/TLS、代理配置与全栈启动。

## 已执行检查

- 外层 `.sha256` 校验通过；包内 `SHA256SUMS` 所列全部 14 个文件校验通过。
- 外层 tar 成员无绝对路径、上级目录穿越及软硬链接，解压到私有 0700 目录。
- 数据恢复退出码 0，未使用并行恢复。整个演练只操作 `geohot_a15_restore_test`。
- 从 `pg_restore --data-only` 导出的 SQL 逐个解析 COPY 数据块，以 `SELECT count(*) FROM ONLY <table>` 对照实际恢复结果，避免分区/继承重复计数。
- 72 个有 COPY 数据的表，总计 769090 行，逐表不一致数 0。
- 16 个序列的 `last_value` 和 `is_called` 与备份 `setval` 完全一致。
- 恢复库包含 53 条迁移记录，源码包包含 53 个迁移 SQL；未验证外键 0、无效索引 0；所需 `pg_trgm` 与 `plpgsql` 扩展存在。
- 源码包包含 `package.json`、`package-lock.json`、私密 `.env` 和部署验收脚本。还包含持久数据归档、systemd 定义、nginx 站点配置和运行时版本记录。

主要恢复内容如下，仅描述该旧快照：

| 对象 | 恢复数量/范围 |
| --- | --- |
| 原始材料 articles | 19246 |
| 原文修订 article_revisions | 33151 |
| 分析 analyses | 13439 |
| 公开投影 publications | 12399 |
| 信源 sources | 300；启用 279 |
| 日报 | 16；2026-09-25 至 2026-10-10 |
| 周报 | 2；2026-W39 至 2026-W40 |
| 月报 | 1；2026-09 |
| 历史采集状态 archive_ingest | 906 |
| 回执 receipts / receipt_attempts | 75836 / 80390 |
| 队列公共任务 pgboss.job_common | 180126 |

恢复库测得约 516 MB。逐表完整计数证据另存本轮私有过程目录，仅包含表名与计数，不包含材料正文、凭据或个人会话内容。

## 脚本审阅发现与最终备份要求

1. 审阅时 `portable-backup.sh` 默认目的地为 `/opt/geohot/backups`，实际服务账户对父目录无写权限。当前成功调用使用 `GEOHOT_BACKUP_ROOT=/opt/geohot/backups/migration`。应使最终说明/默认值与部署权限一致。
2. 审阅时包未包含 `/etc/geohot/archive-cycle.conf`。`systemctl cat` 记录 `EnvironmentFile` 路径，不能保留文件内容；该配置决定历史轮转是否真正采集，以及配额。已向主 agent 回报，最终包需包含受限运行配置并给出恢复位置。
3. 源码包有意不含 `node_modules` 和 web build。目标服务器须使用记录的 Node/PostgreSQL 版本，执行 `npm ci`、迁移检查和与目标路径一致的 `BASE_PATH` 前端构建，再做 HTTP/浏览器验收。
4. 数据库包含生产队列、回执、预算与会话状态；迁移恢复后应先调整目标环境配置，确认生产阀门和域名/凭据，再启动服务。不能把本次成功恢复直接当成可同时运行第二套采集/模型 worker 的授权。
5. 最终轮扩充完成后应重新生成备份，核对最终代码版本、最新材料/报告计数、受限配置和校验和。本次旧快照演练不能证明后续新包完整。

## 清理与生产保护结果

实际删除的数据库只有 `geohot_a15_restore_test`，删除后同名库数量为 0，生产 `geohot` 库仍存在。实际递归删除的目录只有经过 `realpath` 精确核对的 `/opt/geohot/backups/migration/a15-restore-private`，删除后目录不存在。原 0600 迁移包保留。

结束时 `geohot-api`、`geohot-web`、`geohot-worker`、`geohot-brain` 均为 `active`。未改生产源码、共享运行配置或邻居站点，也未公开私有归档。

## 第二次真实演练：扩充后的中间包

同日对 `geohot-20261010T144556Z-portable.tgz` 再次执行真实恢复，而非沿用第一包的结果。新包 225966209 bytes、0600，外层 SHA256 及内部 15 项 manifest 校验全部通过；此包仍为中间快照，不能称为任务最终备份。

第二次仅新建 `geohot_a15_restore_v2_test`，解压目录为私有 0700 的 `a15-restore-private-v2`，未启动任何新服务或 worker。恢复单线程、退出码 0；**72 表共 840360 行逐表与该包自身 COPY 数据完全一致**，没有把持续变化的生产计数当成备份验收目标。**16 个序列状态完全一致**；53 条迁移记录、53 个源码迁移 SQL；未验证外键 0、无效索引 0，`pg_trgm` 存在。恢复库约 686 MB。

| 第二包快照对象 | 实际恢复结果 |
| --- | --- |
| articles | 23485 |
| article_revisions | 39231 |
| analyses | 14216 |
| publications | 13156 |
| sources | 311；启用 289 |
| reports | 19：日报 16、周报 2、月报 1 |
| receipts / receipt_attempts | 80350 / 85359 |
| pgboss.job_common | 219653 |

第二包实际包含 `archive-cycle.conf`，`RESTORE.txt` 包含恢复该配置的指引。当前备份脚本默认目的地已经改为服务账户可写的迁移目录；前轮发现的两项问题已在本轮代码/归档中修复。源码包包含锁文件、53 个迁移 SQL、`backfill-news.ts` 和 `.env`；只检查环境文件存在，未读取或输出凭据。

第二次逐表证据与序列证据保存在本轮私有过程目录的 `a15-restore-v2-evidence.json`、`a15-restore-v2-sequences.json`。结束时唯一 v2 测试库已删除、同名库数量 0，精确核对路径后仅删除本次 v2 解压目录，原新包保留；生产数据库存在，四个常驻服务仍全部 `active`。

第二次覆盖最新中间包的数据与必要文件完整性。依赖重装、前端构建、另一台主机的网络/TLS/权限及全栈启动仍未实测；后续最终代码与内容若继续变化，仍需最终新包验收。

## 第三次真实演练：release 964a2f2 与共享归档锁的新包

执行者：第 18 个独立检查 agent。演练对象为 `geohot-20261010T153055Z-portable.tgz`，236158562 bytes、0600。这仍是中间快照，不能称为长程任务的最终备份或最终内容结果。

资源检查时服务器可用内存约 209 MB、swap 余约 1.6 GB、磁盘余 31 GB、load 0.64。因此单线程 `pg_restore --jobs=1 --exit-on-error --no-owner --no-acl` 配合 nice 15 / idle I/O 执行。仅新建唯一 `geohot_a18_restore_153055_test` 数据库和 0700 的 `a18-restore-private-153055` 解包目录；未启动第二套服务、worker、采集或模型请求，未停生产。

外层 SHA256 校验通过，tar 成员路径无绝对路径、父目录穿越或软硬链接；内部 manifest 15 项全部通过。application 归档中的七个关键文件逐字节 SHA256 与本地 Git `964a2f2` 的对应 blob 完全一致：receipts、llm、models、analyze、backfill-news、backfill-archive 和 portable-backup，确认含预算候选选路、评分拒绝者归属、新闻部分页恢复、期刊队列关闭及共享备份锁修复。只检查 `.env` 归档成员存在及权限 0600，未读取或输出内容。源码含 53 个迁移 SQL，`archive-cycle.conf` 与 RESTORE 中的恢复配置指引存在。

真正恢复退出码为 0。随后以该包本身 `pg_restore --data-only` 导出的 COPY 数据为比较目标，用 `SELECT count(*) FROM ONLY` 逐表核对，**72 表共 854621 行全部一致，不一致数 0**。**16 个序列 last_value/is_called 与该包 setval 全部一致**；53 条迁移名称与源码文件名称逐条匹配；未验证外键 0、无效索引 0，`pg_trgm` 与 `plpgsql` 存在。恢复数据库大小 747189939 bytes（约 713 MiB）。未拿持续变化的生产计数当作备份验收目标。

| 第三包快照对象 | 真实恢复结果 |
| --- | --- |
| articles | 23609 |
| article_revisions | 41259 |
| analyses | 14367 |
| publications | 13306 |
| sources | 311；启用 289 |
| receipts / receipt_attempts | 81110 / 86147 |
| pgboss.job_common | 228892 |
| archive_ingest | 906 |
| reports | 19：日报 16（2026-09-25→2026-10-10）、周报 2（W39→W40）、月报 1（2026-09） |

逐表及结构检查证据已保存到本轮私有过程目录 `a18-restore-v3-evidence.json`；演练命令保留为 `a18-drill-v3-command.txt`，均不包含环境凭据或数据库材料正文。外层源备份保留在私有迁移目录，未上传到公开仓库。

清理前逐字验证目录 realpath 正好为 `/opt/geohot/backups/migration/a18-restore-private-153055`，并验证父目录为私有迁移根且自身不是符号链接；只删除该目录及该唯一测试库。删除后测试库同名数量 0，生产 `geohot` 库数量 1，原包仍为 0600 / 236158562 bytes，`geohot-api`、`geohot-web`、`geohot-worker`、`geohot-brain` 全部 active。演练结束时可用内存约 335 MB，未触发停止生产服务。

此次覆盖第三包的数据恢复、序列/结构完整性、必要私有配置与七项关键 release 源码一致性。没有在另一台主机重新安装依赖、重建前端、设置域名/TLS或启动完整栈；也未证明该中间快照包含后续新内容。最终轮若继续修改代码或内容，仍需生成并验收最终新包。
