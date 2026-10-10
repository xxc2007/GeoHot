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

## 本轮上线 f6f0230 后复验（2026-10-10 晚间）

这是本轮功能修复的线上复验，仍然不是用户长程任务最终完成验收。公开健康接口确认 `release:f6f0230`、DB 正常；GitHub 最后同步与历史收集/报刊关闭仍待 root 后续执行。

- 部署前 sitemap 抓取在 09:54:31Z–09:57:06Z 实际枚举 930 个公开 URL，全部返回 200；连同其他入口共 1027 次只读 HTTP 请求。JSON 原始 failure 队列中 `monthlies/latest` 的 404 是无可读月刊的预期结果，`security.txt` 的 404 是 contactEmail 未设时的明确代码行为，两者均不判为部署故障。
- 上线后 320px 实际点日报→周报，URL 和正文均为周报；再点月报，正文明确“还没有发布地理月报”。切回日报→更早到达日报合订本。此前客户端 `.data` 故障消失。
- 320px 报头截图完整显示“地理日报”，日期牌不再遮挡。检查页面宽度时未见横向溢出。
- 390px 首页真实点搜索图标，导航到 `/all?search=1` 后 INPUT 自动获得焦点；实际输入“气候”并提交，URL 与搜索标题正确。点击末端“地理信息系统”，`category=geotech` 与 aria-current 相同，单次 `search=1` 参数清掉。实际点“下一页”到 page=2，打开 ICA 儿童制图竞赛详情，再点击站内“返回”，回到同一分类的第 2 页。详情没有未加载/损坏图片，原文链接保留。
- 常驻四服务 active；前述三个邻站文件 SHA256 均与基线一致。公开根路径页面经 CDN 改写，HTTP 内容 hash 不与源文件 hash混用。
- 完整 smoke 两次复验均出现尾部并发抓取 `TypeError: fetch failed`，所以不能把完整命令标成通过。其他主要页/出口/资源前缀检查通过，第二次中文文案检查全部通过。随后独立逐项读取 sitemap、daily feed、site index、v1 dailies 四接口均 200，六期日报键集合完全一致；真实证据 `release-f6f0230-cross-outlet.json`。这确认集合一致性，保留完整 smoke 的网络失败记录，不隐瞒执行结果。
- 第二轮 sitemap 全枚举与更多移动交互仍在执行，完成后追加计数。扩展来源的错误与站点错误继续分开。

- 390px 日报→周报→月报的第二组真实点击也正确：日报为 2026-10-10，周报为 2026-W40，月报为尚未发布空状态。全部动态的分类分页和详情返回链条均已验证。
- 额外验证本机收藏闭环：详情原状态 `aria-pressed=false`；实际添加后收藏列表出现 ICA 儿童制图竞赛条目，再点击取消后列表回到“还没有收藏内容”，已恢复测试前状态。没有提交反馈或执行后台写操作。
- 浏览器错误日志最终读取：0 个站点来源 error，5 个浏览器扩展来源 error。该计数只覆盖本次浏览器会话，不代表所有设备永久无错误。视口覆盖已重置。
- 2026-10-10T14:42:14Z 再次只读检查，四服务仍 active，邻站三个文件 hash 均保持基线一致；原始记录 `release-f6f0230-services-neighbors.log`。

## 第二轮全枚举结果

上线 f6f0230 后再次抓取 sitemap 发现 1138 个 URL，逐一只读访问全部 200。连同七分类的页面/feed、报告列表/详情/导航、公开 API、分页/搜索、错误输入和未登录后台边界、禁用页面及首页构建资源，共 1235 次 HTTP 检查，没有出现网络抓取异常。首页 12 个构建资源全部 200。仅原始检查期望值设为 200 的两个接口返回 404：无公开月刊的 `/api/v1/monthlies/latest` 与未配置联系邮箱的 `/.well-known/security.txt`，均符合明确代码行为。原始结果保留，不修改成伪造的“零 failure JSON”。

本轮公开报告仍为日报 6 期、周报 1 期、月报 0 期；只覆盖可枚举公开窗口。完整历史资料、稿件及日/周/月补刊尚未完成，不能以公开 URL 可用替代历史覆盖完成证明。这个检查也不穷举无限参数组合、外部原文链接或登录后台全部写操作。

私有证据：`baseline-crawl.json`、`release-f6f0230-crawl.json`、两次完整 smoke 日志、逐项 cross-outlet JSON、services-neighbors 日志。本文件交给 root 后，最终 GitHub/服务器同步仍需另一次版本与站点验收；本轮未声称全任务最终成功。

### 服务器本机完整冒烟复核

root 在 2026-10-10 22:45 CST 从服务器运行 `node scripts/smoke.ts --base http://127.0.0.1:3000/geohot`，整条命令通过：17 个页面、机器出口、MCP initialize、`/geohot` 资源前缀、四出口六期日报集合一致性及中文标题检查全部通过。此项验证服务器应用及反向代理内链；公开 HTTPS、CDN 和外部网络证据仍以以上浏览器与全枚举结果为准，不能用本机通过抹掉先前外部 smoke 的网络失败记录。

## 预算调度修复上线后的独立验证

2026-10-10 23:29 CST 前后，root 在归档共享锁内部署 `964a2f2`，先停止归档定时器并等待唯一 worker 优雅退出，再切换源码与 `/geohot` 生产构建。保留 0600 的部署前源码/环境回退包。启动瞬间观察到一次连接拒绝及一次 502；随后等待健康检查确认启动成功，没有将启动过程的响应冒称正常请求。

公开 HTTPS `/geohot/api/health` 实际返回 200、`ok:true`、`db:ok`、`release:964a2f2`。四常驻服务及 `geohot-archive.timer` 都恢复 active。服务器上的四个模型/回执源文件、portable-backup 脚本及 brain-stub 源文件 SHA256 与 git 提交的原始 LF blob 逐项一致。

本次完整 loopback smoke 通过；随后服务器执行只读 `deploy/geohot/verify-deploy.sh`，包含公开 HTTPS 和邻站基线、服务、brain source/defaults、数据与出口及完整 smoke，最终 `RESULT: ALL CHECKS PASSED`。原始日志保存在本轮私有目录 `deploy-964a2f2.log`、`smoke-964a2f2.log`、`verify-deploy-964a2f2.log`。

本轮不是全量历史筛选、补刊及最终 GitHub 同步验收。公开报告当前仍为六期日报、一期公开周报、零期公开月报；历史区间尚未关闭，不能以功能冒烟通过替代内容完成证明。

## 2026-10-11 拒收重试与最短预算退避修复

根任务部署 `29ca24d`，将 ITDP RSS 历史入口与两项后台修复纳入统一应用源码：全部外发候选被本地预算拒绝时保留最短原始 BudgetExceededError；无效 paid writing 被并行 structure 的预算拒绝遮蔽时，先记 ModelOutputError，继续沿用既有三次输出失败上限。没有覆盖 unknown/busy/中断/真实供应商错误，没有调整预算、筛选门槛、分析并发或五分钟扫描节奏。

根隔离数据库全量回归为 438 项、433 pass、0 fail、5 既有明确 skip，全部工作区类型检查通过。新增真实 pg-boss 三路径回归由第 13 名 agent 独立库运行与 root 复跑均为 4/4 pass：坏写作三次到 failed、有效写作预算 waiting 不增失败数且复用文案、已有 unknown 结构回执保持 unknown-receipt 不重送。第 18 名 agent 对实际补丁及 fixture 独立只读检查未见阻断问题。真实 job 测试手工立即投递验证失败上限，不等于实际分钟调度验证；unknown 由本地账本构造，不等于新网络超时实测。两方测试库已分别删除。

部署在共享归档锁内进行，先暂停 timer 并等待唯一 worker 正常退出，保留 0600 的 `pre-29ca24d-app.tgz` 回滚快照，再切换全量 Git 源码及 `/geohot` 生产构建。worker 实际启动时间为 2026-10-11 07:47:54 CST。启动窗口观察到两次 502，随后公开健康返回 `ok:true, db:ok, release:29ca24d`；四服务与 timer active。五个核心/采集/备份文件 SHA256 与该 Git 提交的原始 LF blob 逐一相同。

服务器随后完整执行 `deploy/geohot/verify-deploy.sh`：公开 HTTPS、邻站基线、服务及 brain 默认配置、数据出口与完整 smoke 均通过，最终 `RESULT: ALL CHECKS PASSED`。私有日志为 `deploy-29ca24d.log`、`verify-deploy-29ca24d.log`、`retry-fix-whole.log`、`retry-fix-typecheck.log` 与 `retry-fix-job-root.log`。

公开报告仍为六期日报、一期周报、零月报。以上验证证明当前修复部署及列出的行为，不证明历史积压已闭环，也不证明实际吞吐已经恢复；实际生产观察继续单独记录。最终内容重排、全枚举验收、GitHub 发布、清理与新最终迁移包仍待完成。
