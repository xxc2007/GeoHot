# 本机有限正文抽取辅助

这是机会式协同的首阶段，默认只读，最多单轮运行十分钟。服务器保持 `WORKER_ROLE=all`；本机关机不需要改变服务器角色。尚未启用自动任务、睡眠唤醒或本机模型分析，不能把本工具描述成已完成全天无人值守协同。

## 边界

- `extraction-executor` 只领取公开页面正文抽取，一个槽、业务数据库池一个连接、pg-boss 池一个连接；不注册分析、采集定时器、翻译、媒体或期刊任务，不迁移数据库。
- 显式关闭模型调用与 Jina，原子认领时排除 X/SocialData 和 `serverOnly` 任务。无模型、设备、后台登录或集成凭据传入本机子进程。数据库连接凭据只通过已有 SSH 授权读入内存，不落盘、不输出。
- 本机抽取失败不能把文章从 pending 降级成 unconfirmed，不能消耗文章失败次数或提前分析。正常事务交回 server-only 抽取任务；服务器仍有原有兜底机会。正文成功后仍走原版分析、完整译文、媒体及统一公开门禁，本工具不直接发布。
- 每次认领都检查最多二十秒有效的 supervisor 证据。AC 电源、本机至少 2 GiB 空闲、服务器至少 96 MiB 可用、memory full PSI <10、I/O full PSI <30、API 健康、服务器 all、相同源码、无维护 owner、无 R115 门禁须同时成立。无法采样时关闭新认领；首轮持续健康一分钟才启动。
- 保留原子 SKIP LOCKED、作业租约、队列优先级和普通重试机制，不清理未知回执，不改评分或全文许可。只共享现有数据库和队列。

## 使用

先将本批经审查合并的源码及 `deploy/geohot/probe-extraction-assist.py` 同步到服务器，再从干净、匹配的本机发布目录运行。私有 JSON 放在仓库外：

```json
{
  "host": "operator@server.example",
  "hostKeyAlias": "server.example",
  "identityFile": "C:/private/server.pem",
  "localPort": 26532,
  "stateDirectory": "C:/private/geohot-assist-state"
}
```

```powershell
# 默认只读：没有隧道、子 worker 或数据库写入
node scripts/workstation-extraction-assist.ts --config C:/private/geohot-assist.json
# 最多十分钟的人工受控试运行；不会安装计划任务或自动复工
node scripts/workstation-extraction-assist.ts --config C:/private/geohot-assist.json --run-seconds 600
```

试运行期间不能部署源码、迁移数据库或更改模型/网关配置。先正常停止辅助程序，核验子进程退出、隧道关闭及队列交回，再维护。不能以 SSH 断开、PG 无连接或心跳过期单独证明任务排空。自动化维护 fence 尚须独立实现和演练，因此不能将有限工具改成开机自启来绕过这个前提。

失去电源、网络、资源、版本或维护许可后，撤销租约并通过 IPC 停止新领取，保留隧道等待在途操作收尾。父进程退出触发子进程 IPC disconnect；睡眠期间租约自行过期。超时/清理异常报告 isolated 并保留实例锁，由操作员核查，禁止自动偷锁或清理队列。手工检查旧锁前核验其 PID 与实际命令、在途作业和连接，不能仅凭 PID 不存在推断所有工作完成。

`handled` 是本机完成回调数，`fullBodiesStored` 才是本机实际存入新正文数，`handedBack` 是交给服务器兜底数；均不等于完整文章发布数。提速验收还须核对当前版 analyses、完整 translations、统一公开门禁和真实页面，不能用回执数、缓存预热数或服务 active 代替。
