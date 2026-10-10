# GEOHOT 独立网站验收（Agent 20）

本记录区分部署前基线和最终部署复验。2026-10-10 执行；本轮仍在历史回填与编辑筛选阶段，不能据此称任务已完成、GitHub/服务器已同步或历史报刊已补齐。

## 部署前基线

- `node scripts/smoke.ts --base https://xxc2007.me/geohot/`：2026-10-10 17:53–17:54 CST 退出 0，17 个主要页面、18 个机器出口、MCP initialize、子路径资源前缀、日报 sitemap/feed/site/v1 集合一致性、抽样中文标题检查通过。公开日报为 6 期。
- 公开 `/api/health`：200，`ok:true, db:ok`，release 为 `dev`，尚不足以证明最终源码版本。
- 17:55 左右公开 stats：289 启用来源、12433 条公开资料、302 条精选、6 期公开日报。数字随 worker 处理而变化，不作固定产品指标。
- 服务器四常驻单元 `geohot-api/web/worker/brain` 均 active。
- 邻站真实文件 SHA256：`/var/www/intro/index.html` 为 `01fca76e0ca1fe44e2caeb79e428593f5ccbe475ef25274eca2fd3541475aca8`；`/var/www/nc15/index.html` 为 `6313aabee215ccc7c882fb1a3fe82909a3268996be754be54d914b31b103a40a`；`/var/www/intro/sitemap.xml` 为 `b772e47185588148a8cecaa757fd74ae31641779c4281356c18c535ddf6cd2eb`。最终部署后需逐字节复比。

## 实际浏览器交互（部署前）

使用 Codex 浏览器 DOM、实际点击及截图检查。320×844 与 390×844；保留已安装浏览器扩展，扩展错误单独归属。

1. 320px 日报报头右侧被日期牌遮挡，截图实际可见，尽管页面没有横向滚动。这属于本轮移动修复等待部署的问题。
2. **日报/归档点周报，地址变为 `/geohot/weekly`，正文仍是日报；点月报同样仍是日报。** 390px 复现，等待周报标题仍未出现。直接 SSR 请求 weekly 标题正确、monthly 是未发布空状态。已向 root 报告；root 已修复 `kindFromPath` 对 React Router `.data` 请求的识别并通过 9 项回归测试，尚待部署后真实客户端复验。
3. 320px 全部动态实际填入“气候”并点击搜索，最终 URL 含 `q=气候`，页面标题“搜索‘气候’”，结果与排序入口存在。
4. 390px 地理信息系统分类真实点击、日报合订本页面可用；未检测到页面横向溢出（document scrollWidth 为视口减去滚动条宽度）。
5. 浏览器日志出现翻译/学习工具扩展的 Failed to fetch，来源均 `chrome-extension://`；不可将这些错误报告为 GEOHOT 站点异常。本轮已读日志没有发现 GEOHOT 来源的 JavaScript error。

## 最终验收清单（尚未执行）

- 发布 commit/tree 与服务器源码/构建 release/hash 对应；所有常驻单元与历史回填单元状态符合预期。
- 重新运行仓库 smoke；枚举 sitemap 全部内部公开地址，七分类、主题、报告详情/导航、公开 API、feed、robots、manifest、OpenAPI、MCP、资源前缀和错误响应。
- 浏览器真实日报→周报→月报→归档、报告详情、全部动态→搜索→翻页、收藏与详情交互；320/390 无遮挡和意外横向溢出，区分站点/扩展 JS errors。
- 邻站根页面、/nc15 与根 sitemap 的服务器文件哈希保持一致。
- 公开 issue 集合与历史回填关闭状态单独核验；空稿隐藏、仍待筛选不应冒称出刊。
- 本报告不会声称每条内容已事实审读、所有手机/低端设备/慢网/屏幕阅读器/Core Web Vitals 全部达标；内容事实审读由独立内容审计负责。

私有原始证据位于仓库外 `D:\地理热点网站\.round11\a20\`，其中 smoke 日志和抓取 JSON 由实际请求生成。最终复验后会在本文件追加结果，并更新尚未执行项。
