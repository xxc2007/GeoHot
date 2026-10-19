# 来源注册容量与未知投递

迁移 `0070_source_registry_policy.sql` 创建可选的数据库容量门禁，默认 `target_enabled=NULL`，兼容既有的来源注册行为。安装时锁住 sources 写入以准确初始化计数；安排短维护窗口并先备份。迁移本身不写入行业清单、不增删现有来源、不启停任何来源。先迁移，再启动依赖新表的后端和脚本。

目标是 enabled 来源上限，而非注册表总行数。注册数包含暂停候选，不能用清单覆盖数据库现有来源、游标或状态。启用前当场查验总数、启用数、计数器一致性和目标；不要把某次盘点的数字当作永久配置。

在明确设置 DATABASE_URL 的受控终端中，先运行只读预览（以下数字只是调用示例，必须替换为实际审核结果）：

```sh
node scripts/source-registry-policy.ts --target=666 --expected-enabled=666 --reason="已审核现有来源容量"
```

预览不修改数据库。确认数据库目标与实际计数后，同一命令追加 `--apply --database-url-env=DATABASE_URL` 才执行；`--target=off` 以同样方式关闭策略。激活会验证真实 enabled 数与计数器一致，拒绝压低至当前数量以下，不会自动批量暂停来源。策略修改写 audit_log。生产激活属于单独的运维操作，本补丁没有执行它。

启用策略后：

- INSERT、DELETE、UPDATE OF enabled 由数据库触发器先锁唯一策略行再改变来源行，计数超额整个事务回滚。普通游标、健康状态写入不拿容量锁。直接数据库超级用户禁用触发器、删除策略行或手改计数器不属于此门禁能防御的权限边界。
- 管理员创建来源默认保存为 disabled 候选。显式 enabled 仍受数据库上限约束。常规来源写入口保持原有接口；紧急暂停须提供原因，可暂时低于目标，不能把缺口显示成完整覆盖。
- `POST /api/admin/sources/replace` 使用原有管理员会话与 CSRF 校验。请求包含 `disable`、`enable` 两组等长且互不重叠的 `{id,version}`、`expectedPolicyVersion`、`reason`、`evidence`。来源 version 是当前 updated_at 的 ISO 字符串。候选必须已存在且暂停；先停旧来源、再启新来源，最终真实 enabled 数与计数器都须等于目标。来源变动、审核记录与重发布任务在同一事务提交或全部回滚。
- policy_version 表示策略配置版本；来源版本防止过期审核覆盖新状态。互不相交的置换可按策略锁顺序提交，涉及相同来源的旧请求被拒绝。若紧急暂停留下缺口，等量置换不能顺便填平它，应先独立审核缺口恢复方案。
- 未知来源的 webhook 投递返回 HTTP 202、`sourceStatus=pending_review` 和 submissionId；created/revised 均为零。证据进入私有 ingest_source_submissions，单次最多 512 KiB，按来源、客户端和规范化 payload 哈希幂等。不会注册来源、创建文章或排模型任务。202 表示保留待审证据，不代表内容已经发布。新证据的总量仍需运维留存策略，本补丁未实现总库配额或自动清理。
- 已暂停来源继续拒绝投递。`seed-curated` 的本机与 HTTP 路径同样识别隔离结果，不报告假创建；managed 模式默认保留未知证据，`--allow-unknown-source` 不能绕过门禁，`--enforce-source` 仍可显式拒绝未知项。
- seed 只补缺失的 disabled 候选，保留既有来源状态；set-source-state 拒绝在 managed 模式按清单自动更改 enabled，使用审核后的管理操作。

私有证据不能通过公开 API 或模型提示词读取。数据库备份应包含新表；本补丁尚未提供待审队列 UI、接受/拒绝/重放工具或自动来源质量评审。需要先审核来源及内容、注册候选并完成容量置换，再显式重新投递；不能仅修改 submission.status 就声称文章已入库。

验证使用 localhost 专属临时数据库，覆盖真实 671/666 夹具、三个直接 SQL 并发容量竞争、置换审核/任务失败回滚、并行互不相交置换、未知证据幂等、HTTP 202 和实际 seed/curated/set-state CLI。它不证明生产实时来源质量、历史覆盖已完整或全部网站功能已核验。
