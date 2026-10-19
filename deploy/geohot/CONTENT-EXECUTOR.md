# 受控拆分 worker：服务器调度与本机内容执行

本功能不自动部署或接管。默认 WORKER_ROLE=all 保留原行为；一个数据库只运行一个调度 owner 和一个内容执行 owner。翻译仍由服务器原 cron 执行，模型池、service、receipt、预算与评分规则不变。

| WORKER_ROLE | 注册内容 | 心跳 |
| --- | --- | --- |
| all（默认） | 原分析、按COLLECT_ENABLED注册的采集/抽取、其他consumer、全部cron | heartbeat.worker |
| coordinator | 全部原cron与其他consumer；COLLECT开时注册来源采集，始终不注册analysis/extract | heartbeat.worker |
| content-executor | 仅content.analyze与content.extract-body，无来源采集/cron/media/notify/translate | heartbeat.content-executor |

角色误拼拒启。执行器关闭pg-boss内部schedule/supervise/migrate/createSchema，只检查已有schema版本；server保留维护/迁移owner。两端同release、行业配置和提示词；不删队列、不重建任务。

## 环境与资源

安全launcher只在内存传入最少所需环境，不复制服务器完整.env，不在命令行/日志打印DSN或token，不加载开发.env.pipeline。SSH仅loopback映射PG与原模型桥，映射前核对目标和端口，避免连到开发库或stub。直接模型仍须各自合法路由/授权。

- WORKER_ROLE=content-executor，ANALYZE_CONCURRENCY=4，EXTRACT_CONCURRENCY=1或2起步（执行器默认4/2，all仍6/4）。
- DATABASE_POOL_MAX=2、PGBOSS_POOL_MAX=2（亦可1），两个独立池共3–4连接。计算服务器所有进程/运维预留后再分配。两项严格要求正整数，错误值拒启；缺省业务10、pg-boss4。
- COLLECT_ENABLED=true必须显式：保留waitsForPage语义，不会在该角色启RSS/来源consumer。server coordinator可保持false暂停实时来源。
- MODEL_CALLS_ENABLED必须显式：live为true，隔离localhost staging可false或stub。代码默认开阀，不依赖默认。
- 正式SITE_URL、TZ=Asia/Shanghai、准确AIHOT_RELEASE、本机独立AIHOT_DATA_DIR图片缓存；其他集成阀关闭，不传无关凭据。正式环境不能开ALLOW_PRIVATE_NETWORK_FETCH，原SSRF和付费预算保护保留。

JINA_BODY_FALLBACK默认开启；原页Readability成功不调Jina，否则可能付费，仍走原receipt与service限额。确认已有授权和预算，不能因迁移开启新服务。X Article另有SocialData路径。Crossref有效摘要且body_status=ok仍按原摘要依据判断；标题-only pending可抓页先抽取。不能以只对selected抽取替代标题材料的前置正文核对。

## Staging与受控切换

1. 先在隔离_test PG、localhost stub检验角色注册、schema缺失拒启、预算/在飞等待不耗三次真实失败、Jina unknown按extract恢复、IPC排空。比对原净分析/完整译文、各service用量/429/unknown、PG锁等待、RSS/swap in-out、读者延迟。
2. 使用原255秒窗口排空server在飞请求，唯一原worker切为coordinator（TimeoutStopSec=285保留）。确认原cron/翻译和其他consumer正常，无server分析/抽取领取，再开本机执行器。
3. 等IPC READY并读回专用heartbeat、同数据库/release/模型路由。初迁分析4/抽取1–2，不提高预算、不迁翻译；实测稳定后才逐档调并发。
4. PC停机先停止新领取，等已发付费请求及落库完成，最后关SSH。硬离线保留active作业；分析1500秒/抽取300秒超时由server supervisor正常回收。不改active为created、不清unknown、不改attemptTag重买。ops.recover仍仅自动放行一次，后续需核对。
5. 回滚先确认PC已停并禁自动重启，再server恢复all；若RSS仍需暂停，可受控启动server独立content-executor小进程（分析1/抽取1，明确专用生命周期），原coordinator保持COLLECTfalse。两种回退择一，PC恢复不自动抢回，先排空fallback再交接。

heartbeat过期仅提示不可用，不能证明PC进程死了。没有lease/fencing的本阶段不自动夺取；网络分区、关窗和系统睡眠不能承诺无缝切换。两执行器共用heartbeat.content-executor，受控交接前必须排空旧owner；不允许靠新心跳覆盖旧进程当停机证明。

## Windows IPC停机

launcher通过Node fork/spawn私有IPC通道运行，显式execArgv:[]且不继承不受控NODE_OPTIONS，不开放HTTP管理端口。完成角色注册、启动心跳并安装停机handler后，主程序发：

    { type: 'geohot:ready', role: 'content-executor' }

心跳写入异步，READY不代替读回heartbeat/目标库校验。仅执行器接受精确消息：

    { type: 'geohot:shutdown' }

其他消息或额外字段忽略；重复请求幂等。走同SIGINT/SIGTERM的shutdown：停止领取、abort后续分析步骤，最多255秒等在飞调用，关队列与业务池后exit0。launcher等exit再关SSH，总窗口至少285秒。Windows child.kill('SIGTERM')可能直接杀进程，不可替代此入口；硬杀须按故障保留未知回执。

服务器PG、桥、翻译与其他consumer仍在原机；WAN SQL往返可能延长预算锁。进程启动/本机测试通过不能当作生产已提速或历史已排空。
