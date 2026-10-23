# GEOHOT 收尾审查与恢复记录

这是有时间边界的检查记录，不是“全站已完成”的声明。现场为 2026-10-23，北京时间。

## 发现与修复范围

- GitHub `0faa207` 的后端 CI 为 699/753 通过、54 失败。长正文实现遗留在 `codex/translation-long-body-0076`，而主分支已包含对应测试；本分支合并该实现，保留更严格的短尾 DOI、URL、数字与 DOM 回归。
- 更新日志在本次真实 Chrome 与 HTTP 读回返回 200；不能据截图认定此刻仍持续报 500。首屏慢与失败仍需分开检查。
- 普通读者路由此前没有 Nginx 共享缓存；新增两份 include，只允许无 Cookie、无 Authorization 的匿名 GET/HEAD 白名单。遵守源站 Cache-Control、Set-Cookie、Vary 与 X-Accel-Expires，不在故障或过期时提供陈旧内容；MCP、后台和反馈写入不缓存。
- OG 卡片/海报共用单槽冷渲染门禁；已有磁盘缓存与同键合并保留，超量返回不缓存的 429，避免原生图片任务挤占 API。
- 部署包使用随机私有上传目录、root 私有暂存和完整 SHA-256；不再从共享 `/tmp` 二次选择“最新文件”。
- 付费请求第一次发生不确定超时即抛出带 receipt ID 的 `ReceiptUnknownError`，避免翻译立即拆批或换 retry 身份重购。旧成功、pending、unknown 身份均保留，兼容推理参数改变前的已购回答。
- 模型思考强度保留 `max`；按最新指令保留其他模型原参数，仅移除国内 3066 的 `workbuddy-cn-deepseek-flash`。Step 的现有 cap 在长推理链下可能晚于步骤时钟，保留风险记录，不擅自调参。健康检查 SQL 使用 2 秒 statement timeout、250ms lock timeout、关闭查询内并行；熔断与账本仍按原策略执行。
- 补齐干净安装缺少的 `workbuddy-ai` 预算行（存在则不改），为生产已用预算覆盖索引、健康查询和日历增加增量迁移。
- 生产 worker 的停止窗口实际为 25/60 秒，而代码排空窗口为 255 秒。现场 drop-in 修正为 300 秒；不能用服务 active 替代真实产出验收。
- 生产依赖检查命中 MCP Server、Fastify、sanitize-html 公告；分别更新至 2.3.1、5.12.7、2.18.1。MCP 同时配置 1000 个输入元素与 64KiB 解析上限，升级本身不能替代这些限制。

## 生产现场边界

09:57 左右首次只读快照：964 登记、666 启用；历史新材料 413 条；7—9 月 10 个切片 pending；十月 125 个滚动切片 pending；事件归组 created 约 4459。这些计数不是当前永久值。

生产源文件、数据库迁移账本与 Git 主分支存在漂移，0070—0073 尚未安装，旧临时 OG upstream 3436 已不可连接。发布需要补齐数据库兼容迁移、恢复 OG 正式服务并读回。

翻译统计必须排除实际已为中文、无外文正文、无可翻译文本的正常跳过；failed/partial/旧 60000 字符截断需分别处理。不得删除未知回执、放松门槛或盲目清零 attempts 来制造完成。

10 月 21 日实时入库为 0，20—22 日有明显暂停期。应按真实源发布时间与可访问归档补采；无历史入口的源不能声称穷尽恢复。

## 验证

- 整合与依赖更新前：754 个后端测试通过；58 个网页测试通过；全部类型检查与 `/geohot` 构建通过。
- 长正文与翻译基础设施/selector：33 个回归通过；新增“第一次 unknown 不拆批重购”与旧 Step 参数回收验证继续保留。
- 最新依赖更新后，生产依赖 `npm audit --omit=dev` 为 0；此结果不是未知漏洞不存在的证明。
- 一次空库本地 smoke 全通过，包括前缀、MCP 初始化和跨出口一致性；空库验证不证明线上历史刊物与全部内容完整。
- 真实 Chrome 可打开更新日志、全部动态与 AIHOT；本次不能获得可比较的 AIHOT HTTP 测速（公共命令行请求被其返回 403），不能将 403 用作更快的证据。

## 缓存安装与撤回

将 `deploy/geohot/public-cache.conf` 放入 Nginx `http {}` 的 conf.d，主 GEOHOT proxy location 内 include `public-cache-location.conf`。仅更改 GEOHOT 两个主 location；先 `nginx -t`，再 reload，并验证 MISS→HIT、Cookie/Authorization BYPASS、错误 no-store、邻站文件不变。不得忽略源站缓存头或设置过期 serve-stale。

现场保存了改动前 vhost 的私有副本与 SHA，可按当前整体 SHA 做 CAS 撤回；不能用旧整份配置覆盖他人后续修改。缓存清理在验收后仅清理本次暂存，不清 PostgreSQL shared buffers、系统页缓存、账本或仍有用途的热缓存。

## 12:45 后续读回

- 生产 smoke 的全部检查通过：页面、RSS、MCP 初始化、前缀链接与跨出口一致性；294 期索引与 v1 列表一致。读者中文标题采样通过。此检查不写反馈、后台或生产样例。
- 国内 DeepSeek 从 12 个环境变量精确移除，运行进程读回均为零引用；其余成员顺序和重复权重未改变。模型 settings 覆盖表为空。两条国际 DeepSeek 注册项保留。
- 两个 worker 在 300 秒停止窗口内正常退出。恢复后 coordinator 与 content-executor 角色正确；executor 使用分析 4、抽取 2、翻译 3、数据库池 3、队列池 2，避免 891MiB 主机被后台并发挤满。
- 新发现：NHC 公报的 `<pre>` 被按代码跳过，现场 Vance Discussion Number 7 的 reason 为 no translatable text。仅为 NHC 官方公报增加独立回执命名空间、保护数字的正文处理，迁移只重新开放该原因的旧记录，保留 attempts 与全部回执。
- 最新全量后端执行 756 项，746 通过；失败包括未同步的 Step 参数期望和复用测试库中已老化的无 attempt 夹具。修正 Step 期望并在新建测试库中验证；账单回归在干净库通过。NHC 新增回归通过。以上保留原始失败日志，不能把首次全量执行写成全绿。最终 CI 使用全新数据库。
- 之前 58 项网页测试和构建结果复用；没有网页实现改动，不重复构建与测试。AIHOT 对比仍缺同条件网络指标，不能宣称已达到其速度。
