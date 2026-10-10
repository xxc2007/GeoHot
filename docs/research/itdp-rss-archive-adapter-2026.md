# ITDP 2026 RSS 历史入口：受控接入与只读验证

日期：2026-10-10（Asia/Shanghai）。本次只为已登记且启用的 `rss-itdp-news` 增加已核验的 RSS 历史入口。没有部署、写生产、启动额外 worker、调用模型、改变预算或筛选门槛。LOC 月适配保持原样；其本次 38 条覆盖已经独立核验。

## 实施范围

* `industry/news-archives.json` 新增唯一 RSS 历史规则：`rss-itdp-news`，`format: rss`，`mode: pages`，第一页为 1，模板为 `https://www.itdp.org/feed/?paged={page}`。没有修改正式信源配置。
* `scripts/backfill-news.ts` 对未指定 format 的规则继续原来的 HTML 分派，RSS 分派调用现有 `fetchRss()`。RSS 页覆盖 feedUrl，保留注册信源的 URL 前缀过滤等配置，并强制实际读取，避免使用常规 live-feed ETag/Last-Modified 缓存把 304 当成档案空页。
* RSS 的单轮判重、重复页检测和 partial checkpoint 使用 canonical URL 身份，去除 www、追踪参数与末尾斜杠别名；原 HTML 的身份和 checkpoint 行为不变。标准 upsert 仍负责最终入库的 canonical 去重。
* 不把 feed 提供的 teaser/摘要作为 body/excerpt 送入：沿用 `material()` 只投递标题、真实原文地址、保留时区后的发布日期，标记 archive/pending，后续正常抽取与模型工作流由原 worker 完成。

所有 format/range/来源启用和 editorial 检查在请求前执行，RSS 历史规则只能用于已登记 RSS 类型。既有 max-pages/max-items、成功入库及入队之后才持久化 checkpoint、未定日期重观察、非空且全部有日期的整页全 old 才取得 older-boundary、边界重观察、范围改变不可复用旧边界的规则继续生效。

## 回归证据

新增 `scripts/backfill-news-rss.test.ts` 8 项有实际 XML/HTTP stub 的测试，与原主 CLI 及 HTML 扩充适配测试合跑：**26 tests、26 pass、0 fail、0 skip**。`tsc -p scripts --pretty false` 通过。XML stub 仅位于本机临时端口，不需要数据库或外部服务；测试过程临时启用本机 private fetch，结束恢复。

测试覆盖：

1. 只为 ITDP 添加 RSS 规则，HTML 默认配置和 URL 仍原样分派。
2. RSS 带时区日期保真及北京时间日窗口；原 live-feed validator 已存在时仍实际读取；摘要不冒充正文。
3. www/追踪参数/末尾斜杠别名去重，不重复消耗 item cap；全 old、有效非空页取得边界。
4. HTTP 503 和有效但空 RSS 不完成 checkpoint，不产生伪覆盖边界。
5. 缺日期记录保持 unknown；混合 old 与 undated 页不取得边界。
6. canonical 重复页以 limited/coverage unknown 停止，不当作成功覆盖。
7. page/item cap、有界 partial checkpoint 跨次继续且不重复入库/入队。
8. 无效/反向范围、错来源类型被拒，已存 old 边界重读，更宽日期范围不能沿用较窄窗口停止点。

完整测试命令：

```powershell
node node_modules/typescript/bin/tsc -p scripts --pretty false
node --test scripts/backfill-news-rss.test.ts scripts/backfill-news.test.ts scripts/news-archive-expanded.test.ts
```

## 官方原站真实 dry-run

运行以下 CLI，未加载 `.env`，未传 apply，没有数据库操作：

```powershell
node scripts/backfill-news.ts --sources=rss-itdp-news --from=2026-01-01 --to=2026-10-10 --max-pages=8 --max-items=100 --sleep-ms=300
```

退出码 0，结果：

```json
{"mode":"dry-run","from":"2026-01-01","to":"2026-10-10","pages":6,"candidates":54,"eligible":38,"undated":0,"created":0,"revised":0,"queued":0,"errors":0,"limited":false,"boundaries":[{"source":"rss-itdp-news","url":"https://www.itdp.org/feed/?paged=6","reused":false}]}
```

此前逐页证据读到第五页，其包含两条 2026 年文章和七条 2025 年文章，因此不能将第五页当作“整页全 old”。本次 CLI 正确继续读到[第六页](https://www.itdp.org/feed/?paged=6)，实际九条都在窗口前，取得停止边界；前五页合计 45 条中的窗口内 38 条保持一致。逐条及汇总日志保存在本轮私有证据目录 `D:\地理热点网站\.round11\itdp-rss-dry-run.jsonl`。

来源时间按 RSS pubDate 而非 URL 路径：例如 [一篇 URL 标为 01/06 的文章](https://itdp.org/2026/01/06/better-bus-service-electric-buses-stmagazine-37/) 实际 RSS UTC 时间为 `2026-01-07T02:37:56Z`。归档筛选使用保存后的时间换算到北京时间，不通过 URL 猜日期。

38 是候选数量，不是精选或已发布数量。实际部署、bounded apply、数据库 canonical 判重、正文抽取、模型筛选与报告最终覆盖由根任务审查后另行执行，本次未宣称这部分已完成。

## 2026-10-11 根任务复验与部署前修复

根任务重新跑初版 26 项与 scripts 类型检查均通过，但第 18 名独立审阅发现 RSS parser 本身并不执行注册源 URL 过滤；仅保留 config 并不能保留原采集流程。独立 memory/XML 实证确认初版可将外域链接以 ITDP 身份送入。该初版尚未部署，没有生产外域入库。

根已在 RSS 分支复用既有纯 `applySourceFilters`，HTML 分支保持原样；新增真实 XML 测试包含合法 ITDP、deny 前缀、外域和相似恶意域，断言只有合法 URL 能 store/queue。最终根复验 **27/27 通过**，scripts 类型检查通过。原初版 26 项及错误说明保留，不倒写为原来已经正确。

最终过滤版本在未加载 .env 的情况下真实 dry-run `2026-01-01..2026-10-11`：6 页、54 parsed candidates、38 eligible、0 undated、0 errors、limited false，第六页全旧边界；未写入、未排队。日志 `itdp-root-dryrun-20261011.jsonl`。与前日 38 候选保持一致，正式生产状态仍以 bounded apply 后的实际结果为准。

## 第 18 号 agent 独立最终复核（2026-10-11）

独立只读审查了 RSS/HTML 分派、ITDP 规则与注册配置、日期与 older-boundary 判定、canonical 判重、partial 成功确认、页数与条数限额，以及现有 guardedFetch 的公开地址校验和跨域重定向凭据处理。本次没有加载 `.env`，没有连接数据库、操作生产或调用模型。

审查过程中发现并在本机实际 XML 与内存 store/queue 中复现过 P2：新增 RSS 历史分派起初绕过了注册来源的 allow/deny URL 过滤。根任务在部署前修复：RSS 实际 fetch 后复用现有 `applySourceFilters()`，HTML 分派保持原样。最终代码的新回归输入同时包含合法 ITDP URL、deny 前缀、外域和 `itdp.org.evil` 相似域；只有合法 URL 得到 store/queue。这一历史问题已关闭，不能将修复前复现实证当成当前行为。

独立对最终落盘版本重新执行上列三个 scripts 测试文件：**27 tests、27 pass、0 fail、0 skip**，退出码 0；独立 scripts TypeScript 检查退出码 0。核对了强制实际 RSS 请求、不用 live-feed validator 冒充档案空页；缺日期、空页和失败保持 unknown；整页有有效日期且全部早于窗口才建立停止边界；canonical 别名不重复占 cap；只有 store 与 queue 成功后才确认 partial URL；既有 HTML 回归继续通过。本次范围内未发现另一个需要阻止受控部署的 P1/P2。

该结论是针对当前 ITDP 接入及列出的本地回归，不能替代全网 SSRF 行为验证、数据库实际写入或最终模型筛选/发布检查。上文原站 dry-run 的 38 条是根任务提供的候选证据，本独立复核没有重新执行原站采集；本次 27 项回归也不证明生产已部署或 38 条已发布。后续 bounded apply 与线上结果仍需由根任务单独验收。

## 2026-10-11 上午生产 bounded apply

根任务部署最终过滤版本 `8f6f843` 的 CLI、规则与测试，服务器三个 scripts 回归合计 27/27 通过。部署与 apply 共用归档锁，没有新建第二个分析 worker，也没有调整模型预算。核心服务当时仍为 `964a2f2`，这是中间 CLI 部署，不能描述为全部最终版本同步。

实际 `2026-01-01..2026-10-11` ITDP apply：6 页、54 parsed、38 eligible、0 undated、29 created、0 revised、38 queued、0 errors、limited false，第六页为实际全旧边界。新增 29 与排队 38 是不同口径，九条已有材料继续沿用原抽取与筛选流程；这些数目不是精选或出版数。

随后对全部 11 个新闻入口单独检查 `2026-10-11..2026-10-11`：12 页、166 parsed、0 eligible、0 created、0 queued、0 errors、limited false。十个分页源读到旧日期边界，LOC 当月入口实际读取一页。此结果仅覆盖当日上午执行时能读取的内容，不能证明整天没有新增。两项原始 JSON 汇总在私有证据 `news-rss-apply-20261011.log`，服务器持久日志与断点继续纳入迁移备份。
