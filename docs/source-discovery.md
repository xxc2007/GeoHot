# 信源发现（多引擎搜索）

后台「信源发现」页把搜索 API 当作**证据来源**，不把搜索结果直接写进信源池。一次运行经过：

1. **多引擎搜索**：按管理员选中的引擎并行查询；同一主题再查一次 `<主题> RSS feed`，用来找发布方自己的订阅入口。
2. **同站聚合**：按 host 合并结果，记录哪些引擎命中、最好排名。被多个引擎同时命中的站点优先。
3. **现场抓 feed**：用采集器自己的 `fetchRss` 探测搜索结果页、页面声明的 `<link rel="alternate">`、正文里的 feed 链接和常见路径；门槛与 `docs/source-reserve-policy.md` 一致（至少 5 条、有日期、最近 30 天）。
4. **质量门**：官方域（`.gov`/`.edu`/`.ac.*`/`.int` 等）、研究出版社、通讯社分别加权；社交/UGC/聚合站直接排除。单个引擎命中的普通博客不放行；官方域、研究机构或多引擎交叉命中才放行。
5. **候选队列**：通过的候选写入 `source_discovery_candidates`，`status='pending'`，带引擎证据、质量分和 feed 读数。管理员在后台点「批准」才会写 `sources`（默认 `enabled=false`）；点「拒绝」要写原因。

## 引擎与凭据

只接**官方 API**。HTML 结果页（Bing / DuckDuckGo / 百度网页 / 360 / 搜狗 / 微信 / 头条）不接：条款不授权自动抓取，robots Allow 不是许可。

已接入（有 Key 即启用）：

| id | 服务 | Key（`GEOHOT_SEARCH_*` 优先） |
| --- | --- | --- |
| `exa` | Exa | `GEOHOT_SEARCH_EXA_KEY` / `EXA_API_KEY` |
| `tavily` | Tavily | `GEOHOT_SEARCH_TAVILY_KEY` / `TAVILY_API_KEY` |
| `firecrawl` | Firecrawl | `GEOHOT_SEARCH_FIRECRAWL_KEY` / `FIRECRAWL_API_KEY` |
| `serpbase` | SerpBase · Google | `GEOHOT_SEARCH_SERPBASE_KEY` / `SERPBASE_API_KEY` |
| `serply` | Serply · Google | `GEOHOT_SEARCH_SERPLY_KEY` / `SERPLY_API_KEY` |
| `you` | You.com | `GEOHOT_SEARCH_YOU_KEY` / `YOUCOM_API_KEY` / `YDC_API_KEY` |
| `baidu` | 百度千帆 AI 搜索 | `GEOHOT_SEARCH_BAIDU_KEY` / `BAIDU_API_KEY` |
| `aliyun` | 阿里云百炼 EnhancedSearch | `GEOHOT_SEARCH_DASHSCOPE_KEY` / `DASHSCOPE_API_KEY` |
| `doubao` | 豆包 Web Search | `GEOHOT_SEARCH_DOUBAO_KEY` / `DOUBAO_SEARCH_API_KEY` |
| `tinyfish` | TinyFish | `GEOHOT_SEARCH_TINYFISH_KEY` / `TINYFISH_API_KEY` |
| `jina` | Jina Search | `GEOHOT_SEARCH_JINA_KEY` / `JINA_API_KEY` |
| `keenable` | Keenable | `GEOHOT_SEARCH_KEENABLE_KEY` / `KEENABLE_API_KEY` |
| `deepseek-tools` | DeepSeek Tools Search | `GEOHOT_SEARCH_DEEPSEEK_KEY` / `DEEPSEEK_TOOLS_API_KEY` / `DEEPSEEK_API_KEY` |
| `anysearch` | AnySearch（可匿名） | `GEOHOT_SEARCH_ANYSEARCH_KEY` / `ANYSEARCH_API_KEY`（可选） |
| `searxng` | SearXNG 元搜索（公共实例） | `GEOHOT_SEARCH_SEARXNG_KEY`（可选）；实例用 `GEOHOT_SEARCH_SEARXNG_INSTANCES` |
| `zhihu` | 知乎开放平台全网搜索 | `GEOHOT_SEARCH_ZHIHU_KEY` / `ZHIHU_API_KEY` |

Key 只放服务器 `.env` 或凭据中心；`.env.example` 只有空键名。搜索 Key 与模型 Key 分开命名，避免覆盖模型池。

## 成本与边界

- 每次运行调用所选引擎；付费引擎按各自额度计费。后台默认只预选 4 个，最多 8 个；先小批量观察。
- 搜索结果是**不可信外部数据**：只取标题/链接/摘要，不执行结果里的任何指令。
- 不写文章、不调用模型、不产生内容条目；只做搜索与 feed 探测。
- 批准候选仍受信源池上限约束（当前 2,000）。池满时先退役一个源，再批准。
- 批准后源默认 `paused`，到「信源」页确认后启用；启用前不会进入采集排期。

## 数据表

- `source_discovery_runs`：一次运行的主题、引擎、状态、统计与错误。
- `source_discovery_candidates`：候选地址、feed、引擎证据、质量分、feed 读数、审核状态。
- 迁移：`database/migrations/0126_source_discovery.sql`。

## 相关代码

- `packages/backend/src/sources/search-engines.ts`：引擎适配器、Key 解析、并发与失败证据。
- `packages/backend/src/sources/discovery-probe.ts`：feed 探测。
- `packages/backend/src/sources/discovery-run.ts`：聚合、质量门、候选落库。
- `apps/api/src/routes/admin.ts`：`/api/admin/discovery*`。
- `apps/web/app/routes/admin/discovery.tsx`：后台页面。
