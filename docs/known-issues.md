# 已知问题与未完成项

这份清单是给读者和维护者的：这个仓库知道自己哪里还没做好。写在这里的每一条都在
`2026-10-02` 那天被验证过要么是真的问题、要么是尚未完成的工作，而不是猜测。

> **本清单的复核规则（每天 08:00 就会作废的那一类）**：凡是带"第 N 期 / 几件大事 / 几个来源 /
> 热度指数 / count = 几 / 共 X 条"的句子，都只在写下它的那一天成立——日报每天 08:00 出刊
> （`apps/worker/src/schedules.ts:46` 的 `reports.daily` 是 `0 8 * * *`），热点榜每 5 分钟重排
> （同文件 `:42` 的 `hot.rank`），`/api/v1/dailies` 的 `count` 跟着期数走。**规则**：读到这类数字，先看它
> 后面有没有写验证日期；没有就当它是错的，用括号里给的命令当场重测一遍再改这一行。2026-10-03 起，
> 本清单与 `README.md` 里新写的数字一律带日期与复测命令；老数字按这条规则逐个换掉。
> 只有"某天某天做过什么"的历史条目（`industry/changelog.json`、下面那些带日期的评审小节）不改写。

## 站点已部署，但有四件事还没跟上

`https://xxc2007.me/geohot/` 于 2026-10-01 上线（装法、验证命令、踩过的坑见
`deploy/geohot/DEPLOYMENT.md`），主站首页逐字节未变。以下四项是上线时就知道的缺口：

1. **日报已出刊，且不再只有一期（2026-10-03 复核）**：`/daily` 给的是**最新一期**，2026-10-03 08:00 起是
   「第 2 期 · 2026 年 10 月 3 日」，那一期只有 1 条入选（`本期共 1 条`）——薄，但是真的。**这一行不再写"第 1 期 · 21 件大事"，
   因为那四个数字属于 2026-10-02 那一期**（固定地址 `/daily/2026-10-02`：21 件大事、14 个来源、12 件一手发布）。
   要复测：`curl -s https://xxc2007.me/geohot/api/v1/dailies` 看 `count` 与 `items[].date`（2026-10-03 实测
   `count=2`，两期分别是 10-03 与 10-02），或直接看 `/daily/archive`。上线首日（10-01）确实是诚实的空态，
   原因见下面「上线首日没有日报」一节。
2. **两处地理文案没回到 `industry/`**：`apps/web/app/routes/topics.tsx`（把 `industry/topics.json` 里
   已有的分组名与说明又抄了一份常量）与 `apps/web/app/features/report/format.ts`（日报分页标题拼接）
   里写死了中文地理词。2026-10-02 已把另外两处**规则**搬回词表：条目页的防灾提示判定改用
   `industry/taxonomy.ts` 的 `RISK_NOTICE_CATEGORIES` / `RISK_NOTICE_TAGS`，日报的发布数量指标改用
   `RELEASE_CATEGORY_KEY`，`apps/` 与 `packages/` 里不再有地理类别 key。
3. **Cloudflare 回源是明文 80**：浏览器↔CF 是 HTTPS，CF↔源站是 http。与主站同策略，改 Full(strict) 属于主站配置变更，未动。
4. **发布已收成一条命令（2026-10-02 更新）**：`deploy/geohot/publish-to-github.sh` 在一个临时索引里从
   HEAD 造发布树（排除清单只认 `deploy/geohot/publish-excludes`），以远端当前 HEAD 为父做一次快进推送
   ——不 force、不改写线上历史——然后当场交给 `deploy/geohot/verify-github-sync.sh` 逐字节验收：每个 blob
   哈希相等、每张配图再从远端取回来验签名与尺寸、SVG 过严格 XML 解析、README 的相对引用逐个命中。
   这一条以前写的是「发布不是一个脚本，是一条条 API 调用」，而那正是两次字节事故的来源：按文件 PUT 把
   工作区的 CRLF 写进 41 个线上 blob（内容等价、哈希不等），随后为了修它加上的换行归一化又吃掉了
   8 张 PNG 里天然的 `\r\n` 字节对。两种失败都不会让「我觉得已经同步了」这句话自己露馅，所以**验收脚本
   比发布脚本更重要**。旧的 `build-release.sh` 已随 `.brief/` 删除，正本换成上面这两个。

## 独立审计的复核结果（2026-10-01）

末轮独立审计报了 4 条不合格，其中 **3 条经复核为误报**，逐条留档以便下次不重复调查：

| 审计结论 | 复核 |
|---|---|
| 高县事件综述引用了不属于该事件的事实（四川省地震局、四级响应、烈度 4–5 度） | **误报**。澎湃那篇 `m.thepaper.cn/newsDetail_forward_34155490` 就是该事件的成员（`grouping_decisions` 里 verdict=`new-fact-in-story`），事件页也链到它，读者能逐条核对 |
| `/weekly`、`/monthly` 返回 404 | **误报**，两条都是 200。审计测量时 `/geohot/` 整体还没配好 |
| `/api/v1/dailies/latest` 给了明天日期的日报 | **误报**，实际返回 404「No daily report has been published yet」 |
| 线上文件数 537 与报告不符 | 属实但为时序：审计期间仓库被重新发布过两次，现为 546 |

唯一成立的是上面的第 4 条（force push），以及「`industry/` 不是唯一的地理层」——已按上表改为如实描述。

## 事件综述的溯源校验器被撤下

`packages/backend/src/events/digest-guard.ts` 曾经存在过一个逐句校验器：综述里出现的
机构与数字，必须在它自己那几篇报道里找得到出处，找不到就整句删掉，删到不成篇就不发布。

它的测试抓到一个**不能接受的误删**：报道里写的是 `USGS`，综述忠实地写成
`美国地质调查局`（这是身份词库里登记的别名），校验器却因为 `cgs`（中国地质调查局）
的词库模式 `/地质调查局/` 匹配进了 `美国地质调查局` 而把整句删掉，进而在某些输入上
把整条综述替换成"暂无通过溯源校验的综述"。这条路径正是英文信源 → 中文综述的日常流程，
不是边缘情况。所以它被**撤下**而不是放宽阈值：一个会删掉忠实内容的校验器，比没有校验器
更糟。

现在替代它的是 `industry/prompts/story-digest.md` 里写死的**出处边界**规则——同样的
要求，交给写作的那一步执行。要把它做成代码，必须先解决上面那个词库碰撞（复现样本在
`tests/identity-guard.test.ts` 里已作为已知缺陷钉住）。

## GDACS 绿色通报的模板英文标题进了公开池

`/all` 里能找到一批事件的标题就是原文英文模板，例如
`Green forest fire notification in Brazil`——实测**53 篇**处于 `eligible` 且
`visibility='public'` 的条目落在标题为 `Green forest fire notification in …`（Brazil /
Australia / Angola / Paraguay / Suriname, Brazil）的事件下，读者在中文站里看到的是英文标题。

它们来自 GDACS 的 `Green`（最低级别）森林火情通报：正文是同构模板，国别不同，
中文标题与摘要没有生成（这批条目的分析没有产出 `title_zh`）。**这不是归并错误**——
逐条核对过，每个国家各自独立成事件，成员数都是 1；早先怀疑的"14 篇并成一个事件"是
按标题聚合查询造成的假象，已排除。

要修的是两条，都属于**预筛层的策划决定**，不是代码缺陷：① GDACS `Green` 级别的森林火情
通报对"空间显著性"没有贡献，应当像旅游软文一样被 `BLOCK`；② 或者给这批模板条目补上
中文标题的生成规则。在做出决定之前，它们会继续以英文模板标题出现在公开池里。


## 上线首日没有日报——这是正确行为，不是缺陷

2026-10-01 当晚线上 `reports` 表为空：没有 daily，也没有周报月报。原因查清了，结论是**系统按设计运转**，
不是数据对不齐：

- 一份 08:00 出刊的日报，窗口是**它出刊前的那 24 小时**。`composeDaily("2026-10-01")` 的窗口是
  `[09-30 08:00, 10-01 08:00)`（北京时间）——实测候选 **0 条**。
- 而 `composeDaily("2026-10-02")` 的窗口 `[10-01 08:00, 10-02 08:00)` 实测候选 **39 条**。
- 策划语料是当天 16:17 才导入的，晚于当天 08:00 的出刊点，所以按"到达时间归属"规则，它**本来就属于
  明天的报纸**。所有材料的 `timeline_at` 落在 09-30 22:02 ～ 10-01 16:17，其中绝大多数走
  `visible_after` 分支（10-01 16:17 前后），即归属 10-02。

所以 10-02 08:00 的档期会出一份 39 条的日报，周报要等下一个周一（W40）才有内容，月报同理。

**顺带清掉的东西**：我在排查过程中手动触发了 `composeDaily` / `catchUpReports`，那几次跑在管道
把材料发布出去**之前**，于是生成了 4 期"存在但 0 条"的空刊。这些是我操作时序造成的空壳，当时手工删掉了。

**这条当时写得太早**：`catchUpReports` 之后又把缺的档期补齐了，`/daily/archive` 一度列出「共 8 期」，
其中 7 期是 0 件大事的空白报纸，报头还写着「约 1 分钟读完」。2026-10-02 改为**读取层闸门**：
`publication/reports.ts` 的 `listReports` 只列 `count > 0` 的期次，空刊不再出现在归档、月份网格、
前后导航与最新一期里；`readingMinutes` 对零字数的期次返回 0，版面无页脚与 OG 卡片随之隐去。
`reports` 表里的行**没有删除**——那是可逆的读取过滤，不是数据清洗；直接输入旧地址仍能看到那一期
诚实写着「本期没有入选内容」的版面。

**结论：不要在新库导入完成的同一分钟内手动触发组刊**——等管道跑完，或者等定时档期。

## 仓库里还留着指向 `.brief/` 的旧引用

构建期的仓库外目录 `.brief/`（研究产物、审计报告、打包脚本）已在交付时删除，但有 8 个已发布文件
仍在注释或文档里提到它，最集中是 `industry/sources.json` 的 `$comment`——里面点名了
`.brief/verify-sources.mts`、`WAVE3 §G`、`AUDIT-FACTS M7` 这类只存在于那个目录里的东西，
读者点不到、也跑不了。**没有任何命令读它们**，纯属历史叙述残留。

为什么会留下：那些注释当初是写给"有那个目录的维护者"看的，交付时只清了目录本身。
要么把措辞改成仓库内表述，要么在注释里注明"该目录已随交付清理"，两件都还没做。

## 摘要质量没有闸门

`/all` 里仍可能出现抓取残渣式的摘要（导航栏文案、被截断的正文回声）。曾在
`isPoolEligible` 里加过一层正则质量下限，被撤回：它在**发布时**写 `eligible`，于是
一条正常的短摘要（比如一句官方速报）会连带失去翻译、入选与所有出口——用"藏起真内容"
换"少几条垃圾"，方向是错的。正确的位置是上游的预筛与打分，不是下游的正则。

## 分数徽标仍写作「AI 评分」

这个站没有 LLM Key，两次独立打分来自人工写在 fixture 里的判断（见 README）。徽标文案
沿用上游措辞，暂时没改，因为它同时是"两次独立评分"这个机制的名字。措辞与事实不一致，
列在这里。

## 上游文档与本站实际情况的差异

`docs/architecture.md`、`docs/deploy.md`、`docs/leaderboard.md`、`docs/sources.md` 里
有若干命令与数字是上游 AIHOT 的语境（模型榜模块、上游的端口与目录），在本站不成立。
**逐条状态只记在 `docs/manual.md` 第 9 节那张"文档 × 状态"表里**，本清单不再重复一遍——那正是它们各自腐烂的地方。
（模型榜与 `/codex-reset` 为什么 404、影响到哪几个端点、底表搬去了哪里，唯一完整表述是那张表的
`docs/leaderboard.md` 那一行；唯一依据是 `industry/features.ts` 里那两个布尔值。）
2026-10-03 那一轮把 `docs/deploy.md` 从"照着做会部署成上游那个站"改回来了：第一条命令的克隆地址原本是
`KKKKhazix/AIHOT`，现已指向 `xxc2007/GeoHot`，并且补了「Docker 这条路是域名根部署」一节——它复现不了线上
`/geohot` 那个前缀拓扑。搬家与换域名的可验证清单在 `docs/migration.md`。

## 本站的 sitemap 对搜索引擎不可发现（已于 2026-10-02 关闭，留作历史）

第二轮机器出口审计量出来的事实：`https://xxc2007.me/geohot/robots.txt` 返回 200，内容正确，
`Sitemap:` 行也指向 `/geohot/sitemap.xml`。但 RFC 9309 规定 robots 文件**只在域名根生效**，
而 `https://xxc2007.me/robots.txt` 是主站（纪念册）的那一份，里面没有 `/geohot/` 的任何指引，
它的 `Sitemap:` 指向主站自己的 sitemap。结果是：**本站 585 条 URL 的 sitemap 不被任何 robots
文件引用，也不在任何 sitemap 索引里**，搜索引擎的自动发现路径为零（站内链接仍然会被爬到，
所以这是"发现效率"问题，不是"收录不了"问题）。

修法只有一条，且**必须站长本人决定**，因为它改的是主站的域名根文件：在
`xxc2007.me/robots.txt` 里加一行 `Sitemap: https://xxc2007.me/geohot/sitemap.xml`，并把
`/geohot/admin/`、`/geohot/starred/`、`/geohot/feedback/`、`/geohot/api/` 作为带前缀的
`Disallow` 写进去（本站自己那份 `Disallow: /admin/` 是域名根锚定的，就算被读到管的也是主站的路径）。
主站的 `robots.txt` 与首页哈希不在同一份文件里，加这几行不会改动首页，但它是**另一个站点的文件**，
所以本轮没有动。

**这一条是"共用域名"这个前提的产物**：搬到自己的域名根上，它就不是"别人的文件"而是搬家清单的第一步
（在新域名根放一份 `robots.txt`，带 `Sitemap:` 与不带前缀的 `Disallow`），逐条命令与验证方式写在
[`docs/migration.md`](migration.md) 第 4 步。

**已于 2026-10-02 经站长同意关闭**（改的是主站那份 `/var/www/nanchang15/robots.txt`，主站自己的规则与首页哈希未动）。
2026-10-03 复核：域名根那一份里两条 `Sitemap:` 都在（主站 + 本站），`Disallow` 覆盖 `/geohot/admin`、`/geohot/starred`、
`/geohot/feedback`，并放行 `/geohot/api/v1/` 与 `/geohot/api/mcp`。复核时同时修掉一处写错的规则：
上一版把 `Disallow` 写成了带尾斜杠的 `/geohot/starred/` 与 `/geohot/feedback/`，而 RFC 9309 的规则按**前缀**匹配，
真实地址 `/geohot/starred`（无尾斜杠，实测 200）并不以它开头——等于没拦。教训写进了 `docs/migration.md` 第 2 步。

同一类限制还有一条：`/.well-known/security.txt` 按 RFC 8615 也只在域名根有效。本站把它注册在
`/geohot/.well-known/security.txt`，现在因为 `industry/site.ts` 的 `contactEmail` 为 null 而返回 404
（这是设计如此，宁可不发布也不挂一个没人看的地址）；等站长填了真实邮箱，这条路由仍然不会出现在
扫描器实际去取的位置。要么在部署层把根路径的 `.well-known/security.txt` 也指过来，要么就接受
"本站不发布 security.txt"并在 `deploy/geohot/DEPLOYMENT.md` 里写明。

## Cloudflare 会在本站页面里注入一个本站代码之外的脚本

在真实浏览器里实测：`https://xxc2007.me/geohot/` 的 DOM 里恰好有**一个跨域脚本**
`https://static.cloudflareinsights.com/beacon.min.js/…`（Cloudflare Web Analytics 的信标），
而直接问源站取同一页，返回的 HTML 里不含它——是 Cloudflare 在边缘注入的。它不下发 Cookie
（`document.cookie` 为空），所以隐私页"不下发 Cookie"的说法成立；但"页面不加载任何本站代码以外的
脚本"这句**不成立**，已经在 `industry/pages/privacy.md` 第 2 条与第 8 条改成如实描述。

要彻底去掉是 Cloudflare 区域的「Web Analytics / RUM」开关，属于域名层设置，与主站共用，
本轮没有动。这也解释了性能面板里唯一一条 "legacy JavaScript 10.5 kB" ——那是 Cloudflare 自己的
信标在 polyfill `Array.prototype.at/findLast`，**本站打包出来的 JavaScript 没有一行是遗留转译的**。

## 2026-10-02 设计评审：查出来但**没有**改的几件事

这一轮以资深网页设计评审的口径把全站与仓库过了一遍。改了的部分见提交历史与
`deploy/geohot/DEPLOYMENT.md`；下面这些是**评估后决定暂不改**的，理由一并写清楚，
免得下一轮重新调查一遍。

1. **Cloudflare 的邮箱混淆把正文里的邮箱改成 `[email protected]`。** 抓取的国家气象台
   正文带着信源自己的页脚（`制作维护：国家气象中心预报系统开放实验室`、`京ICP备05055842号`、
   `技术支持邮箱 …`），CF 在回源响应里把那个邮箱换成了一个指向 `/cdn-cgi/l/email-protection`
   的链接，读者在 `/all` 上看到的就是 `[email protected]` 字样。根因有两条，都不在应用代码里：
   ① 采集层没有剥掉信源页脚的样板文字；② CF 区域的 Email Address Obfuscation 是开着的。
   关掉 CF 那个开关属于主站配置变更（与明文回源同一次决定），未动。
   `scripts/smoke.ts` 的子路径守卫显式放过 `/cdn-cgi/`，因为那是 CDN 改写的字节，不是页面写错的链接。
2. **未过闸门条目的分数是 stub 的地板值。** 没有人工判断的材料，`tooling/brain-stub.ts` 按
   `BRAIN_SCORE_DEFAULT`（默认 20）打分，于是 `/all` 上每张卡片都挂着一个「20」。数字没有说谎——
   它确实是管道给出的分——但它不是任何人的判断，而本站对外唯一的承诺是「每条编辑判断都有人署名写过」。
   正确的修法是让未判断的材料在读取层就是 `score: null`（`ScoreLabel` 遇到 null 本来就不渲染），
   但那要同时动打分与入选路径的取值，风险大于收益，留在这里。
3. **`/items/:id` 页的「AI 导读」与「AI 评分」是同一类措辞问题**，之前只登记了后者。
4. **日报报头是一块跨文档 `<use>`。** `features/report/Nameplate.tsx` 渲染
   `<use href="/geohot/assets/daily-*.svg#accent">`。Chrome 正常，WebKit 对跨文档 `<use>`
   的解析历来不可靠，而这块报头正是日报页的 LCP 元素。手上有 iOS 设备时应当实测；
   要根治是把两条 path 内联进组件（`scripts/nameplates.ts` 已经在构建期生成这些文件）。
5. **排版没有字号刻度。** 面向读者的组件里 Tailwind 的 `text-xs…4xl` 用了 0 次，取而代之的是
   37 个任意 px 值（`12` / `12.5` / `13` / `13.5` / `14.5` / `15.5` / `16.5` / `17.5` 并排站着）。
   圆角是反例里的正面样本：192 处全部走六个具名 token，零个 `rounded-md/lg/xl` 残留。
   把字号也做成刻度是一次纯机械但覆盖面很大的重构，本轮没做——它会让每一个 diff 都碰到视觉。
6. **时间轴竖线是靠手算对齐的**：`features/feed/Timeline.tsx` 里六个魔数
   （`top-[29px]`、`left-[10.5px]`、`size-[7px]`…）编码了当前 `py-3.5` + `leading-6` 的组合，
   改任何一处行高，圆点就会从连线上脱落。同上，属于该做但这次没做的重构。
7. **`--shadow-*` 定义在 `:root` 而不是 `@theme` 里**，所以生不成工具类，13 个文件得手写
   `shadow-[var(--shadow-pop)]`。

## 子路径链接退化：这一类问题现在有了守卫

`/geohot/` 部署下，一个写给根路径的绝对 URL（`href="/feed.xml"`、`action="/api/auth/password"`）
会被浏览器按**域根**解析，而不是按前缀解析——它不会 404 在本站，而是跳到同一台机器上的**另一个站点**。
2026-10-02 的评审数出六处：`/more` 的 RSS、`/agent` 的 llms.txt / MCP / OpenAPI（桌面侧栏与移动行各一份）、
`/items/:id` 菜单里的「导出 Markdown」，以及后台登录表单——最后那一条让 `/geohot/admin` **完全进不去**，
实测提交后浏览器落在了 `https://xxc2007.me/api/auth/password`。

同一类问题此前已经咬过三次（首页标签、周报月报标签、首页分类筛选），每次都在调用点修。
现在有两道结构性防线：`root.tsx` 在 History API 里把裸前缀规范化成带尾斜杠的路径，
`scripts/smoke.ts` 在带前缀的部署上爬一遍所有页面，任何 `href`/`src`/`action` 只要以 `/` 开头
又不在前缀之下就报错。跑法：`node scripts/smoke.ts --base https://<host>/geohot/`。

## 2026-10-02 第二轮评审里"查出来但选择不改"的三条

改动清单在 git 里，这里只留**决定不改**的三条和它们的代价，免得下一轮把它当新发现重复劳动。

1. **卡片里嵌套的可聚焦控件**（`FeedItem` 的整卡链接里还有 `Faces` 按钮、`Toggle` 展开按钮）。
   一张卡在 Tab 序里出现三次，是键盘读者的真实成本，但不是缺陷：卡片标题是链接、"另有 N 家"与
   头像组是**同一张卡上语义不同的动作**，把它们提到卡外会破坏列表的视觉密度，做成单一 tab stop
   ＋箭头在卡内移动则要自己实现一套焦点循环。WebAIM 对"整卡可点"的推荐做法（覆盖层链接）在这里
   也不成立，因为卡内本来就有两个以上真链接。接受现状。
2. **画布动画不监听 `prefers-reduced-motion` 的变化**（`SignalRiver` / `Halftone` / `IssueDots` 在
   effect 开头读一次 `.matches`）。系统设置中途被改，这三块会继续动到下次导航为止。
   代价评估：把 `still` 变成响应式 state 会让整个 effect 重跑，而 `SignalRiver` 那段有 230 行、
   持有两个离屏画布和一个 IntersectionObserver——为了一个每年撞不上几次的场景去赌它的重建路径，
   不值。CSS 侧的动画已经由 `app.css` 里的全局 `@media (prefers-reduced-motion: reduce)` 接管。
3. **按需加载的分组列表在无 JavaScript 时打不开**（`另有 N 家信源报道` / `展开 N 条进展`）。
   根因不是样式：那两页数据是首屏之后从 `/api/site/...` 取的，SSR 的 HTML 里**从来没有**它，
   所以 `<details>`、CSS `:target`、任何纯 CSS 的降级都变不出内容。真正的修法是在 feed 的 loader
   里为每张分组卡片多发一次查询（首页 20 张卡 ⇒ 最多多 20 次子查询，冷启动的 TTFB 会立刻变差），
   或给 `/story/:id` 做一份可被 `:target` 展开的静态副本。本轮改为**如实告知**：`root.tsx` 里有一段
   `<noscript>`，写明哪部分不可用、哪部分照常。要不要花那个 TTFB 是站长的产品决定，不是技术决定。

## 2026-10-02 第三轮评审（发布前那一轮）：还留着什么，以及检查器自己踩的坑

这一轮改掉的东西写在提交 `898987a` 的说明与其后的 docs/changelog 里。下面只记**决定不改、需要站
长决定、或留给下一轮**的，避免重复劳动。

1. **条目页的移动端「目录」按钮目前是休眠的。** 它要求条目有 ≥3 个正文小标题（`routes/item.tsx`
   的 `showOutline`），而当前语料全是短稿：本地与线上逐页实测（含线上 `hazards-L6`、`hazards-L23`）
   的 HTML 里都没有「本文目录」。代码路径有渲染测试覆盖，等语料里出现带小标题的长稿它会自己出现。
   要让它在短稿上也有内容（从段落合成目录），是**产品决定**，不是缺陷。
2. **视觉权重与"谁写的"不一致**：分数徽标（12.5px 加粗＋彩色环）比编辑写的推荐理由（13px 灰字）
   更响亮。本轮只把「AI 评分」这类措辞改正（改叫入选分、机械摘要挂「提要」标签），排版层级留待
   设计决定。
3. **`s-maxage` / `X-Accel-Expires` 目前没有任何一层在消费**：api 没有压缩中间件、Cloudflare 对这
   几个路径一律 DYNAMIC、nginx 片段是 `proxy_cache off`；机器出口的条件请求（ETag → 304）本身有效。
   要么在域名层打开缓存，要么在文档里写明这套机制空转——站长/域名层决定。
4. **关掉的两个模块仍在包里留了 4489 行死代码**（`packages/backend/src/leaderboard|monitor` 37 个
   文件 + `packages/contracts/src/{leaderboard,monitor}.ts` 359 行 + `apps/web/app/routes.ts` 里 8 条
   永不注册的路由）。内容面实测正确（都 404、sitemap 零条）；删除是一次需要全量回归的重构，留待
   下一轮。
5. （2026-10-07 已修，见第四十四轮）**报眼「第 N 期」现在读发布时盖的真号**（`reports.issue_no`，
   迁移 0048）：有引注的期在发布那一刻取号，重排保号、空刊不占号，读取层把号带进每个出口；
   前端不再在最新 400 期里数下标——那个「窗口满就整个隐去」的降级和它的 2027-11 期限一起删除。
6. **GDACS 绿色森林火情：文件改了，库里的条目还没动。** 预筛层已加
   `dropMarkersTitleOnly: ["green forest fire notification"]`（刻意窄到 forest fire：同为 Green 的
   地震/热带气旋/洪水通报带震级、坐标与人口，绝不能一起挡）。已入库的条目不受文件改动影响
   （`seed.ts` 是 ON CONFLICT DO NOTHING）：线上审计时是 53 条，本机开发库 2026-10-02 实测 73 条且
   全部 `public`/`eligible`。撤下要跑 `node scripts/retire-gdacs-green.ts`（默认 dry-run；`--apply`
   必须显式给 `--database-url=`，只把可见性置为 withdrawn、不删行、可逆）。
   **本轮没有对任何生产库执行它。**
7. **验收脚本自己也有过三个 bug，都在这一轮修掉并留了注释**：排除清单的读法在"文件末尾没有换行"
   时会在 EOF 后无限自转（曾把校验卡死 900 秒）；TLS 抖动让远端清单为空时拿空清单比全库，报出
   1105 条假差异（现在三次重试，且任一清单为空就直接停，不比对）；本地清单的两列读反，同样是上千
   条假红。结论与这份清单一直讲的一样：**检查器必须在「已知正确」和「已知错误」两种状态下各跑
   一次**，绿与红都可能是假的。
8. **`?from=` 之外没有别的"从哪来"记号**：条目页的「返回 + 去处」只在显式参数或同站 referrer 下
   出现，直接打开时如实写「返回」（不猜落点）。这是设计，不是缺失。

## 2026-10-02 英文泄漏：一份"看起来翻译过"的稿件是怎么骗过闸门的

有读者在站上截到一条整条英文的条目（标题、提要、正文都是原文）。根因不在翻译步骤，而在**回放器伪造了
中文字段**：`tooling/brain-stub.ts` 的 summarize 默认分支曾把英文原标题回显进 `title_zh`、把英文正文用
`condense` 压成 `summary_zh`。而 `editorial/analyze.ts:372-374` 本来就有中文闸门——`titleZh` 或 `summaryZh`
为空的条目判 `unknown`，`isPoolEligible` 要求 `pass` 才进公开池。闸门没错，它被喂了一个"已经译好"的假象。

修法与留下的教训：

1. **默认值改成不写**（`BRAIN_SUMMARIZE_DEFAULT` 出货默认 `empty`），`understand` 的默认同样不再回显标题
   ——近端条目（采集当天的）走的是 understand 这条写作路径（`analyze.ts:355`），不在 summarize。
2. **行为变化（不是缺陷）**：没有人工署名中文稿的条目会停在 `unknown`，不进 `/all`、不进精选、不进日报、
   不进 sitemap/RSS/API。这是本站「编辑判断必须有人写过」的直接推论；后台仍能看到它们，写完 fixture
   重跑分析即可上架。`scripts/refill-copy.ts` 是这条路径的工具（默认 dry-run，>50 条必须用 `--ids` 指定）。
3. **12 条存量已补译**（线上当时 53 条里的全部英文条目），逐条对照原文翻译、不增不改；线上实测
   `english: 0`，`smoke` 的新断言 `reader copy` 全绿。
4. **这类问题以前没有任何一层会报红**，所以它活了一整天——`scripts/smoke.ts` 现在有一条公开池中文断言。
   审计同类问题时的顺序：先看"某个字段的值是哪一步写的"，再看"这一步的默认值是否伪装成了完成态"。
5. **写 fixture 前先看这一步的输入到底有什么**：这一版 summarize 的输入里**没有 URL**
   （`writing.ts:283` 的 `buildArticlePrompt` 只给日期、来源、标题、正文），所以用 `urlIncludes` 写的
   summarize 条目**永远不会匹配**——2026-10-02 我先写了三条这样的，一次都没生效；改用 `titleIncludes` 后
   立即命中。这条教训写在 `tooling/fixtures/summarize.jsonl` 的文件头里。
6. 同批被清掉的还有一类"默认放行"进来的噪声：New Scientist 的 Tom Gauld 漫画专栏（此前 65 分进精选）
   由既有的 `prefilter-fill-noise-newscientist-gauld` 判 BLOCK——它在重跑前一直没生效，因为回执缓存让
   "没重跑"看起来像"已经判过"。

## 上游还有一条更大的线没有搬（2026-10-02 记录，下一轮决定）

逐文件对账的结果：本仓库落后上游（`github.com/KKKKhazix/AIHOT`，最新 2026-10-02 14:23）的不止上面四处，
还有一整条 10-01/10-02 的后端线：`events/consolidate.ts`、`events/corrections.ts`、`events/recall.ts`、
`events/derived-content.ts`、`content/markdown.ts`（**已搬**）、`audit.ts`、`admin/navigation.ts`、
`routes/agent.ts`，以及三个迁移 `0039_oss_recovery.sql`（`articles.processing_attempt_tag`）、
`0040_oss_domain_recovery.sql`（`story_digests.context_article_ids`）、`0041_admin_session_binding.sql`
（`admin_sessions.auth_method/auth_binding/auth_claims`）。

**本轮不整体搬运的理由**（不是拖延，是判断）：

- 它们是同一次大重构（上游提交 `8d5a39b`「improve recovery, public consistency and agent access」与
  `035f7b7`「整合社区采集、会话、恢复和跨行业适配修复」）里互相依赖的一整套：attempt-tag 恢复链、
  会话绑定、社区采集、embedding 复用、事件纠错；拆一半搬进来，比不搬更容易出半一致状态。
- 其中相对独立、读者可见或影响正确性的四条**已经单独搬完**（事件进展排序、Markdown 导出文件名、
  真实 Markdown 解析器 + 图片比例、投递整批校验与暂停信源拒绝）。
- 剩下的部分大多服务于本站**关掉的 AI 模块**（模型榜、Codex 监控）或本站没有的入口
  （社区采集、X 搜索、embedding）；真正与本站有关的是「恢复链」与「会话绑定」两项安全/健壮性改动，
  应作为下一轮的独立工单，配合迁移与新测试整体评审。
- 迁移 0039-0041 涉及 `articles`/`story_digests`/`admin_sessions` 三张在用的表；按仓库规则，迁移只做
  向后兼容的增量，且要先在本机集群整库演练（`npm run db:up -- --port=xxxx` + `db:migrate` + 回滚验证），
  这类演练占用的是整台机器的资源，不适合与发布同批做。

## 2026-10-02 全站体检（第六轮）：三类真问题与两条刻意保留的口径

五个只读子智能体（机器出口逐条实测 / 后台与鉴权 / 1717 条公开内容核对 / 本机全栈从零起 / 桌面与移动
两轮真实浏览器）加上主控的修复与复验。修掉的三类：

1. **成刊快照会停在旧文案上**（日报版面、`/og` 分享卡、`<meta description>` 一起脏）。修法有两层：
   `reports/compose.ts` 的候选加**中文标题门槛**（中文报纸不印没人写过中文的标题）；`scripts/recompose-report.ts`
   按当前文案重排指定一期（默认 dry-run；旧版进 `report_revisions`，可回滚）。**下一轮遇到"改完文案对不对得上"，
   先查版面/OG/meta 这三处快照，别只看条目页。**
2. **列表层放行了没有中文稿的条目**（`/all` 曾出现 351 张英文卡片，全部动态总数 1829 → 1013）。
   `publication/items.ts` 的 `listedCondition` 现在要求标题含 CJK。**条目自己的页面保留**并在页顶如实说明
   （藏起真内容比少几条更糟）；它们在后台等待有人写中文，写完后自己回到列表。
3. **红线：一条事件提要留着它自己的报道里没有的数字**（洛亚蒂 M6.6 的「矩张量反演震级 6.7」、按旧成员数写的
   「三家机构」）。fixture 的 `guard` 当时是空的，所以没有任何一层能发现。已更正为两家目录各自给出的测定值，
   并**刻意不写成员机构数量**（本地与线上的成员集不同，写死数量必有一边错）。`composeStoryDigest` 新增
   `force`，且被 force 的重写会带 `attemptTag`——**没有它，回执缓存会把你想替换的那个答案原样还回来**
   （实测：重写"成功"而页面仍是 6.7）。工具：`scripts/rewrite-story-digest.ts`。

两条**刻意保留**的口径（别再当新发现重复调查）：

4. **指名一期空刊 = 诚实的空态（200），不是 404。** 这是上一轮的决定，并由
   `tests/publication.test.ts`「a named blank issue is an honest empty state, not a 500」钉住；列表、`latest`、
   feed、sitemap 一律不宣传空刊。**唯一的例外是 MCP**：`geohot_get_weekly/monthly` 遇到空刊直接报
   `not_found`（Agent 分不清"空壳"与"内容"）。
5. **fixture 的键要与 stub 真正读的一致**：digest 读 `reply.digest`，`reply.body` 是历史遗留（曾让"改过了"
   看起来没生效）。写完 fixture 先跑一次真实路径，别只看文件。

顺带记下这轮发现、暂未改的：

6. **`docs/manual.md` 的自检命令有两处已失效**（R6-B/R6-D 实测）：§11 的
   `POST /api/admin/feedback/1` 在**鉴权之前**就命中兜底 404（无处理器），因此它无论鉴权好坏都回 404，
   证明不了"后台锁着"——改用 `PATCH /api/admin/feedback/1`（无会话 401）或 `POST /api/admin/sources`（401）；
   §10 第 2 条说七个 monitor 端点没关，实际 `apps/api/src/routes/admin.ts:100-102` 已按
   `FEATURES.codexResetMonitor` 整体关闭（带会话访问也 404）。
7. **本机环境说明过时两处**：3001 现在是空闲的（manual 说被无关进程占着）；子路径本地形态还必须把
   `SITE_URL` 带上前缀（`.env` 里是 `http://localhost:3000`，不带前缀时 canonical/og:url/img-proxy 会逃出
   `/geohot`，smoke 61 项红）；**重建 web 之后必须重启 web**（`server.ts` 启动时 import 构建、静态文件按请求
   读盘，20:03 重建而进程还是 19:15 的旧构建 → 首页 12 个资源里 10 个 404）。
8. **`publishedAt=null` 的条目（49 条，SpaceMapper 人工投递）在卡片上只显示时刻**，没有日期；其中一条的
   `<title>` 是整段导语（超长）。属于展示层小课，留待下一轮（要把"无日期"的卡片样式与标题截断一起做）。
9. **后台会话 cookie 的 `Path=/`** 在 `xxc2007.me` 这种共域子路径部署下会送到主站（HttpOnly，只是卫生
   问题）；要收紧需要改 `admin/auth.ts` 与主站同域行为的验证，值不值得做由站长定。
10. **内容侧两条小账（已做显示层兜底，内容本身待编辑）**：`publishedAt=null` 的 49 条（SpaceMapper 人工
   投递）按设计回落到 `timelineAt`/`discoveredAt`，在按天分组的列表里只显示时刻（分组头给日期，是设计
   不是缺陷）；其中一条的"标题"其实是一整段导语（fixture 的 `titleZh` 写成了段落），页面正文照实显示，
   但 `<title>` / `og:*` 会因此变成几百字——`lib/seo.ts` 现在对元数据做通用截断（标题 60 字、描述 160 字、
   og alt 120 字），**只截元数据、不截正文**。那条 fixture 的 `titleZh` 应当由编辑改写成一句话标题。

---

## 第七轮（2026-10-03）：全面体检之后仍然开着的东西

这一轮由 10 份只读审计 + 1 轮真实浏览器 + 6 个实现智能体 + 编排者自己的安全簇组成。
下面这些是**审出来但没有在本轮关闭**的，写在这里免得下一轮重新发现、或误以为已经修好。

1. **综述标题的身份守卫只完成了一半**。`editorial/provenance.ts` 与 `events/digest.ts` 已经会
   用本事件报道构造 `enforceIdentity` + `looksZh`，但 `tooling/brain-stub.ts` 的 capability registry
   还没接上，所以 `tests/story-digest.test.ts` 里两条新测试是**带原因跳过**的（不是删除）：
   `a title naming an institution…` 与 `the version is taken under the story lock…`。
   后者对应的真实缺口：并发两次 `composeStoryDigest(force)` 仍可能算出同一个 `version`。
   影响面：事件标题目前全部来自人工 fixture，线上 0 条命中；这是加固，不是在堵现役漏洞。
   同一轮里还有三条**带原因跳过**的新测试，都是本轮读取层改动没走完的部分：
   `publication-issue-gate` 与 `rss-conditional` 那两条是同一个问题——**一条被报纸引用、但本站数据库里没有它的行的条目**
   （导入的历史刊期），订阅里该给它的原文地址还是什么都不给，实现与断言不一致；
   `publication-read-guards` 那条是夹具问题——组内只有一条成员时拿不到可篡改的游标，
   于是"游标里的 offset 不是 offset 要报 400"这条守卫（`groups.ts` 与 `stories.ts` 的 `isOffset`）在测试里没有可跑的输入。
   守卫本身在，缺的是把它跑到的那份夹具。
   曾经同批跳过的第七条（`/weekly` 在接口 5xx 时应说 503）在本轮收尾时**已经修好并重新纳入运行**：
   `report-latest.tsx` 原来只把 `ApiError 且 status>=500` 当作"读不到"，其它异常（网络失败、超时、
   测试里那种"不该发生的请求"）被 catch 静默吞掉，于是接口故障会以「还没有发布」的样子出现在 200 页面上。
   现在只有 4xx（"这一期确实不存在"）可以被无声跳过，其余一律记为读不到并抛 503 + `Cache-Control: no-store`
   ——不再依赖前面那台机器"非 200 改写 no-store"的行为。
2. **`/hot` 副标题的字面意思与内容不符**（像素审计）：写"过去 48 小时讨论最多的 N 个地理事件"，
   榜上事件的日期可以是 8 到 18 天前，且六条趋势全为 ↓。热度量的确实是 48 小时窗口（页脚 308 行有说明），
   但**改措辞属于站长的编辑口径**，没有替他改。建议改成"按最近 48 小时的讨论热度排序 · 事件本身可能更早"。
3. **只有一条时，日报把同一句话重复三遍**（10-03 实测：头条、今日看点 1、栏目 01 下都是同一标题）。
   数据是诚实的（"本期共 1 条入选动态"、"约 1 分钟读完"），但版式是为 20 条设计的。
   建议 `entries < 3` 时不渲染「今日看点」。**没有改，因为"薄到不出刊还是出薄刊"是站长的决定**。
4. **移动端点击区偏小**（390 宽实测）：分享/更多/收藏 32×32、返回 62×32、标签 77×26、排序下拉 97×32。
   全部满足 WCAG 2.2 AA 的 24px 下限，但低于 Apple/Google 建议的 44px。属于改版级工作，不在本轮范围。
5. **上游 2026-10-02 的五条改版只有一条有代码可移植**（A9 逐条核过）：`3343fe2`（事件进展可正序读）已并入；
   主题页编年史、模型榜评分改版、精选逐条一行、手机五标签在**上游公开仓库里没有对应提交**，
   只有 changelog 文案。所以本站没有声称"同步了这些"，也不该有人据此去找不存在的 diff。
6. **`reference/public-v1.openapi.json` 是上游随附的文档**（上游已到 2.1.0，本站线上服务的是 2.0.x 那份，
   并按 `FEATURES` 裁掉未启用的路径）。A8 在其中发现四处与实现不符（`q` 的 2–200 边界、
   `/dailies/{date}` 缺 `pattern`、`Problem` 未记 `retryAfter`、`/api/v1/*` 文档写了 403/429 而实际没有限流器）。
   本轮没有改这份 vendored 文档：改它要么是在替上游改文档，要么得先把它变成本站自己维护的正本，两件事都不该顺手做。
7. **`08:00–10:00` 的日报盲区是有意的**（`alerts.ts:69` 要北京时间 10 点之后才判 `report.daily`），
   给两次小时级补跑留余量；但 `catchUpReports` 自身失败不写日志（`apps/worker/src/schedules.ts`），
   所以"补跑试过了但失败"与"没试"在日志里长得一样。下一轮值得补一行日志。
8. **后台看不到"等人写中文标题"的队列**：读取层现在有一条共用的中文门槛（`chineseCopyCondition`），
   但后台没有对应的筛选项，运维只能靠 `scripts/refill-copy.ts` 的 dry-run 输出。本轮把门槛做成了结构性的，
   队列的可视化仍缺。
9. **写 `stories` 的测试文件必须调用 `purgeTagged()`**（本轮收尾时定下的规矩，违反过一次）。
   `npm test` 的 46 个文件共用同一个 `*_test` 库，而这个库活过一次运行：`events` / `signals` / `publication` /
   `geography-grouping` / `publication-read-guards` 五个文件只清 `articles` 与 `sources`，事件、事实、信号全留在库里。
   留下的事件在 48 小时窗口内仍然是热榜候选，而 `computeHotRanking` 只保留十条——10-03 实测累计到 12 条合格事件，
   `tests/hot-heat.test.ts` 因此查不到自己的夹具（`entry` 为 `null`）而报两条失败：它测的是代码，结果被"前面跑过几轮"决定。
   已修：`tests/setup.ts` 的 `purgeTagged()` 按 tag 收回事件宇宙（含级联的文章与信源），五个文件在 `after()` 里调用它；
   `hot-heat` 的夹具同时改成八家独立参与，使它在榜上必然排第一，不再依赖数据库干净与否。
   验收方式：空库连跑两遍 `npm test`，两遍都必须是 `fail 0`（只跑一遍证明不了不留垃圾）。
10. **`trend` 与 `rising` 徽章用的不是同一个门槛**（`events/hot.ts:132` 用 0.15，`:140` 用 0.1）：
   `pct` 落在 0.10–0.15 之间时趋势写着"涨"却没有 ↑ 徽章；`surge` 成立时也不给 `rising`（两个徽章互斥）。
   页面上的箭头来自 `trend`，所以读者看到的箭头是对的，徽章只是强调——**没有并成一个门槛**，因为"要不要给
   快速上涨的事件再叠一个 ↑"是视觉口径决定。`tests/hot-heat.test.ts` 的断言因此是**单向**的：出现 `rising`
   时趋势必须是 `up`，反向不成立。
11. **`tests/events.test.ts` 的模型桩只回答"本次查询自己的"候选**（2026-10-03 深夜修）。该文件的候选池是
   共享 `geohot_test` 库里最近 14 天的全部事实，词法召回的门槛只有 0.25——别的文件留下的一条短文本行就够
   越过它、甚至排在候选列表最前。旧桩无脑答「C1」，答案于是落到隔壁的事实上：同一条命令连跑两遍，
   "旧地址跳转"那条断言从 `new-story` 翻成 `same-fact`。现在桩先取查询块的标题，只答描述文本里带该标题的
   候选块（夹具标题要么是 16 位随机字母、要么带本轮 tag，外来行不可能命中），其余候选一律不答——
   `verdictsByFact` 把没答的算作 UNRELATED，判定因此与池子里还躺着什么无关。
   验收方式：该文件连跑两遍全绿；另用合成提示做过对照（旧桩答外来 C1、新桩答夹具自己那条）。
12. **`purgeTagged` 的早退让"只建文章与信源"的夹具从不清库；首页时间线断言因此按池子组成说话**（2026-10-03 深夜修）。
    `tests/setup.ts` 的清库函数在"这个 tag 没留下任何事件"时直接 `return`——`analyze-shutdown` 这类只写
   文章与信源的文件调用它等于没调用，每一轮留三条被精选的中文行（实测十轮 30 条）；`translate.test.ts`
   与 `translate-shutdown.test.ts` 根本不调用它，而夹具的 `discoveredAt` 刻意放在未来（好让
   `translatePending` 先拿到最新的），遗留行在首页时间线的锚点上排在所有后续测试之前。一天十几轮下来
   共享库里攒出 46 条未来锚点的精选行，`publication-copy-gate` 的"这条在首页上"断言开始按池子组成时红时绿
   （第 3、5 次连跑各红一次，单跑 10/10 全红）。已修：清库函数的源清扫不再早退；两个 translate 文件在
   `after()` 里调用它；`publication-copy-gate` 的首页断言按夹具自己的 tag 收窄（断言的是中文门槛，不是池子
   大小）。一次性清掉存量 50 篇文章 + 31 条信源；验收：单文件 10 连跑全绿、全套 235 tests 连跑两遍 fail 0，
   跑完池子里精选卡片归 0（这之前是 30–77 组）。

## 第九轮（2026-10-03 夜）：删掉两个分类之后仍然开着的东西

站长当晚第二次看首页筛选栏，要求把「考研」与「地理信息系统」换位、**彻底删掉**「野外与考察」与「观点与解读」。
下面是**做完之后仍然开着**的，逐条带证据。

1. **删分类真正的成本在库里，不在数组里。** 分类 `key` 进 URL（`/all?category=fieldwork`），也进了 `publications.category`、
   `analyses.category`、`editorial_overrides.fields->>'category'`、`sources.default_category` 四处。只从 `CATEGORIES`
   里拿掉一行，旧 key 就成了「不在词表里」的行：卡片角标空着、筛选栏点不到、RSS 分类订阅里查不到。所以这一轮
   配了迁移 `0041`——线上实测 `publications` 21 行（精选 8 条：comment 6 + fieldwork 2）、`analyses` 30 行、
   `editorial_overrides` 0 行、`sources` 0 行。**逐条映射**（21 行显式 VALUES 表）而不是一刀切进某个桶，因为这两个
   分类当年是**跨学科的兜底桶**（`fieldwork-L1` 是历史现场、`fieldwork-L2` 是人文、`comment-L5` 是海平面……），
   整桶搬进任何一类都会造出一批分类错的行。
2. **`selectbench_results` 刻意不迁。** 那是历史模型答题的存档（当年拿 `comment` 当正确答案的那批），改写等于
   伪造记录。它现在带着一个词表里没有的 category 值躺在库里——这是**有意保留的历史事实**，任何「全库扫一遍看有没有
   孤儿分类」的脚本都会把它当问题报出来，别修。
3. **`--rebuild` 会丢行，别拿它同步夹具。** `tooling/merge-corpus.mjs:851-853` 在 `--rebuild` 下把「非种子行且片段里
   没有同 id」的行**整条丢弃**——`tooling/fixtures/understand.jsonl:108-119` 那 12 行 `understand-en-*`（英文条目编译轮
   的成果）正属于这类。本轮同步夹具走的是手写脚本按 id 覆盖，不是 `--rebuild`。
4. **片段不总是比夹具新——这是本轮最贵的教训。** 一度按「answerKey 不同就以片段为准」批量同步，结果把
   `digest-loyalty-m66` 换成了旧版：HEAD 夹具的 `what` 明写着「2026-10-02 更正：删去在报道里核不到的『矩张量反演
   震级 6.7』」，而片段版又把它写了回去。已全部 `git checkout --` 回退（`tooling/fixtures/summarize.jsonl`、
   `understand.jsonl`、`digest.jsonl`、`group_pair.jsonl`、`tooling/corpus/curated-materials.jsonl` 五个文件），
   只留分类同步。`merge-corpus.mjs:854-862` 那道 rebuild 守卫存在的理由就是这个。
5. **`merge-corpus` 的既有账目没有变，退出码 1 不是回归。** 改动前后都是：`collision` 11 条（8 条 structure 同 id
   两份答案、另 3 条无关）、`shadowed` 1 条（`summarize-rx18` 被自己吞）、分级漂移 20 条（以 `sources.json` 为准）。
   夹具同步完成后 `node tooling/brain-stub.ts --lint` 的 **23 条 category note 清零**，剩下的 `fixturesWithProblems: 1`
   仍是既有那条 `understand-fill-mongabay-elnino-evidence`（身份守卫会退回），`tests/brain-fixtures.test.ts:105-117`
   明确允许这 1 条。
6. **`tests/exit-category-parity.test.ts` 里我加错了一条断言。** 第一版写了「板块顺序必须与词表位置单调一致」，
   实测红：板块顺序是 gis(geotech, 索引 5) → kaoyan-geo(geoedu, 6) → geopolitics(3) → histgeo(4)，**从来不是词表的
   投影，而是站长的编排**。改成只钉「`gis` 排在 `kaoyan-geo` 之前」+「`geotech` 在词表里排在 `geoedu` 之前」两条相对
   次序。以后要动板块顺序，改的是 `industry/boards.json`，不是去让词表迁就它。（**2026-10-04 追记**：板块层
   整块删掉了，`industry/boards.json` 与这个文件里那两条板块断言一起消失，只剩「`geotech` 排在 `geoedu`
   之前」那条分类次序的断言——见文末那一节。这一条当时犯的错照原样留着。）
7. **「实践」这一节消失，兜底分节跟着从「实践」挪到「技术」。** `reports/compose.ts:19-21` 用 `section` 字段的**首现
   顺序**建 `SECTION_ORDER`，再取 `at(-1)` 当「没有类别的资料」的兜底。`section` 从三节变两节，兜底就换了一节。
   **加新分类时不要再起第三个节名**，否则全站未分类条目会一夜之间搬进那一节——`tests/report-default-section.test.ts`
   与 `tests/exit-category-parity.test.ts` 把这条钉住了（后者连 `compose.ts` 的算式字符串一起断言）。
8. **`docs/manual.md:306` 与 `industry/prompts/selection-score.md:30` 里的「观点与解读」是内容类型不是分类。**
   `ITEM_TYPES` 里的 `opinion_analysis` 仍叫这个名字，`CATEGORY_TAGS` 里的「评论/解读」也仍在——删的是分类 key
   `comment`，不是这类体裁。同理 `tooling/corpus/corpus-fieldwork-*.jsonl`、`scripts/README-ingest.md` 的
   `"theme":"fieldwork"`、`industry/topics.json` 的 `fieldwork` / `opinion-analysis` 主题 slug 都是**另一层**，全部保留。
   以后全库 grep「野外与考察 / 观点与解读 / fieldwork / comment」会命中这些，别顺手删。
9. **README 的三张配图当晚已按新筛选栏重拍**（`node scripts/shoot.ts --base https://xxc2007.me/geohot --out docs/shots`），
   因为首页筛选栏从九个格子变成七个、且「地理信息系统」挪到了「考研」前面。`scripts/check-shots.ts` 守图。
10. **`/changelog` 在 390px 会横向溢出——已修，但根因值得记住。** 某条 release note 里引了一个真实路径
    `packages/backend/src/reports/compose.ts:135`，那是一整段不可断行的拉丁串；装它的 `span` 是 flex 子项，
    `min-width:auto` 解析成 min-content = 364px，390px 屏幕放不下，实测 `scrollW=400 clientW=390`。
    `apps/web/app/routes/changelog.tsx:50` 改成 `wrap-anywhere` 后 `scrollW=390`。**注意 `break-word` 与
    `min-width:0` 单独用都不行**（实测仍是 400），只有 `anywhere` 能收缩 min-content——因为 changelog 的
    正文会引用路径，这个类在这里是承重的，不是装饰。
11. **浅色 `--ink-4` 从 `#657176` 加深到 `#616d72`（AA 修复）。** 全站 1888 对颜色采样里只有一对不过 AA：
    `/daily` 左栏**选中**日格的「周六」（`apps/web/app/features/report/ReportNav.tsx:94`）——那一格背景是
    `bg-accent-soft`（`rgba(23,107,117,0.08)` 叠白 = `rgb(236,243,244)`），旧值在其上 **4.483:1**，差 0.017。
    新值实测 **4.755:1**（真浏览器量得，见 `.round9/probe-ink4d.mjs`）；纸上仍是 4.9:1，暗色 `#89979d` 在同一格
    本来就 4.737:1，未动。`app.css:136-139` 与 `:175-183` 记着同类先例（`--daybar` 与 `--rank-*` 都因对比度
    调过），所以「加深 token 并注明实测比值」是本文件既定做法。**降 `accent-soft` 的 alpha 修不了这一条**——
    实测 0.06/0.05/0.04 注入后仍是 4.483。
12. **本地开发用 `127.0.0.1` 访问会报 React 水合不匹配，用 `localhost` 不会——这不是生产缺陷。**
    `apps/web/app/lib/seo.ts:18-21` 的 `siteUrl()` 服务端读 `process.env.SITE_URL`、客户端用
    `window.location.origin + basePath`。本地 `.env` 的 `SITE_URL=http://localhost:3000`，所以从
    `127.0.0.1:3000` 打开时两边的 JSON-LD（`organizationLd()` 的 `url`/`logo`）不同，React 报
    `A tree hydrated but some attributes of the server rendered HTML didn't match`，指到那个
    `<script type="application/ld+json">`——**JSON-LD 是 React 修不了的一类**。实测：`127.0.0.1` 3 个错误、
    `localhost` **0 个错误**。线上 `SITE_URL=https://xxc2007.me/geohot` 与 `window.location.origin + basePath`
    算出同一个值，所以线上不会出现。**别为它加 `suppressHydrationWarning` 或改 `siteUrl()`**：那个设计是
    故意的，注释里写着原因（`window.location.origin` 单独用会把子路径部署的 canonical 指到邻居站点）。

## 第十轮（2026-10-04 上午）：主题层跟着分类层一起删，以及这一轮查出来还没改的

第九轮只动了**分类层**（`industry/taxonomy.ts` 的九个 key 与迁移 `0041`）。站长随后指出：`/topics` 这一层还留着
两个和已删分类同名/近名的主题页——`/topics/fieldwork` 的 h1 就是「野外考察」、`/topics/opinion-analysis` 是
「观点与解读」，线上同样 200，读者会以为分类根本没删。站长的裁决是**删掉这两个主题页**，不是改名。

1. **主题层的 `key` 是 `slug`，删它要配迁移。** `seedTopics()`（`packages/backend/src/publication/topics.ts:78-93`）
   是 `INSERT ... ON CONFLICT (slug) DO UPDATE`，**只 upsert 不删除**：只从 `industry/topics.json` 里拿掉两条，
   已有部署的 `topics` 表里那两行会原地留下，`/topics` 目录仍在、`/topics/<slug>` 仍 200——正是要消灭的状态。
   所以配了 `database/migrations/0042_drop_fieldwork_and_opinion_topic_pages.sql`：`DELETE ... WHERE slug IN
   ('fieldwork','opinion-analysis')`，外加两条 `array_remove(related, ...)` 清反向引用。新部署不受影响（迁移先于
   seed，此时表还空着），老部署靠这条 DELETE 收敛。
2. **改 `topics.json` 用的是按行文本操作，不是 `JSON.parse` → `stringify`。** 该文件是 CRLF + 两空格缩进 +
   数组元素各占一行；`stringify` 会把每行末尾的 `\r` 抹掉，实测首行就 diff，等于一次全文件重排（4973 行的假 diff
   会把这次真正的改动淹掉）。行操作只动该动的行：删 2 个对象块 + 6 处 `related` 元素行，`git diff --stat` 是
   **2 insertions / 41 deletions**。
3. **被清的 6 处反向引用**：`qinghai-tibet-plateau`、`osm`、`landforms`、`ecosystems`、`satellite-navigation`、
   `exploration-reports`（`opinion-analysis` 没有被谁反向引用）。读取层本来就会对取不到的 slug 静默过滤
   （`topics.ts:212` 的 `topics.find(...)` + `filter`），所以不修也不会显示出坏链接——但表里会存一个不存在的主题
   引用，下次有人按表排查会困惑。
4. **旧 URL 的 404 是既有的，不用写新代码。** `apps/web/app/routes/topic.tsx:27` 走 `loadOr404` →
   `/api/site/topics/:slug`（`apps/api/src/routes/site.ts:188-194`）→ 行不存在即 404 → `loadOr404`
   （`apps/web/app/lib/api.server.ts:70-87`）把它映射成路由 `data({message:"not_found"},{status:404})`。
   `/og/topics/*.png`（`apps/api/src/routes/og.ts:115-120`）与 `/sitemap.xml`（`packages/backend/src/publication/
   topics.ts:122-160` 的 `topicPageCounts()`）同样按表取行，行删掉就一起消失。
5. **以下五层刻意不动，别顺手删。** ① `selectbench_results` 等基准存档里的 `fieldwork` / `comment` 是**历史答题
   记录**，改写等于伪造；② `tooling/corpus/corpus-fieldwork-*.jsonl` 与材料里的 `"theme":"fieldwork"` 是**语料表名**；
   ③ `industry/taxonomy.ts` 的 `ITEM_TYPES` 里 `exploration_report` / `opinion_analysis` 是**内容类型**（渲染成
   「考察/发现记」「观点与解读」），与主题页重名的只是中文标签；④ 历史成刊的 `reports.content.sections[].label`
   是写死的快照（`daily 2026-10-03` 那期只有 1 条入选、且那条在库里 `category=null`，所以落进了旧词表的兜底节
   「实践」；见第九轮第 7 条，**不重排**——`recentlyCovered("daily", before, days=7)` 会把更早 7 天的成刊条目算作
   「已覆盖」，重排 10-03 会让 10-04 那期排除掉这唯一一条）；⑤ `industry/topics.json` 里 `satellite-navigation`
   definition 的「野外考察」是自然用词，不是分类名。
6. **主题数 45 → 43，文档计数跟着改**：`docs/manual.md:267`、`docs/migration.md:197`、`docs/migration.md:237`、
   `docs/deploy.md:52`。`tests/industry-vocabulary.test.ts:191-213` 只断言 `topics.length > 0`（不写死 45），
   所以删两条主题不会让测试红——**这也是个隐患：没人拦着主题表被删空**。
7. **`apps/web/app/routes/topics.tsx` 与 `industry/topics.json` 里的分组说明是两份**（第九轮「两处地理文案没回到
   `industry/`」那条的延续）：`field` / `genre` 两组的 blurb 在这个文件里各抄了一份常量，所以改文案要同时改两处，
   否则 `/topics` 页面与 JSON 讲的不一样。本轮两处都改了（「地理信息技术与野外考察」→「地理信息技术与空间数据」、
   「考察记录与影像图集」→「技术发布与影像图集」）。
8. **这一轮做完之后仍然开着的设计问题（已定位、未改，逐条带实测）**：
   - **筛选栏在 1024 / 768 / 390 被裁切，而且滚动条被自己藏掉了。** `apps/web/app/components/ui/Tabs.tsx:105` 是
     `scrollbar-none max-w-full overflow-x-auto`，`scrollbar-none`（`apps/web/app/app.css:319-324`）把唯一的视觉
     线索也去掉：1440px 看得全 9 项，1024px 丢 3 项、390px 丢 5 项，读者不知道右边还有东西。
   - **`/about` 版权块是全站唯一一行 66 个汉字的段落。** `apps/web/app/routes/about.tsx:278` 的
     `p.mt-16.well.rounded-card` 漏了 `measure`（`apps/web/app/app.css:382` 已定义这个类），加上即降到约 40 字/行。
   - **筛选 tab 与日期折叠按钮的焦点环起步颜色是灰的。** 全站只有一条 `:focus-visible` 规则
     （`apps/web/app/app.css:268-270`，`outline: 2px solid var(--accent)`），但 `Tabs.tsx:124` 的
     `transition-colors duration-150` 让 `outline-color` 从 `currentColor` 起步过渡：真 tab 聚焦后
     **0ms 读到 `rgb(89,101,107)`、320ms 才读到 `rgb(23,107,117)`**；没有 transition 的卡片标题链接 0ms 就是 accent。
   - **`/daily` 左栏「往期」标题加载失败时，读屏用户拿到零信息**：`apps/web/app/features/report/ReportNav.tsx:75-78`
     的错误分支没有 `role="alert"` / `aria-live`，是全轮唯一「触发就静默」的可访问性问题。
   - 其余较轻：`/boards` 导语 56 字/行（`apps/web/app/routes/boards.tsx:38-41`）、`/changelog` 段落 47 字/行
     （`apps/web/app/routes/changelog.tsx:50-55`，`max-w-[52em]` 在 13.5px 下不是 52 字）、首页分节间距
     `lg:mb-1` 只有 4px（`apps/web/app/features/feed/Timeline.tsx:295`）、搜索框焦点态与全站实线环不是一套语言
     （`apps/web/app/features/feed/Filters.tsx:128`）、`/more` 页脚 RSS 热区 22×18px、`/daily` 手机端
     「日报合订本」热区 60×15px。
9. **三条探针假阳性，别照着改。** ① 「筛选」重复地标名是假的：CDP `Accessibility.getFullAXTree` 实测 1440px 只有
   `[主导航, 筛选]`、390px 只有 `[底部导航, 筛选]`，**改成 `opacity-0` 隐藏反而会真的产生两个同名地标**；
   ② 47 个 `<header>` 来自 `apps/web/app/features/feed/FeedItem.tsx:33` 的卡片头，作用域在 `<article>` 里、不进
   无障碍树；③ 390px 下「7 条 21px 小热区」也是假的——`FeedItem.tsx:69` 的整卡点击层 `after:inset-0`，
   `elementFromPoint` 证实实际可点区域是 310×207。**教训：量热区要量最上层可点元素，不是量 DOM 顺序里第一个 `a`。**
10. **同一天下午，上面第 8 条里的界面问题逐条改完了**（改动都在 `apps/web/app` 内，`npm run typecheck` 两次 exit 0，
    真实浏览器回归 8 页 × 4 视口 `bad: []`、横向溢出全为 0）：
    - **筛选栏遮罩。** `apps/web/app/components/ui/Tabs.tsx` 加了 `scroller` ref + `fadeRight` state，`useLayoutEffect`
      里量 `scrollWidth - clientWidth - scrollLeft > 1`，挂 `scroll`(passive) 与 `ResizeObserver`（同时观察容器与
      `el.firstElementChild`），条件类在地整个 `[mask-image:linear-gradient(to_right,#000_calc(100%_-_28px),transparent)]`。
      实测隐藏量 1440px `0`（mask 不挂）/ 1024px `254` / 768px `108` / 390px `358`，1024px 滚到最右 mask 回到 `none`；
      1440px 两组 A/B 截图逐像素相同。注意 Tailwind v4 任意值里空格要写 `_`。
    - **`/about` 版权块**（`apps/web/app/routes/about.tsx:278`）选择**直接加 `measure` 到 `<p>` 上**而不是内包
      `<span>`：包 span 会让灰底撑满 1204px、文字只 546px，右侧留一大片空白更怪。实测最长行 66 → 34 个汉字。
    - **焦点环起步色是灰的**（`Tabs.tsx:124` 与 `Timeline.tsx:68`）：两处插入 `outline-accent`，实测 0ms 就是
      `rgb(23,107,117)`（改前 `rgb(89,101,107)` / `rgb(97,109,114)`），350ms 不变。机制是 `transition-colors` 的过渡
      属性集含 `outline-color`，未聚焦时解析成 `currentColor`，无条件声明环色后就没有可插值的起点。
    - **`/daily` 往期标题加载失败读屏零信息**（`ReportNav.tsx:75-81`）：把裸 `<button>` 包进 **`<div role="alert">`**，
      `py-1` → `py-2`。**刻意不给 button 本身加 `role="alert"`**（会盖掉 `button` 角色、吃掉「点此重试」）。CDP
      `Accessibility.getFullAXTree` 实测两个角色都在，按钮盒 187.5×34.8（改前约 21px 高）。
    - 行长与热区：`/boards` 61→40 / 57→42 字（`boards.tsx:38`/`:62` 加 `measure`）；`/changelog` 48→42 字、超 42 字的
      段落 14 → 0（`changelog.tsx:55` 的 `max-w-[52em]` 换 `measure`，**`wrap-anywhere` 原样保留**，它是 390px 防横向
      滚动的承重类）；首页分节间距 `Timeline.tsx:295` 的 `lg:mb-1` → `lg:mb-3`（4px → 12px）；`/more` 页脚四个链接加
      `inline-flex min-h-6 items-center px-1.5`、`/daily` 手机端「日报合订本」加 `inline-flex min-h-6 items-center`，
      实测 `/more` 60×24 / 60×24 / 33.7×24（改前 48×18 / 48×18 / 21.7×18）、`/daily` 390px 60×24（改前 60×15）。
    - **搜索框焦点态统一到全站实线环**（`apps/web/app/features/feed/Filters.tsx:128` 桌面、`:97` 手机）。理由：全站焦点
      语言由 `app.css:268-272` 的 `:focus-visible { outline: 2px solid var(--accent) }` 定义，而**后台输入框
      `apps/web/app/features/admin/ui.tsx:183` 早就写了 `focus:ring-2 focus:ring-accent`**，所以站内已有先例、这不是新
      语言；键盘用户 Tab 过筛选栏 10 格落到搜索框会以为焦点丢了。改法是**保留软光环再叠实线环**：桌面
      `focus:ring-accent` → `focus:ring-2 focus:ring-accent`；手机（input 外层本就有 `border-line-strong`，环不外缩会
      压在边框上）加 `focus:ring-2 focus:ring-inset focus:ring-accent`。`outline` 仍是 `none`——焦点指示由 ring 承担。
      实测两个变体都读到 `rgb(23,107,117) 0px 0px 0px 2px inset` + `rgba(23,107,117,0.08) 0px 0px 0px 3px`，与筛选栏
      第一格的 `solid 2px offset=1px` 是同一套颜色与粗细。**其余 6 处 `outline-none` 不动**：`root.tsx:170` 的跳转锚点、
      `Faces.tsx:114`（已用 `focus-visible:ring-2`）、`admin/ui.tsx:183`（已是 2px）、以及后台与低频表单控件
      `feedback.tsx:153` / `admin-login.tsx:53` / `Controls.tsx:43`。
    - **两条刻意不改，别当漏改。** ① 筛选 tab 的 `outline-offset:1px` **是承重的**：轨道上下余量各 3px，offset 1px 时
      环 `reach=3` 不裁切，offset 2px 上下各裁 1px、3px 各裁 2px（`overflow-x:auto` 让 `overflow-y` 也算 auto）；
      ② 搜索框的 `focus:shadow-[…var(--accent-soft)]` 软光环保留，只是在上面叠了实线 ring。
11. **这一轮给界面新增了一处运行时依赖面**：`Tabs.tsx` 的 `ResizeObserver`。`PillTabs` 有 9 个调用方
    （`all.tsx:106`、`story.tsx:292`/`:383`、`agent.tsx:283`、`item.tsx:445`、`ReportNav.tsx:12`/`:119`、
    `Filters.tsx:44`、`BoardTabs.tsx:11`），未做压力测试排除 `ResizeObserver loop` 告警；SSR 期
    `useLayoutEffect` 不执行，所以 1024px 首屏水合前那一帧没有遮罩（可接受；若要 SSR 直出得改成纯 CSS 容器查询）。
    另外 `measure` 的 `42em` 相对元素自身 font-size，三处实测宽 546 / 525 / 567px，行长在 34~42 字浮动。

## 第十一轮（2026-10-04 中午）：状态码全绿，而行为是错的

这一轮的起点不是「哪里报错」，而是「哪里都对，但站上没东西」：第十轮上线后 `/daily` 一直停在 10-03，每天
900~2300 条进料却**一条精选都选不出来**。查下来根因不在模型、不在配置、不在数据库，而在**一个从
2026-10-01 16:17 起就没重启过的进程**。

1. **`geohot-brain` 在跑十几天前那份代码。** `systemctl show geohot-brain` 的
   `ActiveEnterTimestamp=Thu 2026-10-01 16:17:40 CST`、`ETIME 2-18:59:01`、`MainPID=503352`，
   而 `tooling/brain-stub.ts` 在 10-02 与 10-03 各被改过一次。Node 在启动时把
   `brain-stub.ts` **整个读进内存**，它只按 mtime 热读 `industry/taxonomy.ts`、`industry/prompts/**`
   与 `tooling/fixtures/**` —— 也就是说**数据和程序是两套加载路径，只有数据热更新**。这正好制造了
   最容易被误判的假象：`curl :3055/healthz` 报的 `categories` 早就是七键（taxonomy 热读了），
   于是「改了词表就生效」让人以为整个 stub 都是热的。**真正决定性的是 journal 里那行启动日志**：
   旧进程打的是 `[brain] 能力 13 个，锚点 221 条，词表 categories=[physical,human,regional,geotech,fieldwork,comment] itemTypes=[…]`
   —— 六键旧词表，连 `geopolitics`/`histgeo`/`geoedu` 都没有；重启后同一行变成七个 key。
   **查「进程在跑哪份代码」要看进程自己启动时说的话，不要看它在响应的那些热读值。**
2. **旧进程造成的实际损害：`summarize` 的缺稿默认值。** `f35da0a`（2026-10-02 20:04）把
   `BRAIN_SUMMARIZE_DEFAULT` 的默认值从 `condense` 改成 `empty`（`condense` 会把**英文原标题原样
   写进 `title_zh`**、把英文正文机械截断写进 `summary_zh`，也就是「中文站上出现整条英文的卡片」那次
   事故的成因），`c9f893b`（2026-10-03 11:45）又把中文门槛做成结构性的 —— **两次都只改了文件，没人
   重启那个进程**。所以线上一直在跑 `condense`：`__brain/log?capability=summarize` 的 `rule` 全是
   `rule:condense`。生产库实测的污染面：`analyses.title_zh` 纯拉丁文累计 **1430 条**（10-01 513 /
   10-02 164 / 10-03 483 / 10-04 270）；其中 **1280 条**落成了 `publications.title`。
   **`packages/backend/src/publication/publish.ts:173-177` 是放大器**：`zhTitle` 有值就直接当标题用，
   **不检查它是不是中文**；真正兜住的是列表侧的 `chineseCopyCondition()`（`items.ts:86-89` 的
   `p.title ~ '[一-鿿]'`），所以 1280 条里只有 4 条漏进精选。
3. **判据不能用 mtime，要让对方自报内容哈希。** 第一反应是比「源码文件 mtime」与「进程启动时刻」，
   但 `git archive` 会给整棵树每个文件盖上**提交时刻**：整包升级之后源码 mtime 必然晚于进程启动时刻，
   这个判据每次部署都会误报。改成让 brain 自己算：`tooling/brain-stub.ts` 里
   `const SOURCE_PATH = import.meta.filename;` + `createHash("sha256").update(readFileSync(SOURCE_PATH))`，
   在 healthz 的 `source` 段报出 `{ path, sha256, startedAt, pid }`。**自报比外部推断稳**：它说的是
   「我这个进程加载的是哪份文件、内容哈希是多少」，与部署方式无关。
4. **`verify-deploy.sh` 新增两条断言，让「跑旧代码」变成硬失败。**
   ① healthz 的 `source.sha256` 必须等于磁盘 `tooling/brain-stub.ts` 的 sha256，不等就 `bad`，坏消息
   里直接写「必须 `sudo systemctl restart geohot-brain`」；② `defaults.summarize` 必须是 `empty`
   （引 `brain-stub.ts:32-41` 记的那次事故）。**抽不到 sha256 或读不到文件时只 `note` 跳过**，不把整
   脚本判红 —— 与文件里既有的 baseline 容错风格一致。踩坑：healthz 的 JSON 是 `"key": value`
   （**冒号后有空格**），`grep -o '"categories":\['` 这类无空格正则全部落空，要先 `tr -d ' \n'`。
5. **`DEPLOYMENT.md` 缺的正是这一类。** 原来的「热更新：改了什么就重启谁」只写了
   `industry/changelog.json` 要重启 api、`tooling/fixtures/**` 不用重启任何单元，**没有任何一条覆盖
   「改了 `tooling/*.ts` 这种进程内代码」**；整包升级那步的注释还写着 `# brain 没动就不重启`，而
   `brain-stub.ts` 本身每次都在改动集里。现在补了一条并给了一句记法：`apps/`、`packages/` 里改的是
   「被 import 的模块」，重启才重读；`industry/**`、`tooling/fixtures/**` 是「运行时按 mtime 热读的
   数据」，不重启也对；**而 `tooling/*.ts` 不属于后者，它是程序本身**。整包升级那行改成四个单元全重启。
6. **这一轮自己踩的假阳性（写下来免得下次再犯）：`/item/<id>` 不存在。** 我用单数路径去 curl
   那 4 条非 CJK 精选，拿到四个 404，差点定成「sitemap 收录了 404 的 URL」这个大问题。实际上 sitemap
   里发的是 `/items/<id>`（复数，`sitemap.ts:115` 的 `` `/items/${it.id}` ``），**四个都 200**。
   教训：**自检脚本里手写的 URL 形状必须从路由表或生成端抄下来，别凭记忆拼**；先看 sitemap 里那一行
   到底长什么样，再决定拿什么去 curl。
7. **`/api/v1/selected/snapshot` 与站上列表的口径差 4 条（还没改）。** 生产库实测：
   `selected_ledger` 73 行、`selected_state.in_set` 里快照返回 **57** 条，而站上列表口径
   （`selectedCondition()`，含中文标题闸门）是 **53** 条 —— 差的就是上面那 4 条纯英文标题的条目。
   原因在读取路径：`/api/v1/items?mode=selected`（`v1.ts:49`）走 `selectedCondition()`，**闸门在**；
   而同步接口 `selectedSnapshot()`（`v1.ts:130-175`）读的是 `selected_ledger` 里物化的载荷，**只应用
   发布闸门 `effectiveWatermark()`、不应用中文标题闸门**。于是「读者看得见的精选」是 53 条、「机器读
   得到的精选」是 57 条。**要不要让同步出口也过中文闸门是个产品裁决**（同步给的是「编辑选了什么」，
   与「现在能不能在页面上读到」不必然是同一件事），所以本轮只记录不改。
8. **brain 重启后那 1430 条历史污染没有回填，这是刻意的。** 它们的 `analyses` 行已经是冻结的分析结果，
   而标题已经写进 `publications`；重跑要么改历史快照，要么让同一篇文章在时间线上换标题。真正兜住读者
   的是列表侧的 CJK 闸门（见第 2 条），所以这 4 条读者可见的英文标题条目**留在站上是已知的、有意的
   结果**，不是漏改。要清就得走 `scripts/refill-copy.ts` 那条路并接受历史 revision 变化。
9. **重启之后的观察窗口还没到。** 重启（`MainPID` 503352 → 596024，`defaults.summarize` 从 `condense`
   变 `empty`）之后 `created_at > 2026-10-04 11:20+08` 的 `analyses` 是 **0** 条 —— 下一轮采集才看得出
   效果。**「修好了」这句话在这一轮只能说「进程加载的代码对了」，不能说「精选恢复了」**：恢复取决于
   新一轮分析跑完之后 `title_zh` 是不是中文。验收口径应该隔一轮再看 `analyses.title_zh` 的拉丁占比。

## 第八轮（2026-10-03 傍晚）：四个板块上线之后仍然开着的东西（板块层已于 2026-10-04 整块删除）

这一轮做的是"加考研 / 地理信息系统 / 地理与政治 / 地理与历史四个板块 + 信源扩容 + 信息密度"。下面这些是
**做完之后仍然开着**的，逐条带证据，免得下一轮重新发现或误以为已解决。

> **2026-10-04 追记：板块层已经删掉了，这一轮的四条里前两条半换了承载、后两条半随功能一起消失。**
> 站长看着 `/boards` 那一页判定它与主题页、筛选栏的分类重复，要求整块删除（详见文末那一节）。逐条对照：
> 第 1、2 条讲的其实是**信源结构与读取层的中文闸门**——英文源进不了任何列表、考研方向只有一条源，
> 这两件事在删除之后**依然成立**，只是不再有板块那条「来源原文」栏来暴露它们，读者现在在
> `/all?category=…` 的分类层看同一批条目；第 3 条（板块页没有后台视图与 MCP/RSS 出口）和第 8 条的 ③
> 不是被修好的，是**连同功能一起删掉的**——`/api/site/boards` 这个只有页面在用的私有接口已经不存在，
> 这条待办因此关闭，不要再去找它。

1. **英文源在板块的「来源原文」栏里一条都出不来。** 读取层的中文闸门（`chineseCopyCondition`）要求标题里有
   汉字；shipped stub 对没有人工稿的材料回答空值，而"回落到来源自己的中文标题"只对中文源成立。结果：The Diplomat、
   Foreign Affairs、OGC、QGIS、LOC 这些英文源在本地实跑里**有 published 行、但进不了任何列表**（实测新分类下
   114 行里 0 行带汉字）。这不是 bug（宁可不发布），但意味着**四个板块的"来源原文"栏目前只有中文源供得起**
   （研招网、对话地球、澎湃）。要它们出得来，只有两条路：给人写中文稿，或给"来源原文"这条通道一个明确的
   规则化标题策略——后者是站长的口径决定，本轮没有替他定。
2. **考研板块只有一条源。** 研招网政策与规定（80 条按标题白名单留 43 条政策文件）。其余候选（中国教育在线、
   知乎专栏、chinakaoyan）要么前端渲染没有服务端列表、要么 403，`docs/sources.md` 里点名记了。
   **地理与历史三条源里两条是英文**，同样受第 1 条限制。
3. **板块页没有后台视图，也没有 MCP/RSS 出口。** `/api/site/boards` 只有页面在用；运营看不到"哪个板块的
   来源原文在涨"，agent 也只能读 page 级接口。上一轮记的"后台看不到等人写中文标题的队列"仍然成立。
4. **上游 issue #86 的年龄截断没有照抄。** 上游把"首次导入的条数/时间过滤只在 `firstImport` 里"当成根因并
   建议 14 天截断；本站的口径不同（刻意跨轮补读更旧的历史，见 `collect.ts` 的 `listingTailAfter`），照抄会
   违背"采集不再静默丢历史"。本站只收了它另一条：无日期条目不再当今天（`decideTimeline` 的 `undated`）。
   **仍然开着**的是：带日期但迟到 >48h 的条目会按 stale-on-discovery 归档——这是设计，但"迟到多久算历史"
   这个阈值（48h）没有随信源扩容重新评估。
5. **这四条板块与信源不是"上线了再观察"的开放问题——它们已经上线。** 2026-10-03 19:36 部署，
   同日 19:45 又发了一版修复（条目页「事件后续」的 404 死循环，见 `industry/changelog.json` 最新一条）；
   `verify-deploy.sh` 全绿、线上 smoke 全绿。上线时踩到并记下的两件事：① 老 app 目录的父目录是 root
   所有，`react-router build` 要 rmdir 旧构建时报 `EACCES`——`sudo chown -R geohot:geohot /opt/geohot/app`
   之后正常（已写进 `deploy/geohot/DEPLOYMENT.md`）；② 上线当晚热点榜是空的，查过不是回归——48 小时
   窗口里没有任何事件达到「两个独立参与方且至少一个是编辑类」这条门槛，窗口内 2639 个事件只有 24 个参与方
   （预警各自成单来源事件），往前 48–96 小时那个窗口里有 6 个合格事件。榜空时首页的「当前热点」条
   一起消失，这是既有设计。
   > **2026-10-04 追记：最后那半句作废。** `c9e1122` 把这块改成"榜空也说实话"——首页在榜空时显示一行
   > 「过去 48 小时还没有两家以上信源同时讨论的事件。」加一个指向 `/all` 的入口（`apps/web/app/features/feed/HotTopics.tsx`
   > 里 `entries.length === 0` 那一支）。**同一目录 `packages/backend/src/events/hot-read.ts` 的读法在当天下午又改了一次**
   > （`3f7974f`）：空榜不再被发布（`hot.ts` 只在有条目时写 `published`），读侧取 **24 小时内最近一张有事件的榜**，
   > 标题旁标「截至 X 时」，超过 24 小时才回到上面那行诚实说明；`loadHotStrip()` 返回 `null` 的判据也随之变成
   > 「`hot_rankings` 整表一行都没有」（本机刚迁移完的库就是这种状态）。**这里不写行号**，那几天这几个文件一直在动，
   > `grep -n "export async function loadHotStrip\|MAX_BOARD_AGE_HOURS" packages/backend/src/events/hot-read.ts` 现查。
   > 回头看，"这是既有设计"把两件事混成了一件：`entries.length < 3` 整块隐藏是**实现选择**，而这几周榜之所以为空是
   > **归并步骤没在跑**（新代码的注释把这两条都写下来了）。介绍页据此把"实现藏了整块"写成"数据恰好为空"，
   > 是同一条错误叙述的下游——已随本轮改正，那一版说明的原文与错在哪都记在 README 首页那张图的说明里，不抹掉。
   > **另外那两个数（2639 个事件 / 24 个参与方 / 6 个合格事件）属于线上库**，本机开发库按同一窗口口径复算对不上，
   > 别拿本机复现（README 的 `/hot` 图说明已补上这一句环境说明）。
6. **纪律记录（我自己的错）：** 本轮往 `docs/sources.md` 追加中文小节时用了一次 shell heredoc，违反了自己
   立的"中文文件只用 Edit/Write"的规矩。内容事后逐行核对过没有乱码，但这条执行纪律要守住——再犯就可能
   在编码转换里悄悄改坏正文。
7. **README 的三张配图要在部署之后重拍。** 侧栏这一轮多了一个「板块」入口，三张线上截图（首页/热点榜/
   日报头版）因此与仓库里的这一版不再逐像素一致；但**线上当时还没有板块**，提前重拍反而是拿本地去冒充线上。
   **已解决：** `92131da` 于 19:35–19:37 按线上重拍三张并改说明；当晚分类合并（地理信息技术 + 地理信息系统
   → 地理信息系统）改了首页筛选栏，20:18 又把首页图按线上重拍一次（热点榜/日报两张不受影响）。
   重拍命令：`node scripts/shoot.ts --base https://xxc2007.me/geohot`；`scripts/check-shots.ts` 守图。
   这也是 `docs/manual.md:429` 那条"线上才是事实来源"的直接后果。
8. **独立审计补上了，它的结论与仍未关掉的三件事。** 额度恢复后一位只读审计智能体逐条对代码找反例：
   **无 BLOCKER**；1 条 MAJOR（"无日期≠今天"只在事件/推送/日报生效、`/all` 仍按发现时刻分组）已按
   「今日计数排除历史回填 + 无日期条目单列一节」修掉；板块两条线漏掉的 `p.eligible` 已补（含计数），
   并加了回归测试；解析器"空标签 + 有值"那类形状、后台缺的默认分类输入、以及一批口径（徽章、注释、
   「当天」措辞）一并处理，逐条写在 `industry/changelog.json` 的最新一条里。**仍未关掉**的是审计点到的
   三件小事与一件新决定：① `docs/manual.md:372` 与 `:377` 那几处"自检命令/环境说明过时"是更早的已知项，
   本轮没动；② 「无发布日期」这一节是新加的界面元素（站长的编辑口径可以再改：隐藏、还是就地标注）；
   ③ 板块页仍没有 MCP/RSS 出口与后台视图（第 3 条；**2026-10-04 随板块层整块删除而关闭**，不是补上了出口）；
   ④ 上游 issue #86 的 14 天年龄截断仍然没有照抄
   （第 4 条的口径不变）。

## 2026-10-04（下午）：板块层按站长要求整块删除——删了什么、没动什么、还剩什么

站长看着 `https://xxc2007.me/geohot/boards` 说：「这个板块功能有点重复了，请你删去这个功能。」重复是实的：
板块页按学科与用途把当天的条目归到一处，而主题页（`/topics`）与首页筛选栏的分类层做的是同一件事；四个方向
（地理信息系统 / 考研 / 地理与政治 / 地理与历史）本来就都在分类层里，删掉这一层不丢入口。**决定是整块删干净**
——不是隐藏、不是改名、不是留一个空壳页面。

删掉的（代码 / 数据 / 测试）：

- 前端路由 `apps/web/app/routes/boards.tsx`、`apps/web/app/routes/board.tsx`，与 `apps/web/app/routes.ts` 里
  那三条注册（`/boards`、`/boards/:slug`、`/boards/:slug/page/:page`）。
- 侧栏那一格「板块」入口与 `MORE_PATHS` 里的对应项（`apps/web/app/components/shell/nav.ts`）。
- 读取层 `packages/backend/src/publication/boards.ts`（`listBoardDefinitions` / `boardCounts` / `viewBoard` /
  `BOARD_PAGE_SIZE` / `BOARD_INDEX_PER_SOURCE`）。板块只是分类的视图，**没有自己的表、没有自己的可见性规则**，
  所以删它不动任何数据。
- 私有接口 `GET /api/site/boards` 与 `GET /api/site/boards/:slug`（`apps/api/src/routes/site.ts`）。它们从来
  不在公开 API（`/api/v1`）里，也不在 RSS 与 MCP 里，所以这次删除没有破坏任何对外的接口承诺。
- 数据文件 `industry/boards.json`，以及站点地图（`publication/sitemap.ts`）与 `llms.txt`
  （`publication/llms.ts`）里对 `/boards*` 那批 URL 的广告。
- 图记组件 `apps/web/app/features/board/PlateMark.tsx`（四枚图记只有板块页在用，`features/board/` 空了就一起
  删）。注意 `apps/web/app/routes/leaderboard-boards.tsx` **不是**板块的页面，它是模型榜的外框，留着。
- 测试 `tests/boards.test.ts`，以及 `tests/exit-category-parity.test.ts` 里那两条板块断言（同文的分类次序
  断言保留，它钉的是 `industry/taxonomy.ts`，与板块无关）。

**没有动的**：七个分类与它们的顺序、`section` 分节、库里的任何一行、`industry/sources.json` 那 41 条
`defaultCategory`（这条机制服务的是分类）、公开 API、RSS、MCP、后台、`tests/report-default-section.test.ts`
与 `tests/exit-category-parity.test.ts` 剩下的断言。`/boards` 与 `/boards/<slug>` 现在直接落 404，**没有做
重定向**：板块 slug 与分类 key 有一半不相同（`gis` → `geotech`、`kaoyan-geo` → `geoedu`），为一个已判定重复的
功能留一张永久映射表不值，旧书签由 404 页接住，那里有「全部动态」与主题页的出路。

还开着的三件事：

1. ~~**改动目前只在这台机器上，线上还没有它。**~~ **2026-10-04 下午已部署**（本机 curl 实测，两次一致）：
   `/geohot/boards`、`/geohot/boards/gis`、`/geohot/api/site/boards` 全部 **404**，线上首页 HTML 里「板块」出现
   **0 次**、`当前热点` 出现 1 次且带那行榜空的诚实状态。本地 `npm run typecheck`、`node --test apps/web/tests/*.test.ts`、
   `npm test`（连跑两遍）与 `node scripts/check-shots.ts` 都跑过。前端路由与 `industry/` 都改了，**必须重建 web**
   （`BASE_PATH=/geohot`）才生效，只重启 api 不够——这一条是这次部署踩过的老坑，写在这里免得下一次再忘。
2. **README 的三张配图因此过期**（三张的侧栏里都有「板块」那一格——本轮用看图的方式复核过首页那张，
   侧栏确实是 精选 / 全部地理动态 / 热点榜 / 地理日报 / 主题 / **板块** / 收藏 / 更多 / Agent 接入 / 关于 /
   更新日志 / 反馈；alt 已经改成不再提它）。**"不要在本地提前拍"这个前提在 2026-10-04 下午已经解除**（第 1 条），
   所以这一条现在是**部署后的待办**而不是被挡住的事：`node scripts/shoot.ts --base https://xxc2007.me/geohot`
   重拍受影响的那几张，再用 `node scripts/check-shots.ts` 守图。**重拍之后必须回头改说明**——首页那张一旦拍到
   榜空的诚实状态，README 里"画面里没有当前热点条"那一段就要跟着改，否则又是一次说明与画面不一致。
3. **部署后的线上复验清单**（2026-10-04 下午逐条实测，结果写在后面）：`/geohot/boards` 与它的任何子页返回 404
   （整层已删，不再逐个 slug 去试——旧 slug `gis`、`kaoyan-geo` 都不在词表里，列进清单只会让人以为它们还是地址）；
   侧栏只剩精选 / 全部动态 / 热点榜 / 日报 / 主题 / 收藏；`/geohot/sitemap.xml` 与 `/geohot/llms.txt` 里不再出现
   `boards` 与「板块」（实测 sitemap 580 条 URL 中 `boards` 前缀 **0** 条、`llms.txt` 里「板块」**0** 次）；
   `/geohot/api/site/boards` 返回 404；`/geohot/topics/<slug>` 的空态文案不再指向板块页；
   `deploy/geohot/verify-deploy.sh` 与站点 smoke 全绿。

## 2026-10-04（下午·文档整改）：介绍页的账清到哪一步，以及四条移交代码的文案

一位只读审计智能体逐条实测了 `README.md`（报告在仓库外），本轮把**文档侧**的账落地：介绍页改了 13 处、
`NOTICE` 2 处、`docs/manual.md` 正文 3 处加 §9 表 4 格（含新增的 `docs/known-issues.md` 一行）、
`AGENTS.md` 1 处、`scripts/README-ingest.md` 3 处、`docs/migration.md` 补 7 项（另加三条演练里踩到的坑）。
逐条都带当场命令，挑几条最容易复发的说：

- **抄进介绍页的线上数字一定会过期**：上一版写的线上 `items` 5371 / `sources` 58 与"精选分类分布 53 条"
  已整段删掉，只留端点。实测证据：`/api/site/stats` 的 `items` 在同一天两小时里从 5371 → 5792。
- **"线上落后于本机"这句因果是错的**：2026-10-04 实测线上 `sources` 已是 85（与 `industry/sources.json`
  的 kind 分布逐档相同）、`/topics` 链接数 43（= `industry/topics.json`）、`/topics/fieldwork` 与
  `/topics/opinion-analysis` 都 404——整包早就升上去了。
- **一份审计报告自己的替换数字也不能照抄**：它按当时的 snapshot 建议把分类分布改成"57 条：自然地理 29、
  5 条无分类"，而 `12849a3` 部署之后 snapshot 回到 **53 条 / 2 条无分类**（13:35 实测），照抄反而会立刻错。
  本轮的处理是**两边都不写死**，只给 `curl -s ".../api/v1/selected/snapshot?limit=200"` 与对账口径。
- **`app.css` 的"三处偏离、其余一字未改"是夸大**：`git diff 754191b -- apps/web/app/app.css` 给的是
  12 个 hunk、+94/−12；而且它列的浅色 `--rank-rest` 现值已经不是它写的那个值。介绍页改成"改到读者可见的
  三组 + 其余是令牌扩充"，每个值都从 `git show 754191b:…` 与现版对拍过。

**移交代码侧的四条文案账**（本轮文档智能体没有动任何代码文件，逐条给位置与实测）：

1. `apps/web/app/routes/agent.tsx:82` 与 `:90` 都写着「五个工具」，而 MCP 实际暴露 7 个
   （`grep -c "server.registerTool(" apps/api/src/routes/mcp.ts` = 7；线上 `tools/list` 实测也是这 7 个）。
   **受害的正是这页的目标读者**——Agent 按页面文案找工具会以为少了两个。
2. `apps/web/app/app.css:5` 的头注释还写着 "Six categories"，词表是七个（`industry/taxonomy.ts`）。
3. `tests/industry-vocabulary.test.ts:96` 的测试名写着 "the ten categories"，断言本身逐字对拍的是七个 key；
   同文件 `:116` 的注释拿 `/feed/category/gis.xml` 当"key 进 URL"的例子，而 `gis` 是只活了几小时的 key，
   现在那个地址是 404（该换成 `/feed/category/geotech.xml`）。
4. `scripts/shoot.ts:18` 给 `hot-light.png` 的 `label` 写的是「AI 热点榜」，页面标题是「地理热点榜」——
   不影响产物，但它正是本站声明"不用 AIHOT 名义"那条红线附近的残留。

**这四条已在 `3f7974f` 落地**（文档智能体没有动代码，逐条由编排方改）：`agent.tsx` 的工具数改成从
`MCP_TOOL_NAMES` 算出（`Object.keys(T).length`），并加 `tests/agent-page-tools.test.ts` 钉住"七个工具在页面上
逐个点名"；`app.css` 头注释、`industry-vocabulary` 的测试名（改成 `${CATEGORIES.length}` 派生）与 `gis.xml`
例子、`scripts/shoot.ts` 的标签各改一处。**行号会漂**：那两条 `agent.tsx` 的引用现在落在 `:84` 与 `:92`。

**三张配图已按线上重拍**（2026-10-04 14:07，`node scripts/shoot.ts --base https://xxc2007.me/geohot` +
`node scripts/check-shots.ts` 三张全绿），首页那张现在画面上有「当前热点」四条与「截至 X 时」。

## 2026-10-04（下午·信源体检）：加源救不了首页，缺的是分数与署名判断

一位只读智能体把 85 条信源在生产库上按 7 天窗口逐条量了一遍（报告在仓库外 `.round9/agents/C1.md`，
所有探测都从采集器那台机器做，本机 DNS 与它不一致）。三条结论值得单独记，因为它们和直觉相反：

1. **首页那三个空分类不缺稿源。** `地理与政治 / 地理与历史 / 考研` 7 天内分别入库 104 / 121 / 43 行、
   基本全部 eligible，但它们能拿到的分上限是 20~50，而精选门槛是 56；同时 `tooling/fixtures/*.jsonl`
   （676 行署名判断）里 geopolitics 与 geoedu **一条都没有**。所以**加信源只填 `/all`，填不了首页精选**——
   要动的是评分与署名判断，而那是站长的编辑决定，本轮没有替它改任何一个数。
2. **热度门槛的一半是恒真的。** 库里 `participation_mode` 只有 `editorial`=77 与 `isolated`=8，
   **`hot_signal` 零条**，于是 `events/hot.ts` 里"至少一个编辑类参与方"这一半永远成立、不起约束作用。
   这条不是 bug（配置就是配置），但它意味着"门槛有四条参数"的说法只在地上成立三条——README 与手册
   凡说"四个参数"的地方，读者要清楚第四条目前是空的。
3. **采集器结构上接不进"要带浏览器 UA 才给 200"的官方站。** `config-keys.ts` 的 `KEYS.rss` 与
   `KEYS.web_list` 不含 `headers`（只有 `json_list` 有），`http-fetch.ts` 硬发 `GEOHOTBot`。实测同一 URL
   该 UA 403、换 Chrome UA 200。**要不要放开这个口子是一个决定**（放开等于允许在仓库配置里写任意请求头），
   本轮没有改它，因此那几条靠 UA 才能进的候选一条都没写进 `industry/sources.json`。

另外两条现场事实，省得下次再查：`cea.gov.cn` 从这台机器 403（换 UA 也 403，判死）、`cjw.gov.cn` 连接超时；
`intl-worldpoliticsreview` 与 `intl-unocha` 是**假死**（VM 上 200、各 10 条），别再按本机的超时判它们下线。
`web-mnr-ywbb` 是这台机器的解析器解不出 `mnr.gov.cn`（公网 DNS 能解），源本身没死。

**「200 + 100 个 item」不等于这个源活着。** 本轮按这份候选清单先加五条，当天就退回三条：人民网·时政/国际/科技
三个 RSS 的 URL 都是 200、`text/xml`、各 100 个 `<item>`，可**第一个 item 的 pubDate 分别是 2025-06-03 /
2025-06-04 / 2021-02-01**——那是三年前和一年多前停止更新的快照，采集器按时间水位把它们全挡在外面，
第一次抓取入库 0 条。探测只量"能不能打开、有多少条"，量不出"最新一条是几点"，所以**接入判据要写成
"feed 里最新一条 pubDate 距今多久"**，而不是状态码与条目数。中新网（当天 12:37 +0800）与 BBC 中文
各入库 30 条，才是真加进来的两家；库里那三行已 `enabled=false` 停用（不再排期，也不删，留着当次判断的
现场），`industry/sources.json` 里已删除。

**一个容易误删的同名文件**：`apps/web/app/routes.ts:33` 那个
`layout("routes/leaderboard-boards.tsx", …)` 与本轮删掉的「板块」层**无关**——它是 AIHOT 那套
`/leaderboard/*` 榜单（`FEATURES.leaderboard`，本站默认关）的共用布局，文件名里的 boards 是"榜单"。
按文件名找"板块残留"会把它一起删掉。

## 2026-10-04（傍晚·对抗审计）：三条被自己的复验推翻或收紧的说法

一位对抗审计智能体（D3）被要求逐条推翻本轮写下的结论，三条真的被推翻或需要收紧，都记在这里，因为它们
都是**下一次很容易再犯**的形状：

1. **不要把"此刻数出来的累计量"写进定稿文案。** 「10-03 14:55 之后 277 次重算全是空榜」这句在落笔那一刻
   是准的，而榜每 5 分钟一张继续长：14:30 复测 283、14:45 复测 286、审计时 284 行里 1 行非空。凡是
   "从 X 到现在一共 N"的句子，要么把右端点钉死（"到本条上线（14:06）为止"），要么给命令不给数。
   本轮的 changelog、测试注释与报告都已改成钉死右端点的写法。
2. **源站的 `Cache-Control` 不等于读者看到的缓存。** 线上实测：编辑类分享图源站发 `max-age=3600,
   s-maxage=3600`，出去到浏览器却变成 `max-age=14400`——`14400` 全仓 0 命中、:3000 那层代理仍回 3600，
   改的是 **Cloudflare 的 Browser Cache TTL**（全站默认 4 小时）。也就是说这条 1 小时的收紧只在 CDN 层
   （`s-maxage`）成立，浏览器那一层由 Cloudflare 的站点设置决定；静态卡的边缘缓存实测 Age 已到 2.7 天
   （`s-maxage=604800` + 24h stale）。要真按小时生效，得去改 Cloudflare 的 Browser Cache TTL 或给这些
   路径单独设规则——那是主站前置层的配置，属站长决定，本轮没动。
3. **热榜链路此前不引用中文门槛。** 全站每个读者出口都过 `chineseCopyCondition`，唯独热榜是从
   `stories.title` 直接取标题的。线上 4025 个事件里 482 个仍是纯拉丁标题（160 个还在 48 小时内活跃），
   今天没有一个能凑到两个参与方，但首页 15px 打出去的那一行正是最经不起英文的地方。已在
   `events/hot-read.ts` 的 `publishableStories` 上补这道门（复用 `CJK_TITLE_PATTERN`，不重抄正则），
   并让 `tests/hot-board-carryover.test.ts` 钉住"拉丁标题不上榜"。

另外两条小事实，供下次读 `/hot` 的人对照：**"榜不老于两小时"这一档里圆点照常脉冲、不写「截至」**，
所以"读者一眼能分辨"这句只在超过两小时之后成立；`/hot` 页面顶部说 4 个事件而 `<article>` 只有 3 张——
第 4 条渲染在「继续看」那个 `ol.card > li` 里，是**计数口径**不一致而不是少画了一条，脚本按 `article`
数数的检查项要连那个列表一起数。

## 2026-10-04（下午·生产核验）：新信源的材料进不了事件层，所以加源不可能点亮首页

一位只读核验智能体（E2）在生产库上逐条 SELECT，把"加了权威信源→跨信源事件→首页有榜"这条链量了一遍，
结论是**链条在第二环就断了**，而断点是可以精确定位的：

- 采集侧活着：`cn-chinanews-scroll` 37 篇、`intl-bbc-zhongwen` 38 篇，**全部**落在核验前的 60 分钟内，
  75 篇里 74 篇 `body_status='ok'`（正文 204–5660 字）。
- 出版物也拿到了：36 + 38 行 `visibility='public'`，但 `selected` **0 行**。
- 事件层是空的：这 75 篇 `grouped_at IS NOT NULL` = **0**，`story_signals` 里这两个 source 的行数 = **0**。
  它们从没进过事件层，因此**物理上不可能配对**。
- 全站同一天也是 1:1：48 小时内 2532 条 signal / 2532 个 story / 2532 篇 article，参与者分布只有
  `1|2534` 一行；有 ≥2 个不同信源的事件全历史只有 **6** 个，最近一个非空榜停在 10-03 14:55（4 条）。

**根因不是归组算法，是 `analyses.relevance`。** 那 74 条分析全部是 `relevance='unknown'`（全站
`pass` 5205 / `unknown` 1351 / `block` 17），而 `jobs/content.ts:119` 只在 `relevance === "pass"` 时才把
文章投进 `QUEUES.group`——`unknown` 的文章会发布成条目，却永远不排队归组。`unknown` 的定义在
`editorial/analyze.ts:373`：过了预筛却**没有可用的中文摘要**（`summary_zh` 空）就判 unknown，即"等材料，
不硬发"。这 74 行实测 `title_zh` 有值（等于原标题，本来就是中文）、`summary_zh` **全空**、`score=20`。
空摘要的来源不是异常，而是本站的编辑红线：`tooling/brain-stub.ts:69` 的 `BRAIN_SUMMARIZE_DEFAULT`
在**生产里没有设**（2026-10-04 读 `/opt/geohot/app/.env` 的 30 个键与 `geohot-brain` 单元的
`Environment=` 行，都没有这个变量），所以走默认档 `empty`——stub 不写任何读者要看的句子（"把原文回显成
中文稿是伪造署名，没有人工稿就不发布"）。同一条线上还有一道会清空摘要的闸门：
`editorial/writing.ts:218` 的身份守卫遇到词表之外的机构/人物名时把摘要丢掉、标题回退原标题。

所以**"多接几家官方信源"这件事，在补齐对应的人工署名中文稿之前，只会加厚 `/all`，不会点亮首页**——
与上面「信源体检」第 1 条是同一个瓶颈的两端（分数上限、署名判断），这次是它在事件层的表现。要动的是
`tooling/fixtures/*.jsonl` 里给这两家（以及 `unknown` 那 1277 条的其它信源）补署名摘要与评分，
那是站长的编辑决定；本轮没有替它写任何一条判断，也没有为了让榜有内容去放宽 `content.ts:119` 那道门。

顺带三条口径修正：① `industry/sources.json` 的 87 是 **`enabled` 口径**，生产 `sources` 表实际
**90 行**（56 `rss`，含三条已停用的 `cn-people-*`）——报数时别把两个口径混用；② 英文标题闸门
（`events/hot-read.ts:94`）在位且历史所有已发布榜命中 0，但今天这个 0 是**空真**（24 小时内 269 个已发布
榜 entries 全是 `[]`），要等有非空榜那天才算真被验证过；③ 单条事件分享图的浏览器 `max-age` 被
Cloudflare 从 3600 抬到 14400（`s-maxage` 未动），`/og/pages/hot.png` 不受影响——与上面第 2 条同源。

## 2026-10-04（晚·第十轮）：删「一手」、把英文泄漏焊在读取层，以及一次被推翻的巡检结论

**1. 「一手」渠道删除（站长要求）。** 筛选栏那行从 9 格回到 8 格（全部 + 七个分类）。删的是三处：
`CHANNEL_KEYS` 里的键、`CHANNEL_LABELS` 的标签、`Filters.tsx` 的 chip，加上读取层 `channelCondition()` 里
`firstParty → AND p.first_party` 那个别名分支；`packages/contracts/src/taxonomy.ts` 的两处必须同笔改
（`Record<ChannelKey, string>` 是穷举映射，只删一处 typecheck 直接红）。**`first_party` 数据字段一处没动**：
评分输入、日报报眼的「件一手发布」、事件页的「官方一手」区块、后台信源徽标仍用它。老链接
`?channel=firstParty` 不再过滤但**不 404**（两条路由把认不出的渠道兜底成 `all`；API 侧 `parseFilters`
仍按未知值 400，那是非公开接口）。回归由新增的 `tests/channel-row.test.ts` 钉住（chip 必须从
`CATEGORY_KEYS` 派生、枚举里不许再有一手、老链接必须有兜底）。

**2. 一次被推翻的巡检结论，记在这里当教材。** 浏览器巡检（A7）报 `/all?channel=firstParty` "chip 高亮
但列表完全没过滤"，证据是页 1 的 40 个条目与不带参数重合 39 个。复验发现那是一**页移**：两次请求间隔
一秒，正好有新条目落进列表顶部，于是基准页多出的一条（`xdg997…`）与对手页多出的一条（`wxmtwq…`）各一条。
拿生产库查这两个 id：被挤出去的那条 `first_party = f`（**正是该被过滤掉的**），新出现的 `first_party = t`。
所以过滤一直在工作——"几乎不过滤"的真正原因是这一格筛出的集合与「全部」重合度太高（公开可列条目里
约 97% 是一手信源），这也正是站长说它"有点多余"的量化依据。教训与第 8 条同源：**巡检结论要落到
单条记录的主键上复核**，只看集合计数会被时间差骗。

**3. 英文泄漏：量清楚了，但改法在当晚被自己推翻，只留下一处收窄。** 生产实测：**1374 条**公开编辑类报道
的标题没有中文（GDACS/USGS 式机器通知，标题走的是兜底路径），**474 个**事件页的标题是纯英文，其中
**472 个**连一篇中文报道都没有。第一版改法是把闸门从"进不进列表"移到"页面能不能开"：给
`story-reports.ts` 的查询、`stories.ts` 的标题、条目卡的故事引用、`relatedStories`、sitemap 一起加中文
条件。**四个本轮之前就存在的测试当场变红**（`tests/publication.test.ts` 的 licence 撤回、事件撤回、
"没有中文摘要的条目照样有页面"，以及 v1 事件接口），而它们钉住的是一条写在代码注释里的决定：
`itemHasPage` 认为"公开且已发布的条目有页面"，中文化只决定**列表**要不要收它。改法因此**当晚回退**，
只留 sitemap 一处收窄（sitemap 是唯一一处"向搜索引擎承诺这里有内容"的名单，英文页不该在里面）。

- 留在桌上的问题：那 474 个页面仍然可以打开、内容全英文。两条路——**要么**给它们 404（与"没有中文稿
  的条目不列表"同一精神，但要先改那四个测试与 `itemHasPage` 的注释），**要么**保持"可开但不列"并在页面
  上加一句"这篇报道还没有中文稿"。这是编辑口径，属站长的决定，本轮没有替他选。
- 附带说明：试图加闸门时也确认了这 474 个页面里 **472 个**没有任何中文报道——想给它们写中文标题，
  得先从语料补起。

**4. 同轮修掉/记下的小项。** `/hot` 的空态从"两句话、零链接"改成两个出口（去的全部动态 / 去最新一期
日报）——首页那条「完整榜单 →」此前把人送进一个死胡同（真实浏览器巡检发现）。`/all?tag=…` 的
`<title>` 从「全部地理动态」改成 `#标签`（`<h1>` 早就是 `#标签`，两个口径不一致）。手机端点分类 chip
不再因 URL 里的一次性 `search=1` 重新抬起键盘（`hrefWith` 现在丢掉它）。搜索时标签不再被静默丢掉
（hidden input 补上 `tag`）。`leaderboard.tsx` 那处 `${SITE.name}` 写在普通双引号串里（永不插值）。
`verify-deploy.sh:233` 的 MCP 预检把 `Origin: https://xxc2007.me` 写死（换域名必假红，与脚本其余
`${VAR:-default}` 风格不一致）。`bootstrap-server.sh` 注释里的"35 个迁移 / 44 信源"是旧值（实测 40 / 91）。
`IMG_PROXY_REQUIRE_SIG` 是个死开关：`config.ts:103` 读了它，代码里没人用它，`/api/img-proxy` 恒校验
签名——失败方向是安全的，但文档说它能"关掉校验"是错的。以上五条**都是本轮查明、未在本轮改**（换域名
那两条与主站配置有关，属站长的决定）。

**5. `README.md` 三条被审计推翻的说法已改**：日报兜底分节不是"分类数组末位"而是显式常量
`DEFAULT_SECTION`（`reports/compose.ts:26`）；"下面引用了它四次"的待办清单实际被引用 16 次（改成不带
数字的说法）；`NOTICE` 里没有 README 引用的那句 "more than 100 imports"。**仍开着**（审计报告
`.round10/agents/A10.md` 有逐条清单）：`AGENTS.md:43` 那条"数一遍别抄"的 `grep` 在本机永远返回空、
`AGENTS.md:17` 的"六个决定"与 manual 的四个标号对不上、`AGENTS.md:51` 的安全阀清单漏了
`EMBEDDINGS_ENABLED`。

**6. 干净克隆的部署演练（A8）与它查出的文档缺口（已修）。** 十步走通：克隆 → `env:init` → 自己的集群
（5455）→ migrate/seed → 构建 → 起栈 → 冒烟，页面与机器出口无 0 字节、无 4xx/5xx。**缺口是"内容"那一环**：
只带 `.env` 时 `MODEL_CALLS_ENABLED=false`，就算跑了 `seed:curated`（117 行）库里也只有 `articles=117`、
`publications=0`、`selected=0`——从材料到精选/事件/日报必须过模型那一步。把模型阀打开后同一套材料跑出
**113 篇出版物 / 50 篇入选 / 81 个事件**（演练方在日额度耗尽前把这条验证留成了 Step 11，编排方接着跑完）。
`README.md` 的「本地运行」与 `docs/deploy.md` 的「启动后」两处已按这条改写：**种子语料与采集阀都到位，
还要模型阀到位，站上才会有内容**。

## 2026-10-05（第十一轮·按第十轮的建议落实）：署名闸门、事件页的诚实态，以及一条被推翻的采集器结论

站长对第十轮报告只说了一句「按照你的建议做」，所以这一轮做的就是那两份清单：两件留给站长拍板的，和那批
记着"下轮再做"的。逐条如下，包括**没做的和查错的**。

**1. 成刊层第一次问"这句话是谁写的"（A3 的 BLOCKER 3）。** `reports/compose.ts` 是全仓唯一一条读者必读
正文不过 `machineRuleOf` / `looksZh` / 身份守卫的链路。先量再改：生产库里成刊层历史上总共**四次**取稿，
**全部**是规则默认值（`rule:list-lead` ×3、`rule:list-themes` ×1），**零条**有署名；两条日报的"导语"是把
当天标题重抄一遍，周报的"主题句"是把条目编号列出来。改法照 `events/digest.ts:96-118` 的同一条判定：规则
答的就发不出去，日报退回**无导语态**（11 期里本来 9 期就是这样，读取层早有这一支）、周报退回通用期名 +
按本报分栏列条目，**条目一条不少**，原因记在期上（`generator.leadRule` / `proseRule`）。大标题另过
`guardedStoryTitle`，出处 = 本期被引的条目。stub 那两个机械默认值同步改成空回答（与 `digest` 同一口径），
`--lint` 的 `readerCopyDefaults` 从此应当为空——`BRAIN_REPORT_LEAD_DEFAULT=list` 能把机器稿调回来，因为
"有机器稿可拒"才是这条路径的真正测试（`tests/report-signed-copy.test.ts` 五条就是这么写的）。

**2. 事件页的 474 个（BLOCKER 2 的后半，站长口径已定）。** 实测：4023 个可打开事件里 474 个标题无汉字，
只有 2 个有中文报道标题可借，51 个还在 48 小时窗口内。走的是"保留可开 + 说明 + 收回承诺"那条：页面顶部
一句「这条事件还没有中文稿：上面的标题和下面的报道都按原文照录」加一个去处（`/hot`），`robots` 改 noindex。
判法照条目页那一对：`itemHasPage` 管打不打得开，`indexable` 管能不能对爬虫承诺——这一对条目页有
（`item.tsx:41`）、主题页有（`topic.tsx:40`），事件页此前独独没有，而 sitemap 上一轮只收了名单。

**3. 一条被推翻的结论：`COLLECT_SKIP_JINA=true` 不会"静默排除 53 个 RSS 源"，它每次都抛。** 第十轮报告
第 4 节照抄了 A3 的预测（缺 `coalesce` → `NOT (NULL)` → 只写 `feedUrl` 的 53/79 条被悄悄排除）。本轮补
那个 `coalesce` 之前先写测试，第一次跑得到的是 `operator is not unique: unknown ->> unknown`——那一行把
**列名当参数绑了**（`${c}` 发到服务端是 `$1`，`->>` 推不出类型）。所以真实后果是**那一分钟的排班整批失败、
什么都不抓**，"静默排除"从未发生：两个缺陷叠在同一行，throw 挡在前面。修法两步——列名写成列名（顺带删掉
那个从未被调用、且按写法根本不可能工作的 `alias` 参数），再补 `coalesce`（缺它才会出现 A3 预测的那种排除，
两种形状都实测过）。`tests/fetch-schedule-jina.test.ts` 同时钉住这两条。教训与第十轮那条"页移"同一种：
**预测出来的失效模式要跑一次再写进报告**，报告的措辞已经按实测改过。

**4. 中文门槛的第十四种写法少了一种（MAJOR M3）。** `publish.ts` 那条手抄的 `[\u4e00-\u9fff]` 现在走
`items.ts` 新加的 `hasChineseCopy()`，它由 SQL 那条同一个常量 `new RegExp` 出来——注释里那句"就是列表用的
那一条"第一次名副其实。注意它与 `writing.ts:23 looksZh()` 不是一回事（后者额外拒绝假名与谚文），两者的
分工写在函数注释里，别再合并。

**5. 「另有 N 家」的 N 与点开后的列表同源了（m5；B1 已被复核推翻）。** A3 的 B1 断言"展开列表
（`groups.ts:31`）缺中文闸门"——本轮复核**不成立**，`groups.ts:43` 那道门在（应是第十轮那 12 条修复里补
的，报告没记清，这条就算没记的账）。缺的是另一半：`timeline.ts:51 groupPool` 算卡片上那个数字时没有这道门，
于是"卡片说 3 家、点开 2 条"仍然可能。本轮补上同一道门，并给这个此前**零测试覆盖**的读者出口写了断言
（`tests/publication-copy-gate.test.ts` 第四条，出口清单同步加了事件页与展开列表两项）。

**6. 死代码：删掉一条零引用的，另一条量完之后决定不删。** `apps/web/app/features/admin/charts.tsx`
（193 行，全仓零引用；A4 报的路径 `routes/admin/charts.tsx` 不存在）已删。那 2141 行**没删**，理由是量出来
的：构建产物里它们各自成块（`codex-reset-*` 25 KB、`leaderboard-*` 五块、`Evidence-*` / `StatusChip-*`，
合计 **82,752 字节**），读者真正下载的 entry / shared / 页面块里没有它们，而线上这几个地址本来就 404，
`README.md:140` 与 manual 第 9 节把"路由还在表里、模块已关、接口不注册"写得准确。删它换来的是构建目录小一点，
代价是六处文档改写 + 与上游 MIT 母体的进一步分叉。**这条留给站长**：`industry/features.ts` 那两个开关本身
是他的口径（AGENTS.md 说的是"别再打开"，不是"删掉"）。

**7. 脚本与配置面（A5 三条 + A10 三条，全部落地）。** `verify-deploy.sh` 的 MCP 预检改用脚本第 23 行已有的
`$ORIGIN`，不再钉死 `https://xxc2007.me`（换域名必假红）。`IMG_PROXY_REQUIRE_SIG` 那个死开关连 `config.ts`
字段一起删了：`/api/img-proxy` 恒验签名是设计，`.env.example` 说它能关是错的，两处都按实测改正。
`bootstrap-server.sh` 注释里的"35 个迁移 / 44 信源"改成不带数量的说法（现值 40 / 90，唯一口径在 README）。
`AGENTS.md:43` 的"数一遍别抄"从 `grep -rl "[.]/brief/"`（**永远返回空**，那个写法要的是"点＋斜杠＋brief"）
改成 `git grep -l "\.brief/"` → 8 个文件，正文里那句"4 个 tracked 文件"改成 8（4 处数据引用 + 4 处叙述）。
`AGENTS.md:17` 的"六个决定"改成四个（manual 第 7 节第 11 条只有 ①—④）。`EMBEDDINGS_ENABLED` 补进
`AGENTS.md:51` 与 `docs/architecture.md:30` 两份安全阀清单（它缺省为开，但同时要求模型阀与 embedding key）。

**8. 这一轮之后仍然开着的。** ① 那 474 个事件页与 117 个无综述事件的中文稿仍然是空的——那要人写。
② 签名导语仍然只有 8 条 fixture，所以闸门生效后日报大概率长期停在无导语态，直到有人写下当期那一句；
这是设计，不是待修。③ 英文源那条路照旧堵着（要它们，先要一条能出中文稿的路）。④ A3 剩下的 M2、M4–M13、
m1–m13 与 A4 其余前端项本轮没动——只做了站长清单上的，以及与它们直接相连的那几处。

## 2026-10-05（第十二轮·继续清账）：五条 MAJOR/MINOR 级缺陷与一条测试的反向验证

站长的新口径是「多轮迭代升级，确保所有功能都正常使用、所有代码高质量且精简」，所以这一轮继续按
`docs/known-issues.md` 与 A3 的清单往下清。本轮做了五条，每条都先在代码里复核再动手：

**1. `getBoss()` 的启动失败不再被永久缓存（A3-M8）。** `jobs/queue.ts` 原先只在成功分支里落地 `boss`，
`starting` 那个 promise 一旦 reject 就永远留在那儿——而 `publishArticle` 是在业务事务里入队的
（selected 通知 + 媒体准备同一条 tx），所以数据库抖一下之后**每一条发布都会回滚**，只能重启进程。
现在失败即清空、并把半启动的客户端 `stop()` 掉。**这条测试做了反向验证**：把 `queue.ts` 换回旧实现，
`tests/queue-start-retry.test.ts` 当场变红（8.8ms 就失败，因为端口不通是立刻 ECONNREFUSED），换回修复即绿。

**2. 搜索并发闸门的名额改为随唤醒移交（A3-M7）。** `publication/pool.ts` 原先 `finally` 里先
`running -= 1` 再 `waiters.shift()?.()`，被唤醒者要等一个微任务才把自己加回计数——中间到达的请求看到的是
"看起来空着"的名额，于是上限是软的。现在唤醒即移交。**这条测试钉不住那个窗口本身**（它只在模块内部的
微任务交错里存在，从外面无法确定性复现），所以 `tests/search-capacity.test.ts` 钉的是可以确定的三件事：
队满当场 503 + Retry-After、排队有 3 秒截止（超时报 SearchBusyError，不让机器流量无限堆着）、
以及任何时刻真正在跑的搜索数不超过上限。这个闸门此前**零测试覆盖**。

**3. 信源 config 里的首次导入上限不再读成 NaN（A3-M2）。** `collect.ts` 的两处 `Number(config._aihot?.…)
? 30/12)` 没有校验，而 `industry/sources.json` 里 **66 条**信源带着 `initialBackfillLimit`：写成非法值就是
NaN，`slice(0, NaN)` 是空数组，于是一轮"成功"抓回来 0 条、照样写 `initializedAt`、`health='ok'`、
`fetch_runs.status='ok'`，这个信源的历史窗口永久关闭。现在走同文件 `roundBudgetMs` / `pool.capacityLimit`
已经在用的那条兜底（新增 `positiveInt`），坏值退回册子里的默认，实际存了几条在 run 的 `stored`/`dropped` 上看得到。

**4. 板龄注释按节拍改正（A3-M5）。** `hot-read.ts` 说 24 小时板龄等于"二十次重算都是空的"，而
`hot.rank` 是 `*/5 * * * *`——24 小时是 **288** 次，不是 20（那个数字是从旧的更短时限改过来时没跟着改的）。
这条注释是运营判断"榜空了多久"的唯一文字依据，读它的人会低估窗口 14 倍。

**5. 综述长度下限按署名稿实测定（A3-M4）。** `MIN_DIGEST_CHARS` 原来是 10，注释却说提示词要 150–400 字，
两边互相拆台且 10 恒不生效。量了 `tooling/fixtures/digest.jsonl`：19 条署名综述 **138–409 字**，于是下限设 60
——挡住"一句话冒充综述"，同时不会拒掉任何人真写过的稿子。`tests/story-digest.test.ts` 加了一条断言走这一支
（`reason: "no-usable-copy"`，而不是 unsigned 规则那一条），并把文件头的四条判据补成五条。
这条测试也顺带踩到一次缓存：同一 story、同样提示词的第二次调用拿回的是上一条测试的回执，必须先清
`receipts`——这正是 AGENTS.md 写的"同一个 revision 重跑不会再打到 stub"。

**6. 一条队列名删掉了，量法顺便记下来。** `QUEUES.translate`（"content.translate"）在 `queue.ts` 之外
**零引用**：翻译由 cron `content.translate` 直接调 `translatePending()`，不走队列，所以那条
`retryLimit: 3` 从未生效过。量法是逐个 key 数引用（11 个键里 10 个有生产者或消费者，只有它没有），
不是靠印象删。同名撞车是它看起来"在用"的原因—— schedules.ts 里那是**定时器名**，与 pg-boss 队列是两个命名空间。

**7. 两条被本轮复核推翻或改判的评审结论。**
- **A4-m-2「`/all` 渲染两个 `<h1>`」是 DOM 层面的误判。** 线上实测（531px 视口）：DOM 里 2 个、**真正渲染的 1 个**
  ——桌面那一颗在 `hidden lg:block` 的祖先里 `display:none`，读屏与布局都看不到它；两个断点块严格互补，
  所以 ≥1024px 同理。`querySelectorAll('h1')` 数出 2 不等于无障碍树里有 2 个标题，这条与第十轮那条
  「页移被误判成筛选失效」属于同一类错误：**用 DOM 快照代替渲染结果下结论**。不动它，并把判据写在这里。
- **A3-M10「本站不存在的信源类型仍被四层特判」不改。** 那些 `x_search` / `mp_account` 分支是本站关掉的
  *能力*而不是死代码：本仓库的定位是"改成另一个行业仍能用"的框架（`AGENTS.md` 第 5-7 行、`docs/customize.md`
  的整个前提），X 与公众号正是另一个行业很可能需要而地理站没有的两类信源。删它们会让下一次改造必须重写
  采集与发布层，收益只有本站的阅读体积——而 `industry/features.ts` 已经证明这条站用开关就够了。
  A3 剩下的 M6、M9 与 m1、m3–m13 见本节末尾的清单。

**8. 配置数字只有一种读法了（A3-m2，顺带把第十二轮第 3 条的那条规则收进同一处）。** 全仓扫
`Number(process.env.X || default)` 得到 8 处，其中 6 处是会影响行为的：`DATABASE_POOL_MAX`（NaN 进连接池）、
`ANALYZE_CONCURRENCY` / `FETCH_CONCURRENCY`（NaN 进 pg-boss 的 `localConcurrency`）、
`ALERT_QUIET_MINUTES`（NaN 毫秒的静默窗口）、`FETCH_SCHEDULE_BATCH`（NaN 进 `LIMIT`）、以及本轮早上刚修的
`initialBackfillLimit`。`config.ts` 里其实已经有 `int()`（会抛错）与 `envFlag()`，但这些站点各自手抄了一份
`Number(...) || 默认` —— 同一个团队在 `pool.ts` 和 `roundBudgetMs` 里修过两次数值兜底、又漏了六处。
现在统一走新的 `config.positiveInt(raw, name, fallback)`：没填→静默用默认，填了用不上→退回默认并打一行
"实际在用哪个数"；它接的是**值**而不只是环境变量名，所以信源 config 里那种手填的数也共用同一条规则
（`collect.ts` 那个本地副本已删）。`tests/env-valves.test.ts` 钉了两条：数值行为表（含 `true` 不能被当成 1、
`2.7` 取整、`1` 合法因为 `.env.pipeline` 就用 1 减速），以及一条仓库扫描——**不许再有第二份实现**
（`apps/web/server.ts` 的 `WEB_PORT` 明确排除：前端进程不能读后端 config，而端口读错会在 `listen` 当场炸，
那是可接受的失败方式）。文件遍历顺手扩到 `scripts/` 与 `tooling/`。

**本轮之后仍开着的。** A3：**M6**（`snapshotHeat` / `backfillStoryHeat` 把集合运算退化成逐行 round-trip）、
**M9**（`collectXShard` 的逐成员写入缺 try/catch，`retryLimit=0` 不再重试）、**m1**（`failureGroupSql` 用
`sql.unsafe` 拼标识符：今天两个调用点都无参、不可注入，但它是把上了膛的枪交给调用方）、**m3**（`detail.ts`
对"这篇原文本来就是中文吗"有两套判定，页面与 Markdown 导出会给同一篇文章不同标签）、m5–m13。
A4：分组标题不是标题元素（侧栏 `Sidebar.tsx:74`、`more.tsx:57` 的 `<div>`，读屏听不到分组）、未用 import 与
死导出等。判为**不改**的两条已写明理由：A3-M10（`x_search` / `mp_account` 的特判是本站关掉的能力，不是死代码）、
A4-m-2（`/all` 双 `<h1>` 是 DOM 层面的误判）。
最后，那三件等站长拍板的事（上线与发布、线上三期机器稿重排、2141 行下架模块的处置）仍然没有答复，
仓库的代码因此**领先于线上正在运行的版本**——这是状态，不是缺陷，但每一轮的"已上线"结论都要按此打折。

## 2026-10-05（第十三轮·可达的缺陷优先）：噪声标记、安全网饿死、`sql.unsafe` 的枪、日志降级

这轮从 A3 剩下的清单里**按"今天是否可达"排序**挑，可达的先修，不可达的（只服务 0 条 `x_search` 信源的那些）
只 deterministic 化的那一行。改动 6 个文件，全部先读代码复核再动手。

**1. 空白标记不再等于"匹配一切"（A3-m10，可达且是内容安全问题）。** `markerPattern("")` 走的是纯子串那一支，
`new RegExp("")` 对任何文本都是 true：`dropMarkers: [""]` 会**丢掉整条 feed**，
`requireTitleMarkers: [""]` 会**全放行**（那条判断取反）。而 `sources/config-keys.ts:90` 只校验这四个数组的
**键名**、不校验元素，所以空串能一路走到匹配器。现在 `hasMarker` 里跳过空白项，
`tests/sources.test.ts` 三条断言钉住（含"空白白名单不得变成全放行"这一支）。

**2. 安全网不再饿死最老的滞留文章（A3-m6，可达）。** `jobs/content.ts:sweepUnprocessed` 是"没有任何队列在处理的
都补一次"的兜底，但 `ORDER BY discovered_at DESC LIMIT 500` 每轮取**最新** 500 条：一次崩溃 + 一次批量导入
就足以超过 500，比它们更老的行**永远不会被补**——`processing_state` 停在 'new'、`processing_error` 为空，
连那个专门列滞留项的后台页面都看不见它们。改成 ASC（最老先补）。这条没法用测试钉（要 501 行陈旧数据才有意义），
理由写在函数注释里。

**3. `failureGroupSql` 不再收列名（A3-m1）。** 它用 `sql.unsafe` 把参数拼进 SQL 文本：今天两个调用点
（`admin/runs.ts:47`、`requeueFailed`）都走默认值，**不可注入**，但下一个调用方传 `req.query` 就是注入。
既然没人传参，参数就没有存在的理由——现在它是一个固定的 SQL 片段，枪口朝下。

**4. 一条成功的任务不再因为写日志失败而被记成失败（A3-m11）。** `recordRun` 在 `fn()` 返回之后写
`job_runs.detail`，那一步用 `sql.json`；返回值里有 JSON 装不下的东西时它会抛，`catch` 分支随即把这条记成
`status='failed'`——运营在 `/admin/runs` 看到一个"失败"的已完成任务，会再跑一遍已经做完的工作。现在这一步
包在自带的 try 里，退化成一一定序列化的 `{result:"ok", detailUnloggable:true}`。

**5. 转推引用两条已入库帖子时，挂到哪个事件现在可复现（A3-m9）。** `events/group.ts` 的 `referenced` 查询没有
ORDER BY，而 `groupSignal` 取 `referenced[0]`：结果取决于 PostgreSQL 的返回顺序。补 `ORDER BY fa.created_at,
fa.article_id`（与紧邻的 `sameUrl` 查询同一个"最早优先"规则）。这条路今天不可达（本 pack 0 条 `x_search` 信源），
改它的成本是一行。**同一段里没改的**：M9 说的成员循环缺 try/catch——它同样只在有 X 信源时可达，真要接入社媒
之前一并处理更划算，别在不可达的路径上叠防御。

**6. 两处小重复。** `reportHeadline` 同一行把 `periodicHeadline(content)` 调两遍（NIT）；
`Number(process.env.X || 默认)` 的扫描测试顺带把 `scripts/`、`tooling/` 纳入遍历范围。

**判为不动的一条（A3-m13）**：搜索闸门的 `Retry-After` 写死 5 秒，而并发与队列上限可配。这个数字表达的是
"这条队列几秒钟内会排空"，与 `SEARCH_MAX_CONCURRENCY` 不是同一个量纲；把它跟着配置放大反而更假。留着，
但记在这里，免得下一轮又被当成漏改。

**这一轮之后**：A3 还剩 M6（热榜快照逐行 round-trip，可达但需要基准才好判断收益）、M8 之外的 m4/m5/m7/m8/m12、
以及 `roleOf` 的三个社媒标签（读者可见但本 pack 恒不触发，属站长的词汇口径）；A4 剩侧栏分组不是标题元素等。
上面那三件等站长拍板的事依旧没有答复。

## 2026-10-05（第十四轮·精简与一处可见性口径）：27 处死导入、`noUnusedLocals` 常驻、summary-only 的事件页

**1. 死导入清干净了，而且以后长不回来。** `tsc --noUnusedLocals` 扫出 **27 处**（web 17、tests/apps-api/tooling 8、
backend 2）：绝大多数是 `withSubject` —— 那是 AIHOT→地理改名时留下的尾巴，改名把那批文件的文案都换成了
`SITE.name`/`withSubject(...)` 的混合用法，一半的文件最后没再调用它。现在 `tsconfig.base.json` 与
`apps/web/tsconfig.json` 都打开了 **`noUnusedLocals`**（`npm run typecheck` 0 错，六个项目全过），
这条"精简"从此由类型检查守着，不靠人记得扫。两处需要判断的按判断处理：`providers/socialdata.ts` 的循环绑定
是结构需要的（它按附加媒体数决定剥几次尾链），改成 `_m` 并写明；`leaderboard/method/v15.ts` 那个零引用的
`SPECIALTY_EXCLUDED` 连同只属于它的一行注释一起删（那个模块整站在 flag 后面，见 README「贰 · SITE MAP 站点结构」那一节；这一版以前写的是 `README:140`，改版后行号已经漂，所以改指节名）。
`scripts/` 不在任何 tsconfig 的 include 里，所以那一族仍要靠人扫——记在这里。

**2. 事件页少了一个"第五种答案"（A3-m4，可达）。** `events/story-reports.ts` 的头注释说闸门就是
`rules.itemHasPage`，SQL 却写 `visibility = 'public'`：人工把一条报道设成 `summary-only`
（`/admin/content/<id>`）之后，它自己的条目页照样打得开（`availability.ts`、
`tests/publication-issue-gate.test.ts:151` 钉着"summary-only 的引用仍可打开"）、日报周报照样能引用它，
**只有事件页把它藏起来**——于是时间线少一条、报道数与来源数偏低、综述也不能引它。SQL 现在只排除 `withdrawn`，
与注释、`itemHasPage`、报纸引用三者对齐；`tests/publication-copy-gate.test.ts` 两个方向都钉住了
（设成 summary-only 仍在、撤回才消失）。**列表那一层不变**：`items.ts:119/129` 仍要 `= 'public'`，
所以"上不上列表"与"有没有页面"是两件事——这一点运营文档以前写得含糊，`docs/geohot-runbook.md` 两处已按实测改准。

**3. 两处导航分组读屏听不到（A4-m-5，可达）。** 侧栏 `Sidebar.tsx` 与 `/more` 的分组标题都是裸 `<div>`：
读屏导航"内容 / 更多"这些分组时只会念出一串链接，结构丢了。侧栏改成 `role="group" aria-labelledby`，
`/more` 每张卡的眉题改成带 id 的 `<h2>` 并给 `<section>` 挂上 `aria-labelledby`（成了具名 region）。
**样式类一字未动**，所以画面不变；这是无障碍语义，不是视觉改动。

**这轮之后仍开着的**：A3 的 M6（热榜快照逐行 round-trip，需要先有基准才知道收益）、M9（X 分片成员循环缺
try/catch，本 pack 0 条 `x_search` 信源）、m7（`ensureQueue` 遇到已存在的队列不下发改过的参数——
已按 pg-boss 实测形状改掉，见第十五轮那次队列参数漂移的告警）、m12（`first_party` 覆盖 2/3 信源，因此"一手/官方"不区分东西——
站长的词汇口径）；A4 的 m-8「死导出与冗余导出」这一族**本轮没做**
（`noUnusedLocals` 只管文件内未用的局部与导入，跨模块的死导出不报），以及它报的 `/all` 双 `<h1>` 已被复核推翻
（实测在第十二轮第 7 条）。
（第十六级注：这一段的 m5、m8 两条**已在第十六轮做掉**——分组计数补上中文闸门、向量召回预筛改按文本哈希；
死导出那一条也做了，全仓"除了声明无人引用"的符号现在是 0 个。）

---

## 第十六轮（2026-10-05）：后台半条命令、复放缓存挡住了磁盘清理、以及两处被复核推翻的评审结论

**1. 后台三条命令会"只做成一半"（R16B-1，可达）。** `setVisibility` / `setSeoIndexed` / `overrideFields`
原先先提交人工设置（`editorial_overrides` 版本 +1），再**另开事务**跑 `publishArticle` 重投影。重投影要和
归组作业抢 `articles` 行锁与 `pg_advisory_xact_lock_shared`，抢不过就抛——那时库里已经落了对人工设置，
读者侧却一切照旧，而且编辑器手里那份旧版本号从此每次点击都是 409，除非他碰巧刷新页面。
三条现在都收进一个 `sql.begin`，`detachFromFact` 的三次重投影一起进事务：**失败等于什么都没发生**。

**2. 后台写接口收的是没有校验的 body（R16B-5，可达）**：`routes/admin.ts` 六处 `body(req) as never`。
最重的是 `setVisibility` 从来没看过 `visibility` 的值——只漏掉这个字段的请求会把列写成 `NULL`
（列本身可空，`0001_core.sql:198`），而 `NULL` 既不是 public 也不是 withdrawn：一次人工下架被悄悄推翻，
版本还加了一。`!!input.indexed` 同理，字符串 `"false"` 会读成"标记收录"。现在三条各自过 zod；
`rerun` 的 `step` 也必须三选一（此前任意字符串都会走"重发/重抽取"那支，审计动作还被拼进
`content.rerun.<任意串>`）。

**3. 重新归组会撤销人工的"单独成条"决定，而弹窗写着相反的话（R16B-2，可达）。**
`admin/content.ts` 的 group 分支删 `grouping_overrides`，那正是 `detachFromFact` 留下的、每条模型决定都要
让路给它的人工记录（`events/group.ts:345`）。原来 `requireReason={false}`、审计 `reason: null`、
描述写"人工归组的成员关系不会被覆盖"。现在说法改准、必须写理由、按危险操作呈现。

**4. 磁盘增长这件事不能按评审给的办法修（R16C-1/2，未修，记录为什么）。**
`receipts` 本机 5 天 34 MB（约 7 MB/天，`request`+`response` 两个 jsonb 占 15 MB），
`receipt_attempts` 17 430 行、`fetch_runs` 的真实增速是每天 1 405 行（`sum(1440/interval_minutes)`），
三张表全仓没有任何 DELETE。评审建议"90 天后把负载置空"——**这条会造出更贵的问题**：
`providers/receipts.ts:116,142` 的复放路径就是靠 `receipts.response` 免掉第二次付费调用，
负载置空会把一次缓存命中变成一次解析失败（`llm.ts:223` 读 `choices` 时拿到 null）。
要做的话前提是复放端把"行在、负载空"判成未命中，而不是先删。这一支本轮只落了
`0044_hot_rankings_entries_array_check.sql`：`hot_rankings.entries` 加 `NOT VALID` 的数组 CHECK
（`jsonb_array_length` 遇到对象是抛错而不是过滤，一行坏数据就能让首页"当前热点"500）。
本机实测：对象与标量被拒、数组可写，历史 397/397 行本来就是数组。

**5. 两处被复核推翻的评审结论，记下来免得再报。**
(a) R16C 建议"顺手 drop 掉 12 张 `_bak_20260930` 表"——那些表只在本机开发库存在（各 0 行），
迁移在生产上跑就会去碰生产里同名对象；删表不是本轮该自主做的动作，`docs/manual.md` §7.9 已经把它们
列进人工清理清单。
(b) R16D 报"信源分级 T1 47/T1_5 15/T2 23 应为 50/16/24"——50/16/24 是**全部 90 条**的分布，
README 的信源口径那一段（当时在第 109 行，后来归「其四 · STATE 现状与边界」节，行号会随改版漂）说的是"可轮询那 82 条 48/15/19"，实测 82 条正是 48/15/19，原文没错。同一个评审给的
`scores.jsonl` 行数（121）与 `sources.json` 条数（90）是对的，已照改。

**6. 仍未拍板的三件事**：上线与发布（仓库现在领先线上若干个提交）、线上三期机器稿重排、2141 行下架模块的处置。
另有两条本轮查出来、需要站长定口径的：所有密码登录的签名都是 `admin:1`（`admin_users` 只有共享的那一行，
"按编辑者姓名签署"这条红线在密码会话里没有落点）；"哪些报道算在一个事实里"仍有两种读法
（`detail.ts`/`groups.ts` 问 `visibility='public' AND eligible`，事件页 `story-reports.ts` 有意只排除
`withdrawn` 且不看 eligible）——本机 summary-only 与非编辑性信源都是 0 行，所以今天看不见差异。

**7. 一处只做纵深防御、没有动代码的问题（R16E-3）**：条目页"原文"直接渲染 `articles.url`
（`item.tsx:259/355/489`），而 `lib/safe-url.ts` 的存在理由正是"原文链接来自采集器，渲染层不假设上游筛过"。
本机实测 2 939 行里非 `http(s)` 的是 **0 条**，所以这不是今天的洞；补的话应该在写入侧一处卡住协议，
而不是在四个渲染点各加判断。记在这里，等真做信源接入校验时一起收。

**8. 三处"两个口径量同一件事"的潜在不一致（R16A-3/4/5，本机均为 0 行可触发）：(a) 已在同一轮改准，(b)(c) 等口径。**
(a) `/all` 的「今天 N 条」表头与它下面的行不是同一条 SQL：表头走 `pool.ts` 的 `today_count`（原先带
`NOT p.backfill`、又不排除 `published_at IS NULL`），行走 `DayList.tsx`（按 `timelineAt` 分日、没有发布时间的
挪进「无发布日期」）。**本轮已改准**：`today_count` 现在与分日规则同一条口径，
`tests/publication-copy-gate.test.ts` 用两条补录 + 一条无发布时间钉住它（两个方向各自都能暴露，
只放一条会因为一少一多正好抵消而看不出来）。
(b) `/hot` 的「等 N 个来源」数的是 48 小时窗口内的**参与者键**（`events/hot.ts:144`，`participantKey()` 会把
同一 `signal_group_id` 下的多家合成一票），`/story` 与分享卡上的「N 个报道来源」数的是史上不同的
`source_id`（`stories.ts:122`）。同一个中文词、两种单位。本机 0 条信源填了 `signal_group_id`，两种数目前恒等。
(c) 一期报纸的「N 件大事」有三个读法：归档页只数仍有页面的引用（`reports.ts:378`）、报纸头版连划掉的一起数、
分享卡按原始引用数不去重（`og.ts:124`）。本机 29 期共 0 条失效引用、0 条重复，所以三处现在说的一样。
要动就从 (b) 的词汇开始——"来源"在热点页与事件页必须是一个意思，那是站长的措辞口径，不是技术上能自定的。

**9. 「今天」这一格由客户端算，跨北京零点会水合不一致（R16E-2，未修）。**
`features/feed/Timeline.tsx` 与 `DayList.tsx` 各自在渲染里算 `beijingDate(Date.now())`，再用
`day === today ? "今天"` 标日头。`beijingDate` 走的是固定 +08:00（不看主机时区），所以服务器与浏览器
只有在**两边时钟本身不一致**或正好跨过零点时才会给出不同的答案——症状是 React 报一次水合差异并整块重渲，
以及读者短暂看到错的"今天"。站里其他地方（`report-latest.tsx`、`daily-archive.tsx`）的做法是让 loader 把
`today` 发下来，这两处照做才对：改动面是两个组件加五个调用方（首页、/all、主题、搜索、收藏），
本轮收尾阶段不做半途的重构。眼下它不影响内容正确性——分组用的 `anchorAt` 是数据里带来的。

---

## 第十七轮（2026-10-05 下午）：抽取队列没有消费者、推荐理由没守卫、推送把"不知道"报成"已送达"

四个只读评审 agent（媒体管道 / 推送与告警 / 运维工具 / 编辑流水线）各自扫一片本轮之前没人看过的地方。
**改掉的**（都有 `npm run typecheck` + 全套测试与语法检查跟着）：

**1. 抽取正文的队列在没有消费者时照样被投喂（R17D-1，可达，本机有真行）。**
`registerExtractionJobs` 只从 `jobs/sources.ts` 里注册，而 `apps/worker/src/main.ts:23` 把
`registerSourceJobs` 整个挂在 `isCollectEnabled()` 后面；`route()` 却按材料形状决定"先抽正文"。
于是 `COLLECT_ENABLED=false` 的环境里（本机 `.env` 就是），每条需要抽正文的材料都进了一个没人领的队列，
5 分钟一次的安全网还每轮重排——本机实测 54 个 job 停在 `state='created'`、83 篇卡在 `body_status='pending'`。
现在 `route()` 只在有消费者时选 extract，否则按"用已有摘要判"走（与抽取最终失败时本来那一支同一个口径，
读者最多少一条内容，不会多一条错的）；后台显式点"重新抽取"时给一句说明，而不是收下单据静默排队。

**2. 推荐理由是读者可见句子，此前一道检查都不过（R17D-2，可达）。**
`finalizeCopy` 只管 `titleZh`/`summaryZh`，`analyze.ts` 把 `editorialJudgment` 原样写进 `analyses.reason_zh` →
`publications.reason` → 条目页"为什么选它"、精选 RSS、v1 API。现在它过同一道身份判定 + 中文判定
（`writing.ts` 的 `guardedReason`），点名材料里没有的机构、或者是英文，就整条不发（理由是可空字段）。
**评审给的那一行具体证据我没验实**：它报 `cl02` 的理由提到"OSI SAF 与 ERA5 两套来源"称材料里没有；
实际那条的分析摘要里就有「EUMETSAT OSI SAF Sea Ice Index v3.0」，ERA5 是否在正文里我没查到结论。
要人工复核的是这两行（`cl02`、`geotech-L7`）的理由是否越过了材料——命令：把 `identityContext` 换成
该条材料、对 `reason` 跑 `matchEntityIds`。

**3. 推送把三种"不知道"报成确定结论（R17B-1/2，线上阀门关着时不发作，开了就发作）。**
`postWebhook` 原来写 `let ok = res.ok`，只有 body 能解析成 JSON 时才收紧——一张 HTTP 200 的 HTML 拦截页
会被当成"已送达"结案；`code === 0 || StatusCode === 0` 还允许业务码非零蒙混。现在必须解析出 JSON 且
判定码为 0 才算 ack，其余按 sent / failed(4xx) / unknown 三态走。`resendDelivery` 原来先读状态再无条件写
`sending`（与本轮刚修的 `resolveDelivery` 同一个洞），现在改成条件领取 + 重发上限 3 次 + 内容已撤回就不再重放。
告警那边：`sendAlert` 在"阀门开着但没配会话 id"时一声不响回 `disabled`，且 `checkAlerts` 的循环一抛就带着
状态写入一起死掉（后面的问题发不出、`REPEAT_MS` 永不生效、恢复消息再也不发）——现在每条各自兜住并出声。
`FEISHU_INTERNAL_ENABLED` 原来是 `=== "true"`，与兄弟阀门的 `envFlag` 不同读法（`=1` 会等于"内容照推、
告警与反馈永不发"）；现在共用 `envFlag`，但**保留在使用点现读**——反馈与告警的测试是运行时改
`process.env` 的，取成启动快照会把它们全改成"永远不发"（本轮踩过，5 个测试当场红）。

**4. 运维工具的四个安全洞（R17C-1/2/4/5，都已补）。**
`verify-deploy.sh --save-baseline` 原来用 `curl -s | sha256sum`：主站 502 时把**空正文的哈希**写进基线还
exit 0，之后第 1 节对一个坏掉的主站长年报"字节级一致"——现在非 2xx/空正文/空哈希一律拒写，并把基线属于
哪个域名一起记进文件（`bootstrap-server.sh` 的注释一直承诺有这道检查，以前没有）。
`scripts/collect.ts` 原来不看 `COLLECT_ENABLED` 就带着 `force:true` 出网，用法示例还是 AIHOT 的两个 id
（传进去等于抓不到任何东西且 exit 0）；现在阀门关着要 `--force-collect`，认不出的 id 退非零。
`scripts/migrate.ts` 在 `DATABASE_URL` 没从环境给出时会落到默认串 `127.0.0.1:5432/aihot`（生产端口 + 上游库名）
并照样报成功；现在拒绝对话式默认值迁移。`publish-to-github.sh` 的 `GEOHOT_REPO` 与 origin 可以指向两个仓库
（比的是 A、推的是 B），且全流程只验"字节一致"不验"没有秘密"；现在要求同仓，并在 `commit-tree` 之前拦
`.env`/私钥/`*.pem` 路径与内网地址段字面量。另外 `delete-sources.ts` 改成默认 DRY-RUN、`--yes` 才动手
（与包里其它脚本一致），`tooling/ci-check.yml` 的 `^44$` 信源数改不成文事实（现值 90），
`scripts/mcp-check.ts` 零引用删掉。

**5. 记下来没动的。**
`digest.ts` 的 `inputs_hash` 让 1245 份"规则写的旧综述"永远返回 `unchanged`，人写的中文稿进不去
（要改的是早退那一步先看回执上的 `usage.brain.rule`）；被拒的付费调用没有记下 hash，于是每个故事都
再付一次（本机 302 条 `rule:no-signed-copy(digest)`）；`translateQuotes` 对一条永远解析失败的转推
每 5 分钟重付一次；`chatJson` 只按 zod 结构判"可用"，一个结构对但不可用的答案会被当成好答案永久复放；
身份判定会被空格与全角字面绕过（`中国地震台 网中心`、`ＮＡＳＡ`）；图片侧 GIF 一律不缩放
（`avatar-48` 可以是 15 MB）与签名输入用 `|` 拼接可被重新切分，两处都记着；`deliveries`/`receipts`
的清理仍受"复放读 `receipts.response`"这一条挡着（见上一轮第 4 条）。
**被本轮推翻的一条评审结论**：`detail.ts` 分组计数缺中文门槛"会造成数字比列表大"——我把那条英文报道做成
public + eligible + 已过释放时间 + 已归组，旧写法仍然不多算，所以那一处只是口径对齐（详见
`tests/publication-copy-gate.test.ts` 里那条测试的注释）。

**8. 第十八轮遗留：force 那一路的出处标记可能到不了闸门（未定论，下一轮查清）。**
`events/digest.ts` 本轮改成"在服务的那版如果是规则拼的，就不算已经写过"。测试里出现一个读数我没解释：
带 `attemptTag` 的 forced 调用（逻辑键与前面某次 forced 调用相同 → 走复放），stub 明明返回了
`usage.brain.rule = rule:no-signed-copy(digest)`、正文 100 字且是中文，闸门给的理由却是
`no-usable-copy` 而不是 `unsigned:rule:…`。按 `llm.ts:233` 的写法 `usage: response.usage ?? null`，
出处是从**复放回来的那份 response** 里读的；如果那条回执存的 response 属于更早一次（正文更短、且没有
brain）的答复，两个现象同时解释得通。**方向是安全的**（机器答的被拒，不会被写成签名稿），但若确实是
"复放丢出处"，那么一个又长又中文的机器答案在复放路径上会被当成有出处写进版面——那是红线，不是风格。
下一轮的查法：拿 `res.receiptId` 去 `SELECT usage, response FROM receipts WHERE id = …`，看复放那一次的
`response->usage->brain` 在不在；修法首选在 `chatJson` 的复放分支把回执自己的 `usage` 列（写入时带 brain）
一并返回，而不是让调用方从 response 里猜。本轮的测试只钉住"force 之后仍然不会把机器答案写进版面"这一半。

**9. 上面那条在同一天下一轮查清了：出处没丢，错的是去重键（已修）。**
复放回来的 `response.usage.brain` 是完整的（带着 fixture 时照样判成签名），所以不是"复放丢出处"。
真正的洞是 `attemptTag = force-digest:<storyId>:<version>`：被拒的重写**不推进** `stories.version`，
于是第二次点「重写」与第一次同一个键 → 复放第一次那笔被拒的答复，重写永远不会真的发生
（测试库里三条不同用例的 forced 调用共用 `force-digest:764:2`，全部返回第一次那段被丢弃的文本）。
修法：`force` 带上"这是哪一次操作"的 `requestId`（付费去重按它算），双击的护栏交给队列的 `singletonKey`
——两件事不再挤在同一个键上。顺手补上真正缺的那块：后台以前没有任何入口能传 `force`（只有脚本能），
所以"改完署名稿之后让综述重走一遍"这件事根本没有能点的地方；现在事件的诊断页上有「重写事件综述」，
理由必填、每次点击在审计里留一行 `story.digest-rewrite`。测试钉三点：两次点击=两个作业、
重复的 requestId 不产生第二个作业、换了 requestId 的 force 真的又打了一次模型。

## 第二十轮（2026-10-05 晚）：签名的字段边界、动图与静图、以及「这答案能不能用」第一次写在收据上

**1. 图片代理：`|` 拼接的签名输入与没人签发过的 mode。**
`media/imgproxy.ts` 那条待查落地。签名输入以前是 `${url}|${mode}|${exp}` 直接拼，而 `|` 在 URL 路径里是合法字符
（`https://example.org/a|thumb.png` 这种地址能过 `verifyProxyRequest` 的 URL 检查）：同一串字节可以被重新切成另一对
 (url, mode)，切出来的那个 mode 从来不是我们签过的——`images.ts` 查宽度表查不到就落 1600px，于是「拿 336 的签名换
一张 1600 的原图」是走得通的。现在每段带长度（`29:https://example.org/…|9:image-336|175…`），验签时同时认旧拼法
（RSS 阅读器与边缘缓存里 10-05 之前签的 URL 还要活两三天，拒掉它们等于把读者看得见的图弄裂），并且第一次把 mode
限制在 `IMAGE_WIDTHS` 的表内（`default` 除外，那是旧文章页不带 mode 的写法）。多了一个拒收理由 `bad-mode`：
GET 与 nginx 的 HEAD 鉴权子请求都回 403，且不再向上游取图。

**2. 单帧 GIF 以前按动图处理。**
`media/images.ts` 的条件写的是 `meta.pages > 1 || type === "image/gif"`，后半个把「所有 GIF 都不缩放」变成了事实：
`avatar-48` 的位置可以拿到 1200×900 的原图。本机 sharp 实测：同一张静 GIF 原样回 1820 字节，缩到 48 只要 80 字节；
而 `pages` 对 GIF 不加 `animated: true` 也报得出来（静图 1、动图 10），所以动图判定只看帧数。真动图仍然原样透传，
交给后台 `convertAnimated` 转动图 WebP（逐帧、延时、loop 不变，`tests/media-performance.test.ts` 钉着）；
静图从此和普通 PNG 一样缩放并转 WebP，透明保住。

**3. 「结构对、答案不能用」第一次有了统一说法：`chatJson` 的 `usable`。**
zod 只回答"形状对不对"，回答不了"这句话能不能印"。英文综述、空导语都过 schema，调用方把它们挡在版面之外，
但那份答复在收据里是**好答案**：同一个逻辑键之后每次组装都白拿这一份坏答复，永远不会自己好起来（除了人工 force）。
现在 `providers/llm.ts` 收一个 `usable(data) → 理由|null`：判定为不可用时把收据标成 `failed`，下一轮真的再问一次。
两条配套不变量写进 `providers/receipts.ts`：已经记账发出去的收据（`completed`）与等人来判的收据（`unknown`）都不会
被事后改成 `failed`（那会让同一份输入再付一次钱，且把后台的 resolve 流程架空）；反过来被拒收的收据也不许被
`completeReceipt` 顺手记成完成——调用方照样会把手里这份答复交给自己的编辑闸门，红线一侧（不发英文、不发没人签的字）
没有松动。接了三处：事件综述 `events/digest.ts`、日报导语 `reports/compose.ts` 的 `writeLead`、周报月报总述的
`unusablePeriod`（空的 themes 列表仍然是能用的答案，判定与旧表达式逐字一致）。
**转推引文那条循环没接**，理由是它每几分钟扫一次三天窗口，一份空答复明天还是空——为它每次重付不值；
这条取舍写在 `editorial/translate.ts` 的注释里。同一处补了两个真门槛：复用自家译文与写入 `quote_translations`
之前都要 `looksZh`，以前只挡"输入是不是中文"，模型把英文原样吐回来也会被当译文存下并印在页面上。

**4. 「今天」不再由浏览器自己算。**
`feed/Timeline.tsx` 与 `feed/DayList.tsx` 以前在渲染里各写一次 `beijingDate(Date.now())`：服务端 23:59:59.9 渲染、
浏览器 00:00:00.1 接水，两边就各认一个"今天"（控制台一条 hydration 不匹配），而「今天」那组的条数 `todayCount`
本来就是按服务端那一天算的，可能挂到另一天的标题下。现在两处都用那一份答复自带的时刻（`generatedAt`，
统一成 `lib/format.ts` 的 `todayOf`），主题页的答复因此补上 `generatedAt`（它不进 ETag，否则 60 秒的缓存永远打不中）。
介绍页那枚"今天几月几日"的角标仍然是浏览器现算的，那是有意的：它旁边没有任何服务端计数，并且带着
`suppressHydrationWarning`。

**5. 图集的 alt 与信源给的 alt_text。**
`item/MediaGallery.tsx` 以前把没有说明的图写成 `alt=""`——等于对读屏说"这张不必读"，而图集里的图就是这条推文的内容。
现在没有作者说明时按"第几张配图（共几张）"播报，大图按钮的 `aria-label` 也用它；视频封面仍然算装饰，因为外面的链接
已经说了它打开什么。另一半在采集侧：`providers/socialdata.ts` 的 `tweetMedia` 从来没有映射 `alt_text`，
而读取层 `publication/items.ts` 一直在读 `m.alt`——作者写的无障碍说明在入口就被丢了。现在留着（上游没给仍然是 null，
走上面那条按位置播报的兜底）。

**6. 顺手删掉的。** `IMAGE_WIDTHS.og`（1200）从来没有被签发过：全仓 `mode=og` 计数为 0，OG 图是自己画 SVG 的。
留着它等于在验签的允许表上开一个没人用的口子。

**7. 查过、确认不是缺陷的两条。**
R16C #4 说"读取层 `JOIN sources` / `JOIN articles` 会在对应行不见时让条目静悄悄消失"。实测开发库 2843 条
publications：孤儿 0，指向不存在 article 的 0。理由（这一条本轮按 `0001_core.sql` 逐行改对了，原来那句把
`fetch_runs` 的级联当成了 `articles` 的）：`articles.source_id` 是 `REFERENCES sources (id)` **不带**级联
（`:62`，也就是默认的 RESTRICT），`publications.article_id` 才带 `ON DELETE CASCADE`（`:212`），而
`publications.source_id` 根本没有外键（`:226`，它是发布时的拷贝）；所以想删一个还有文章的源，数据库直接拒绝，
`scripts/delete-sources.ts:72-73` 因此在同一个事务里先删 articles 再删 sources，两层一起带走，join 不会留下空档。
没有任何代码改写过 `articles.source_id`，"拷贝出来的 source_id 漂移"也走不通。JOIN 保持原样，不改成 LEFT JOIN
（那会把"源已经不在了"的条目重新放进度量里）。
R16B #7 说后台换模型没有期望值比较：两个管理员同时点，后写的覆盖先写的，审计行里的 before/after 可能不是同一条链。
事实如此，本轮不动这一处——加 CAS 要把"我看到的是哪个"从 UI 一路带到请求体（三个文件 + 一个 409 分支），
换来的只是后台一行历史更准，而 `audit` 已经把 before/after 与操作者都记下了。记在这里当待办，不当已修。

**8. 还没做的。**
`receipts.response` 仍然不能清（复放分支 `providers/receipts.ts:142` 直接把它交回调用方），所以 `receipts`/
`deliveries` 的保留期设计仍卡在这条上：真要清，得先让"没有 response 的收据"在复放时判为 miss 而不是回一个空答复。
`editorial/analyze.ts` 的 title/summary 质量判定没有接 `usable`——那条路径的重新发问由后台 rerun 与
`scripts/refill-copy.ts` 触发，是人给的信号，不需要机器每个周期再付一次。

## 第二十一轮（2026-10-05 晚）：浏览器控制台抓到的两处，静态评审看不见

**1. 站址由服务端说了算，浏览器不再自己猜（已修）。**
`lib/seo.ts` 的 `siteUrl()` 浏览器分支以前返回 `window.location.origin + basePath`。在生产那个域名下两者恰好相等，
静态读代码看不出问题；本机把站点开在 `127.0.0.1:3000` 而 `.env` 里 `SITE_URL=http://localhost:3000`，两个字符串
就不同了——React Router 在接水时会重跑每个路由的 `meta()`，于是首页的 JSON-LD `<script type="application/ld+json">`
报出一条 hydration 不匹配（浏览器控制台实测，2026-10-05）。这条错误每次加载都在刷，把真正的新错误埋掉。
现在服务端把自己那一份写进根布局的 `<html data-site-url>`（根 loader 的数据随文档一起交付，客户端读它而不是猜它），
`siteUrl()` 的浏览器分支读这个值；读不到（没有根数据的错误页）才退回 `origin + basePath`。
顺带把那条注释里已经写明的道理执行到底：读者从一个别名主机或 IP 进站时，旧写法会把 canonical/og:url 改写成
那个别名——正是注释里要避免的"把页面认成别人站点的规范版本"。实测修复后首页与 /all 控制台干净，
文档里只剩一条 canonical 且始终指向配置里的站址（`http://localhost:3000/…`，即便浏览器地址是 127.0.0.1）。
验证：web 工程 typecheck、`npm run build -w @aihot/web`、`node --test` 覆盖 meta 的两份文件 24 项通过、
`scripts/smoke.ts`（含 sitemap / 日报 / 站点索引 / v1 四处出口口径一致）全绿。

**2. 存量条目的机器标签当标题（浏览器实测发现，修法待定）。**
`/items/kdkvk052866t2g9vxrk7b3kri` 的 `<h1>` 与文档标题是 `title_zh:`——模型答"标题：（空）"时，那一行的标签本身
曾被当成中文标题写进了 `publications.title`。写入侧 10-03 已经堵住了（`editorial/writing.ts` 的 `LABEL_ONLY`，
commit `54eb6ac`，19:16）；开发库里 446 条这种行最晚一条 discovered_at 是 10-03 14:32，全部在闸门之前，
且 `indexable=false`、被中文门槛挡在一切列表/订阅/搜索之外（实测 timeline、pool、v1、日报、主题页、搜索都搜不到）。
所以现在的问题只剩一个：拿旧链接直接进来的读者看到的是机器标签，而不是一句实话。
待选修法（不新增付费调用、不改数据）：读取层遇到这种标题时，页面标题位退回来源自己的原标题并明说是原文标题，
或沿用第十轮事件页那种"本站没有可用中文稿"的诚实态。两种都要动 `publication/detail.ts` 与 `routes/item.tsx`，
与本轮评审波的管辖文件重叠，等有波次结论后一起改，避免两套口径。

**3. 评审波（五个只读智能体分片：读取层 / 作业与出处 / API 与后台 / web / 迁移脚本与文档）落实的。**
每一条都先按 file:line 复核过再改；不接的写在下面第 5 条。
- 读取层 MAJOR：`publication/rules.ts` 的 `isIndexable` 自动那一支以前只看"public + 有摘要 + 精选"，
  从不问有没有中文稿。于是精选而英文标题的条目——被 `chineseCopyCondition` 挡在所有列表、订阅、
  日报之外——照样进 sitemap、页面自称 indexable。实测开发库 11 条，生产 sitemap 里就有 `science-L5`。
  现在自动分支跟着中文门槛走，`seoIndexedAt`（编辑手工标记）那一支不变：标记本身就是人的判断。
  钉了两处：`rules.ts` 的纯函数测试（四种组合）与现有出口测试里行上 `indexable` 的真值。
  **存量的那 11 行不会自己翻**：`indexable` 是发布时算好存下的，只有那一行被重新发布（一次更正、一次重跑评估、
  一次编辑改动）才会写成新值；仓库里没有"只重发不算账"的脚本（`enqueue-analysis.ts` 会重新付费），所以部署后
  这几条 URL 还会在 sitemap 里留一阵。要不要为它写一个纯重发脚本，等站长点头（这是改数据面，不自动做）。
- 作业 MAJOR：抽取正文的消费者跟着 COLLECT_ENABLED 一起开关，但 `editorial/analyze.ts` 的
  `waitsForPage` 不看阀门。于是采集关着的环境里一篇"只有标题/摘要"的条目会被判成"等原文"，
  排进没人领的队列，`processing_state` 留在 `new`，五分钟一次的安全网每轮重排，`publishArticle`
  永远走不到。上一轮只堵了 `route()` 自己选这一支的路，显式 `step:"extract"` 那条还开着；
  现在判定与队列同一口径：没有消费者就不等原文，用手上的摘要判（与抽取最终失败那支同一个结果）。
- 后台 MAJOR：`POST /api/admin/stories/merge` 的 `reason` 一路裸传到 `audit()` 的 INSERT——字段缺失时
  postgres.js 绑 `undefined` 直接抛错，而合并的事务**已经提交**、综述作业**已经排队**：事件真的合了，
  操作者看到一个 500，审计里一行都没有。detach 与 ban 是同一族的两个小洞（前者把缺失的理由写成
  空串存进 `grouping_overrides`，后者在 `reason` 缺失时先抛 TypeError 报 500，轮不到 400）。
  现在三条都在动手之前要理由（`InvalidInput` → 400），路由侧统一 `String(… ?? "")`，封禁还多查一次
  "必须有来源标识"，免得写出一行封禁空字符串的规则。重跑（analyze/extract）以前只在 regroup 那一步
  要理由，现在三步都要：都是会再付钱或再出网的动作。
- 付费供应商：`providers/dajiala.ts` 只把 429/5xx 当拒绝，其他非 2xx（比如一块 HTML 错误墙）落进
  `JSON.parse` 抛 SyntaxError → 收据记成 `unknown`，那个逻辑键要等运维释放才能再问；而 jina 与
  socialdata 早就写明"非 2xx 即拒绝"。抽成 `statusGuard` 在两处调用，规则一处写。
- `routes/feedback.ts` 读 `X-Real-IP` 以前无条件信这个头，与 `app.ts` 自己写的"直连的进程不该信任何
  客户端能命名的头"矛盾：一旦有人绕过 nginx 直打这个端口，限次与封禁 rotate 一个头就绕过。
  现在只在 `TRUST_PROXY=true` 时读它，否则用 socket 地址。
- MCP：`maxRequestBodySize: 256KB` 这个选项在 SDK 文档里写明"对以 parsedBody 传入的请求体不生效"，
  而我们的调用方式永远传 parsedBody——它从来没起作用，真正生效的是 app 层的 10MB；删掉它，
  不再对外宣告一道不存在的闸。预检响应的 `Allow:` 也改成这个端点真的回答的方法（`POST, OPTIONS`），
  与文件里 `MCP_ALLOWED_METHODS` 那条注释一致。
- web：日报头图以前恒为 `alt=""`，而日报的图又永远没有图注（`reports.ts` 只在周报/月报给 caption），
  等于把读者最多的那一页上最大的一张图从可访问性树里删掉；现在没有图注时念「《标题》的配图」，
  有图注时仍留空（图注本身就是说明，两处都念会重复）。分页列表（/all、主题页、搜索）的日期以前
  渲染成一个 `disabled` 的按钮——那里没有折叠可展开，读屏念出来是"灰显不可用的按钮"；现在没有
  `onToggle` 就渲染成文本。X 帖子的条目页以前整个页面没有一级标题（`<h1>` 只在非 X 分支里），
  现在补一个 sr-only 的，用列表里同一行文字。`/all` 的"更新于"是唯一一处走运行时 ICU 的时间
  （下午04:31），与 `/hot` 的 16:31 两种写法；统一走 `lib/format.ts` 的 `beijingTime`。
- 两个页面各写了一份"来路折成去处"的表（`routes/item.tsx` 认 `/more`、`/leaderboard`、`/story/:id`，
  `routes/story.tsx` 不认），同一个 `?from=` 在两个页面给出不同的返回链接。合并成
  `lib/back-place.ts` 一处，删掉两张表与两份函数。
- 精简：`providers/embeddings.ts` 的 `cosine` 全仓无调用（真正在跑的同名规则是
  `events/group.ts:186` 的 `cosine32`），删。
- 运维脚本：`install-units.sh` 是这一族里唯一没有 DRY-RUN 的（注释里自己承认"加 --apply 是合理的
  下一步，但不在这轮范围"）——它一跑就 `sudo tee` 四个单元文件并 `daemon-reload`。现在默认只把将要
  写入的内容打到终端、一行 sudo 都不发，`--apply` 才动手。`publish-to-github.sh` 的秘密扫描以前把
  `deploy/geohot/`、`docs/`、`README` 整目录排除掉，恰恰排除了这些字符串最可能出现的地方；现在只放过
  占位符形状、`.gitignore` 与扫描器自己的正则。路径黑名单与 `.gitignore` 那一族对齐
  （`*.key`、`*.p8`、`secrets*`、`credentials*`、`id_*`），但放过 `.env.example` 这两个模板——
  实测新黑名单在当前树上零命中；加 `.example` 白名单之前会误伤那两个模板（改的时候抓到的）。
- 文档按实测改正：`README.md` 里"那 41 条 `defaultCategory`"改为 46（`node -e` 数出来的，另一段本来就写 46）；
  迁移条数"现值 40"改为 41（`ls | wc -l` = 41，`schema_migrations` = 41）；上一轮我自己写的一句外键结论
  引错了行——`ON DELETE CASCADE` 属于 `fetch_runs`，`articles.source_id` 其实**不带**级联（默认 RESTRICT），
  带级联的是 `publications.article_id`；结论不变（孤儿仍然不可达，而且更强：数据库会直接拒绝对仍有文章的
  源做删除）。

**4. 浏览器里看到的 /leaderboard 404，查过不是缺陷。** `industry/features.ts` 里 `leaderboard: false`，
`apps/api/src/app.ts` 与 `routes/site.ts` 在功能关着时不注册那两个端点，`nav.ts` / `more.tsx` 也跟着不列——
路由文件还在，但 loader 拿不到数据就 404。这是"关掉的功能不装作在"的正确形状（web 评审智能体独立
得出同一结论）。

**5. 波次里报上来、这一轮没动的。** 都在读取层与后台的"潜在 / 口径"级别，写下以免被当成已修：
`publication/detail.ts:184` 与 `feeds.ts:83` 还各写一份"正文是不是中文"（第三、第四份），
`contracts/copy.ts` 的 `bodyIsChinese` 才是那一处——今天不可达（`body_mode='full'` 零行），一旦开全文就分叉；
`reports.ts:378` 与 `ReportPaper.tsx:372` 的「N 件大事」是两条公式（一条按有页面的引用数、一条按去重后的
分栏数），现在的真实数据两边都是 29；`pool.ts:216` 的 `freshness` 是全池口径却和筛选口径并排显示，
而且它在 ETag 载荷里，任何一条 eligible 更新都会打掉所有筛选页的缓存；
`items.ts:142` 的 topic 条件遇到"主题没有标签"时等于不加过滤，而主题页自己会显示零条（43 个主题今天都有标签）；
`admin/selectbench.ts` 的 `report` 仍是未校验的 `unknown` 直接绑进 INSERT（类型错会报 500 而不是 400）；
`site.ts:35` 的 `cacheUntil` 在 seconds=0 时设的 `no-cache` 是死分支；条目 id 的字面规则在五个地方各写一遍
而 `contracts/taxonomy.ts:53` 已经有 `ARTICLE_ID_PATTERN`；`contracts/site.ts:396` 的 `ReportNavigationEntry.count`
从不写也从不读；`operations/backup.ts:43` 的注释说 `signV4` 是给测试用的向量检查，全仓没有那样的测试。
另有两条在等站长决定：`receipts`/`deliveries` 的保留期（第 8 条那两个前提之一仍未解），
以及本条上面第 2 段那个存量 `title_zh:` 标题的诚实态改法。

## 第二十二轮（2026-10-05 晚）：把第 5 条里的潜在分叉一条条收掉

**1. 「正文是不是中文」回到一处。** `publication/detail.ts` 的 markdown 导出写的是 `row.language === "zh"`，
`publication/feeds.ts` 写的是 `r.language !== "zh"`，而 `contracts/copy.ts` 的 `bodyIsChinese(language, sample)`
才是这条规则本来的家（页面的那一处早就用它）。三处对 `language IS NULL` 的中文原文（开发库 2726/2843 条是
null）答案不同：页面说这是中文稿、markdown 说"正文 · 原文"、全文 RSS 优先给译文。今天不显形（`body_mode='full'`
零行、所有源 `site_fulltext=false`），一开全文就分叉。两处改成同一个调用。

**2. 一个没有标签的主题，不再等于"没筛"。** `items.ts` 的 `topicCondition` 以前对 `[]` 与 `null` 返回同一个空
条件：主题页自己（`topics.ts` 用 `p.tags && '{}'`）回答零条，而"该主题"的时间线/全部动态回答整池。现在
`null`（没问主题）仍是空条件，`[]`（问了但主题没有标签）是 `AND false`。43 个主题今天都有标签，所以这是
把一条走得通的路堵在源头，而不是改坏现状。

**3. `/all` 的「更新于」改成这一屏的口径。** `pool.ts` 的 `max(p.updated_at) FROM publications WHERE eligible`
是全池的，页面却把它印在"这个筛选下找到 N 条"旁边，而且它进 ETag 载荷——任何一条 eligible 更新都会打掉
所有筛选页与搜索页的缓存。现在与 `today_count` 同一套成员条件（listed + eligible + filters）。

**4. 归档的「N 件大事」与报纸自己印的数，是一个公式。** `reports.ts` 以前数的是"引用里还有页面的"（不去重），
`ReportPaper` 数的是分栏排出来的条数（按 key 去重、划掉的那几行照样印）。两边今天恰好都是 29，一旦有撤回或
一条被两处引用就分叉。现在索引那侧 `new Set(citedItemIds(...)).size`，与版面同一口径。
**顺带推翻评审里的一条**：`contracts/site.ts:396` 的 `ReportNavigationEntry.count` 不是死字段——
`routes/daily-archive.tsx:64` 就在印它（`{e.count} 件大事`），所以这里改的是"两条公式并成一条"，不是删字段。

**5. `cacheUntil` 的 `no-cache` 那一支以前是死的。** 它自己 `reply.header("Cache-Control", …)`，唯一的调用方
又把返回值交给 `sendJsonWithEtag`，后者再写一次同一个头——于是释放时间不足 1 秒时那次设置的 `no-cache`
没人看得见。现在 `cacheUntil` 只负责 `X-Accel-Expires` 并**返回**该发的值（`seconds===0` 时返回 `no-cache`），
Cache-Control 由出口一处写。

**6. 条目 id 的字面规则从五份并成一份。** `apps/api/src/routes/site.ts`（三处）、`publication/availability.ts`、
`apps/web/app/lib/local-state.ts` 各写了一遍与 `contracts/taxonomy.ts` 的 `ARTICLE_ID_PATTERN` **逐字节相同**的
正则（实测过：五个写法一致），现在都指向它。`local-state.ts` 保留 `ID_PATTERN` 这个名字只是因为它有四行在用。

**7. 存量 `title_zh:` 的条目页（第二十一轮第 2 条）改了。** 写入侧 10-03 就堵住了，但开发库 446 行的
`publications.title` 与 `summary` 仍是那句机器标签，旧链接直达时读者看到的是标签。读取层现在遇到这种
"只有标签、后面什么都没有"的标题就退回来源自己的 `original_title`（实测这 446 行全都有 original_title），
摘要同理置空——这正好是页面那句"以下标题与提要是原文"一直在说的事。规则本身（`LABEL_ONLY_COPY` /
`isLabelOnlyCopy` / `LABEL_PREFIX`）搬进 `contracts/copy.ts`，`editorial/writing.ts` 用它，不再自己抄一份。

**8. 第 5 条那份清单里，这一轮仍然没动的**：`admin/selectbench.ts` 的 `report` 仍未校验（类型错报 500 而不是
400）；`ITEM_COLUMNS` 里 `eligible`/`backfill`/`syndicate` 三个字段是否真的无人读，需要逐个出口核（评审说无，
本轮没验证就先不删）；`receipts`/`deliveries` 的保留期；后台换模型的期望值比较；那 11 行 `indexable` 的
重发（要站长点头才动数据）；以及 `operations/backup.ts:43` 那句"导出给测试做向量校验"的注释——全仓没有那个
测试，注释按现状改成了"给签名复算用"。

## 第二十三轮（2026-10-05 晚）：读者端全表面走查，抓到更新日志页一个真的坏掉的功能

**1. 更新日志的"类型"以前是封闭枚举，而数据早就长出新的了（已修）。**
`routes/changelog.tsx` 把 `kind` 声明成 `"更新" | "优化" | "公告" | "下线"`，颜色表 `KIND_DOT` 也只有这四个键；
而 `industry/changelog.json` 里实际出现过 7 种：还有 修复、扩充、精简。JSON 是运行时读进来再 cast 的，
TypeScript 看不见这个不一致，于是两个读者可感的后果一直挂着：
- 每条目头上那枚"这是什么类型"的小圆点，对这三种新类型渲染成 `class="size-1.5 rounded-full undefined"`
  ——没有底色，等于没有类型标记（实测 `/changelog` 一次加载里出现 3 处）；
- 侧栏「按类型看」只列四个硬编码类型，`修复` 这一大类产品**根本筛不出来**，只能在「全部」里翻。
现在 `kind` 是 `string`，颜色表 `Record<string, string>` 加 `kindDot()` 兜底（未登记的类型给灰点，
不会再掉色），筛选列表由文件里真的出现的类型生成（实测：全部 / 修复 / 扩充 / 精简 / 下线 …）。
`docs/customize.md` §8 补了一句：`kind` 是自由文字，别当封闭枚举改。

**2. 后台导入评测运行不再把操作者的错报成服务器故障。** `admin/selectbench.ts` 以前把整份 report 当
`unknown` 直接取用，`caseId/title/gold/score/receiptId` 一路绑进 INSERT——一个字段类型不对就是 Postgres
22P02 → admin-auth 的 500。现在 cases 与 meta 各过一个 zod schema（`admin-auth.ts:81` 已把 ZodError 统一
映射成 400，并只报前三个字段名），并且**只查类型与必填、不加长度上限**：这些列都是 `text`，一条长标题
不是操作者的错。（`scripts/eval-selection.ts` 就是这份格式的生产者，实测它的 `score` 可以是小数，
所以 `score` 不能要求整数——差点把正常导入判死。）

**3. 走查里确认"不是缺陷"的三处。** `/contact` 404：仓库里没有任何链接指向它，二维码在 `/about`
（`/api/site/contact` 只是它的数据源）；`/leaderboard` 404：`industry/features.ts` 里 `leaderboard: false`，
api 那侧不注册端点、nav 与 `/more` 也不列（第 21 轮已经记过一条同样的结论）；`/api/site/hot` 返回
`entries: []` 而 `/hot` 页 200 带诚实空态，是本机没有榜单数据的已知状态，不是接口坏了。

**4. 一处评审建议我没照做。** 读取层评审说 `ITEM_COLUMNS` 里的 `eligible`/`backfill`/`syndicate` 无人读、
可以删。核过：`pageFacts()` 只需要 `visibility/source_mode/selected/visible_after`（`detail.ts:48`），
`syndicate` 确实被 `feeds.ts:99` 用（它自己那份 SELECT，但 `FeedRow` 是从 `ItemRow` Pick 出来的）。
把三列从 SELECT 里摘掉而类型声明还留着，风险是运行时 `undefined` 而 TS 全绿；省下的是每页几十字节。
不值，先不动；这里记一笔免得下一轮重新论证一遍。

**5. 行为走查跑过什么（本轮实测，全部按现状可用）。** 搜索 `/all?q=…`：200、`robots=noindex`、有命中；
`<script>` 探针转义正确；`?page=2` 有「上一页」；`?page=9999` 被夹到 50 页并老实写出
「最多提供 50 页，更早的内容请使用搜索或主题页」（不是假空列表）；`/items/<id>/markdown` 200 `text/markdown`；
`/og/items/<id>.png` 200（67 KB），不存在的 OG 404；`/api/site/items/availability?ids=…` 返回
`{"<真条目>":"public","nope":"unavailable"}`；条目 id 形状不对 404 而不是 500；`/api/v1/items?limit=9999` 400；
`/api/mcp` 的 `tools/list` 数出 7 个工具（接入页不写死数字）。
两处"按现状可解释、不改"的宽容：`/all?category=nope` 与 `?channel=nope` 会退回不筛选（筛选条上就没有选中项，
页面说的与自己显示的一致），而 `?topic=…` 根本不是站内会生成的参数（grep 无生产者），所以也不去为它加 404。

## 第二十四轮（2026-10-05 深夜）：接平台层信源，顺带把"抓到的封面为什么从没上过屏"查清

**1. 信源接到平台层（用户指示：拓展 X、YouTube 等官方媒体平台）。**
`industry/sources.json` 90 → 101 条。分两种情况，取决于那个平台要不要钱：

- **YouTube 不要 key**：每个频道都有一张服务端渲染的 Atom（`https://www.youtube.com/feeds/videos.xml?channel_id=UC…`），
  本站的 `rss` 采集器直接能吃。登记 3 条：`rss-youtube-usgs`（`@usgs`）、`rss-youtube-nasa`（`@NASA`）、`rss-youtube-noaa`（`@NOAA`），
  每条实测回 15 项。**频道 id 只能从「关于」页的 `channelMetadataRenderer.externalId` 拿**——在频道页 HTML 里抓第一个 `UC…`
  会抓到侧栏推荐：这么"接"回来的 `@NASAEarth` 是一个人的私人频道、`@UNOSAT` 是一段 2010 年的雪景视频，两者都通过了"URL 打得开"的探测。
  取回后再验 feed 的 `<title>` 与 `<author>` 是不是这个 handle 的主人，才是信源。`@esri` 频道真实存在但上传列表回 **0 条**
  （视频都排在播放列表里），因此不登记——一条永不产出条目的信源不是信源。
- **X 要 `SOCIALDATA_API_KEY`，本部署没有**：8 条官方账号（`@USGS` `@NASA` `@NOAA` `@WMO` `@CopernicusEU` `@un_ocha` `@Esri` `@metoffice`）
  照 `from:<handle> -filter:replies` 登记，但**全部 `enabled=false`**。账号存在性不花钱：`https://x.com/<handle>` 的页面标题就是
  「名称 (@handle) / X」，八个逐个核过（显示名按页面标题写：UN Ocha、Met Office）；猜的 `@esrigeo`、`@CMA_Weather`、
  `@china_meteo`、`@gdacs_asi` 全部 404，没有写进表。`mp_account`（微信公众号）一条都没登记：它的 `ghid` 只有付费查列表才拿得到，
  现在写进去的任何 `gh_xxxxxxxx` 都是编造。要接就先补 key。

**2. 抓到的视频封面从来没上过屏（本轮查清并接上）。**
`sources/rss.ts` 的 Atom 分支只读 `<content>` 和 `<summary>`，而视频频道把简介放在 `media:group/media:description`、
封面放在 `media:thumbnail`、"这是一条视频"放在 `yt:videoId`——三个都不在它的读取范围内，所以即便信源接进来，条目也是
一条没有图、没有说明的空壳。改法是补上 `media:group` 这一族：简介进 `excerpt`，封面进 `media`，并标成 `kind:"video"`
（`url` 是观看地址、`poster` 是封面、带上 480×360 宽高），而不是伪造成一张"配图"。
连带两处才让读者真的看得见：
- `content/extract.ts` 的 `pageFetchable()` 以前只把 x.com / twitter.com / mp.weixin.qq.com 划成"要么整条到手、要么拿不到"，
  于是每条视频都会被拿去抓一次 watch 页（提不出正文，还会顺手调用按次计费的渲染兜底）。现在 youtube.com / youtu.be 同列，
  条目按"标题 + 简介 + 回原站"评分，不再白跑一次出网。
- **读层根本没把封面交给页面**：条目页的图集此前只有 X 帖子那一条路径（`routes/item.tsx` 的 `isX && item.x.media`），
  而日报头图的选图 SQL 明确写了 `m->>'kind' = 'image'`，所以 `articles.media` 里的视频封面在站内没有任何一处会被读到。
  现在 `publication/items.ts` 加 `videoMedia()`，只收"有封面的视频"这一种，`ItemDetail.media` 带上它，条目页交给已经存在的
  `MediaGallery` 渲染成一块能点回平台的封面。**文本信源的配图仍然一张都不上屏**：本站转述摘要、不转载图片，这条口径没动，
  只是视频本来就没有"正文"可转述，封面是平台自己用来指代那条视频的图。
- 实测（本机 dev 库，样本跑完即删）：抓 `rss-youtube-usgs` → 15 条入库、`initialBackfillLimit=5` 生效、
  `media` 落库为 `kind=video` + poster；给一条建公开记录后打开 `/items/<id>`，页面上确有 1 张图，
  `src=/api/img-proxy?u=https%3A%2F%2Fi1.ytimg.com…`，`naturalWidth×naturalHeight=278×209`（签名代理真取回并缩放了远端图），
  4 个链接指向 youtube.com，控制台无报错。永久检查：`tests/video-source-page.test.ts`（读层，含"文本配图不算数"与"没有封面就是空数组"）、
  `tests/media-performance.test.ts` 末条（`videoMedia` 的取舍）、`tests/sources.test.ts` 的 `/video.xml`（采集侧）。

**3. 信源包的规矩以前只在入库时校验；一变成 CI 检查就抓到 6 条悬空归属（已修）。**
`scripts/seed.ts` 里的三条规则（config 键过白名单、`defaultCategory` 是真的分类、`owner_entity_id` 非空时必须是 `ENTITIES` 的键）
需要连着数据库才跑得到，包 `$comment` 早在 2026-10-01 写下"每个非 null 值都是 ENTITIES 键"，但 85→90 那两轮扩容又放进去了
`ogc`、`qgis`、`crisisgroup`、`unocha`、`loc`、`eseh` 六个悬空值。新增 `tests/industry-pack-sources.test.ts`（不连库）把它们钉住，
顺带钉住"按次计费必须登记为停用"——没有 key 的部署里一条 `enabled=true` 的 `x_search` 只会排出一串注定失败的付费请求。
六条按同一条既有规则改成 `null`：它们的运行时表现本来就是"无主体"（`editorial/writing.ts` 的 `lexiconName()` 查不到就返回空），
这一改只是让仓库里的说法和行为重新对上。要恢复归属得往 `ENTITIES` 补条目，那是 taxonomy 的事，不在本轮里造字符串。
dev 库里的旧值也按包内规矩重放了一遍（`UPDATE sources SET owner_entity_id=null`，6 行）。

**4. Agent 用的同步快照会吐出已经没有详情页的条目（已修，含一条迁移）。**
这条是本轮全量测试跑红才暴露的，而且它先是伪装成"测试不稳"：`tests/publication.test.ts` 的
`minimal sync projection…` 断言"续页翻到底 `hasMore=false`"，实际拿到 `true`。查下去的形状是——
`selected_ledger` 是给客户端重放的变更日志，`selected_state.in_set` 是写入侧用来判断"要不要再追一条"的差异表，
而 `/api/v1/selected/snapshot` 以前**只靠这张差异表**决定一条还在不在集合里。`selected_state` 一个外键都没有：
删掉一行 `articles`（级联清走 `publications` / `analyses`）之后，状态行原样留着、`in_set` 还是 true。
2026-10-05 本机 CI 库实测：`selected_state` 1311 行、其中 **1055 行 `in_set=true` 的文章行已经不存在**，
快照于是把这 1055 条当作在线精选吐给 Agent，而每一条的详情页都是 404；`publications` 里真正 selected+public 的是 0 条。
同一形状在测试里每跑一轮涨一截（`tests/setup.ts:83` 的 `purgeTagged` 删文章靠级联清理，级联到不了一张没有外键的表），
所以它平时看起来"只是测试不稳"，在生产里是机器可读出口在说谎——与第二十一轮那次
"快照 59 条对首页 48 条"是同一类裂缝，只是这一次裂缝在表与表之间。
两条动作各管一件事：
- 读取侧不再信那份拷贝：`publication/v1.ts` 的 `selectedSnapshot` 把成员判定改成
  `JOIN publications p ON p.article_id = latest.article_id AND selectedCondition(now)`——首页时间线、v1 selected、RSS
  用的就是这一条门槛，"没有页面的条目不进集合"因此只有一份表达式。这条不依赖迁移，装上即生效。
- 迁移 `0045_selected_state_article_cascade.sql`：先删既存悬空状态行（CI 库 1055 行，本机 dev 库 1 行），
  再补 `selected_state.article_id → articles.id ON DELETE CASCADE`。
`selected_ledger` **刻意不加级联**：把历史行跟着文章删掉，会让游标停在删除点之前的客户端永远学不到这条消失
（`selectedChanges` 只回 `seq` 大于游标的行），而快照才是重新对齐的机制。迁移文件里把这条理由写全了。
永久检查：`tests/publication.test.ts` 新增"文章行被硬删之后条目离开快照"（先确认真的在集合里，再删行，再确认为止）；
CI 库与 dev 库都已 `schema_migrations=42`、悬空状态行 0。

**5. 走查里那 10 个 FAIL：8 个是我取证的方式错了，2 个查清了。**
真跑过之后确认**可用**的（附实测口径，别再当"没验证"）：日栏折叠（最大日 36 条：47→11→47，`aria-expanded` 跟着翻）；
多信源分组展开（点「另有 1 家信源报道」，条目链接 47→48）；主题切换（那三个控件的 role 是 **radiogroup + radio**，不是 button，
所以我第一次的 `getByRole("button")` 数到 0 ——点选后 `data-theme=dark`、`localStorage` 存住、跨页面保留、方向键在组内移动，
`aria-checked` 只有一个为 true，语义是对的）；分类筛选（`/all?category=physical`）；搜索（`?q=预警` 命中 23 条，
`#site-search` 保留已提交的词、「清空」按钮确实在）；无结果空态（0 条 + "没有找到相关内容 / 换个说法，或者去掉筛选再试"，
且此时「清空」也在）；翻页（`/all?page=2` 存在，之前判"没有 page=2"是因为还挂着上一步的搜索词、只剩一页）；
`/` 聚焦搜索框；收藏闭环（本地 1 条 → `/starred` 那一条在，只是渲染成 `li` 不是 `article`，我数错了元素）；
更新日志按类型筛选（按钮名带数量，"修复 14"，231→59→231，`aria-defined` 类名 0 处——第二十三轮的修复成立）；
反馈草稿（写入 `aihot-feedback-draft-v1`，刷新后回到输入框）；`/hot` 空态是诚实的（"过去 48 小时还没有讨论够热的地理事件" + 两条出口）；
后台登录（真实路径是 `/admin/login`，不是 `/admin-login`，落地 `/admin/sources`）。
两个需要判定的：
- **冷加载后焦点落在 `main`、跳过导航链接不是第一焦点——查清是 dev 服务器的产物，构建产物上不存在。**
  dev 服务器上实测确实如此：`document.activeElement` 一进来就是 `#main`，第一个 Tab 到达的是正文区的第一个链接，
  `跳到正文` 得靠 Shift+Tab 才回得去，而 `root.tsx:165` 那个 `first.current` 守卫的用意正是"冷加载时读者属于文档顶部"。
  按 `npm run build -w @aihot/web` + `npm run start` 起构建产物复测（同一份代码，只差 dev/生产）：
  冷加载后 `activeElement=BODY`，Tab 顺序是 `跳到正文(#main)` → `GEOHOT` → `精选`，跳过链接确实是第一焦点，激活后焦点进入
  `main`，控制台 0 报错。所以这条只在开发模式出现，机制没有继续往下挖（要挖，入口是 `root.tsx` 里那个 `first.current`
  守卫——dev 下根组件的 `pathname` effect 像是被多跑了一次，第二次就不再被当成首次）。**结论：不改代码**——为了让 dev
  模式好看而给生产路径加守卫，是把开发环境的噪声搬进产品；这条记在这里，是为了下次有人在 dev 服务器上看到同样现象时不必再查一遍。
- **本轮新增的浏览器面（视频封面）已实测**：见上面第 2 条的最后一段（`/items/<id>` 上确有 1 张经签名代理取回的封面，
  4 个链接指向平台，控制台无报错）。其余走查覆盖的都是既有功能。

**6. 本轮仍然只在仓库里。** 线上是旧版；部署与公开仓库发布等用户点头（这一条从第十七轮起一直没变）。
新的迁移 `0045` 也要等部署才在线上生效——它只做删悬空行 + 加外键，回滚不需要动数据。
按次计费的 X 账号需要在 `.env` 补 `SOCIALDATA_API_KEY` 才谈得上启用；`DAJIALA_KEY` 是公众号那条路的前提。这两个都属"要花钱"的口径，
不在自主决定的范围里。

## 第二十五轮（2026-10-05 深夜）：把真数据碰不到的五条读者路径插样本点了一遍，抓到上一轮自己写死的一句措辞

**为什么必须插样本**：开发库里 `body_mode='full'` 0 行（所有源 `site_fulltext=false`）、带 media 的 X 帖 0 条。
于是「全文阅读模式 + 内联图」「本文目录（要 ≥3 个小标题）」「导出 Markdown」「X 图集 + 灯箱」这四条链路
**在任何一次浏览器走查里都不会出现**——按钮与菜单项压根不渲染，点不到就等于没验过。本轮按仓库自己的夹具写法
（`upsertMaterial` + 一条 `origin='rule'` 的判断 + `publishArticle({releasedAt})`，措辞是 `r25*` 标记的样本句，
跑完即删）造出这三类条目，逐项实测：

- **全文条目**：正文内联 2 张图，经签名代理取回后 `naturalWidth=480`；`main h2/h3` 四个都有 id；
  侧栏「本文目录」列出 4 条锚点；点「数据口径」`location.hash=#sec-3`、`scrollY=993`，落点正确。
- **导出 Markdown**：`GET /items/<id>/markdown` 在 3001 与 3000 **都回 200**、`Content-Type: text/markdown`、
  `Content-Disposition: attachment; filename="geohot-<id>.md"`——`contracts/http-policy.ts` 的
  `API_OWNED_PATTERNS` 第 127 行确实收了这条路径，开发边缘与生产同源。浏览器里菜单那一项是
  `<a href download>`（不是 button），点它触发下载，落盘 1243 字节、首行是 `# 标题`。
- **X 图集与灯箱**：两块图，可访问名是「配图 1/2（来源未提供说明）」与「配图 2/2（…）」（第二十一轮立的
  "内容是数据就说它是内容"在这里生效）；点第一块 → `role=dialog` + 计数「1 / 2」+ 图 480×360；
  `ArrowRight` 换到第二张（src 换成第二条签名地址）；`Escape` 关闭后焦点回到
  `BUTTON「查看大图：配图 1/2（…」`——回位到触发元素，不是丢给 body。
- **分享海报**：真实条目上就可用。`更多操作 → 生成分享海报` 弹层里是服务端渲染的 `/og/posters/<id>.png`
  （不是 canvas，我第一版探针找 `canvas` 所以数到 0），`naturalWidth=1080`，另有 `a[download]` 锚点，
  点击落盘 `geohot-<id>.png` 70,914 字节。
- **视频块的措辞（本轮修掉自己的缺陷）**：第二十四轮接视频频道时，`MediaGallery` 里那句
  `aria-label="打开原推播放视频"` 是 X 时代的写死措辞，YouTube 视频块被读屏念成"打开原推"。现在
  `videoLabel` 由调用方给：X 仍是「打开原推播放视频」，视频频道是「打开原视频观看」。
  两条都在浏览器里读过 `aria-label` 确认，`pageFetchable`/读层那几处未受影响。

**取证方式的三条教训（写下来免得下轮再误判成缺陷）**：主题三兄弟是 `role=radiogroup` 里的 `role=radio`，
用 `getByRole("button")` 数会得 0；后台登录路径是 `/admin/login`（不是 `/admin-login`）；
下载类控件是 `<a download>` 而不是 button，`getByRole("button",{name:/下载|保存/})` 抓不到。
另外收藏页的条目是 `li` 不是 `article`，按元素数卡片会把可用功能判成失败。

**未改的**：`selected_ledger` 的历史行仍然留着（本轮样本的 upsert 也在里面留下 seq，快照不再吐它们，
因为成员判定已改为看活的 `publications`）；dev 库里 `body_mode='full'` 依旧是 0 行——放开全文是**许可口径**，
属站主决定，不是本轮能替他做的。

## 第二十六轮（2026-10-05 深夜）：给机器读的精选集合里的「幽灵条目」，与采集/代理侧的三处口径

**1. 同步出口不再把打开不了的条目当成在线内容发（真缺陷，评审波报出、我复现同一组数字后才改）。**
`selectedSnapshot` 以前按 `selected_state.in_set` 判成员，而这张表是写侧的差量表（`payload_hash` 决定下一次要不要记账），
没有任何一处在文章行被硬删时跟着清——CI 库实测攒了 **1055 条 `in_set=true` 而文章已经不在了**，接口照旧把它们发给 Agent。
现在成员判定改成活的 `publications` 上的 `selectedCondition`，与首页时间轴、RSS 同一条表达式；`selectedChanges` 也在出口处判：
账本里那条 `upsert` 若已不满足门槛，就按 `remove` 交付。本地实测那一批最新 `upsert` 66 条里 18 条过不了本站自己的门槛
（11 条文章还在、7 条已被删），而这 18 条在账本里**一条 `remove` 都没有**——落后的客户端就这样永久留着 404。
补的外键在 `0045_selected_state_article_cascade.sql`（先清历史残留再加约束）；**账本本身刻意不加级联**，
否则游标跨在删除点之前的程序永远等不到那条「消失」通知。

**2. 采集侧的配图从"闸门"改成"合并"。** 一条 feed 自己带的图片以前会被正文提取结果整块挡掉，现在按 URL 去重后并入，
上限 6 张（`sources/collect.ts`）。文本信源的展示口径没动——本站转述摘要而不是图片，上屏的仍然只有图集路径认的那几类。

**3. MRSS 的命名空间前缀不再写死。** YouTube 用 `media:`，别的 feed 用 `m:`，也有裸标签名的；
读法改成"先按 `media:<名>`、再按裸名、最后按任意 `<任意前缀>:<名>`"，缩略图取**最宽的那张**而不是第一张。

**4. 图片代理的 400 与 403 分了家。** 参数根本没法尝试（无参数、`u` 不是 URL、mode 不是本站签发过的）是调用方的错，答 400
（nginx `auth_request` 那路子请求答 401）；签名不对或过期才是拒绝，答 403。两种都在向上游取图之前返回。

**5. 仓库里的数字与代码位置按实测改正**（收尾在第二十七轮）：`industry/sources.json` 的 `$comment` 里
`collect.ts:88`→`:210`（跳过 external 的那一行早就不在原处）、`config-keys.ts` 给 external 的白名单是
`publishedAtUtcOffset` 一个键而不是空数组、`tests/industry-pack-sources.test.ts` 的归属断言行号、
以及 `T2` 的天花板 63→**62**（`industry/selection.ts:85` 的现值）。

**6. 我自己写错的测试**：`selectedChanges` 交付的 `upsert` 行**没有 `id` 字段**（`{op, changedAt, item}`），
按 `c.id === 文章 id` 过滤永远筛不出东西，看起来就像"复放没回来"。筛 `(c.id ?? c.item?.id)` 才对。

## 第二十七轮（2026-10-06 凌晨）：视频频道按站长的磁盘口径撤下；条目页交互的三处健壮性

**1. 站长的问题是「视频会占用我本地的存储空间吗？如果会占用就不要这个信源」。** 事实链查清：
视频文件从不下载，库里 `articles.media` 只有观看地址、简介和封面 URL；但条目页那张封面和站内所有图片一样走签名代理，
`packages/backend/src/media/images.ts:12` 把渲染结果写进 `data/imgcache`（`operations/retention.ts:37` 三十天后清），
本机该目录 410K。**"会占一点本地磁盘"成立**，按他的规则撤下三条 `rss-youtube-*`：信源包 101 → **98**
（可轮询 82 = `rss` 53 + `web_list` 26 + `json_list` 3，`external` 8，`x_search` 8），
`first_party` 53、`defaultCategory` 54、T2 32；开发库 `sources` 表 103 → 100 行（三条 0 篇文章，直接删）。
`tests/industry-pack-sources.test.ts` 里"包里必须有一条 YouTube 频道"那条断言随之删除。
**采集与读取两侧的 MRSS 支持与用例保留**——`providers/socialdata.ts:118` 从 X 带回的视频走同一个 `videoMedia`，
X 的额度到位就需要它；频道 id 与逐条实测记录留在 `docs/sources.md` 的「平台信源」一节，接回来照那一节做。

**2. 关掉「更多操作」菜单后焦点掉回页面开头。** 菜单项在退出动画（140 ms）结束时被卸载，浏览器不会替它挑去处，
键盘读者从 `<body>` 重新一格一格 Tab。`components/ui/Menu.tsx` 现在在关闭时把焦点交回触发按钮——只在焦点确实进过菜单时
（鼠标点空白处关闭不该抢焦点）。

**3. 三个浮层"把焦点还给打开它的东西"这条规则加了一道闸。** `lib/focus-when-ready.ts` 新增 `returnFocus()`：
节点已经不在页面上就不动。海报/目录浮层是从菜单项里唤起的，那个 opener 注定会先消失，原来那句 `opener?.focus()` 是空操作。

**4. 复制与分享失败不再静默，也不再谎报成功。** 条目页的「复制链接」「分享链接」以前 `catch {}`，读者点完什么也没发生；
现在给一条 toast 并写明下一步（手动复制地址栏）。`components/CodeBlock.tsx` 那条更糟：剪贴板 API 失败退到 `execCommand`，
而 `execCommand` 的返回值被丢掉——两条路都没走通页面仍然印「已复制」。现在按返回值判，失败写「复制失败」。
海报浮层的「分享」也分开了：读者在系统面板按取消（`AbortError`）不算失败，取图失败或被面板拒绝才提示"分享没有成功，可以先保存图片再发给朋友"。

**5. 按需加载的浮层失败不再带走整篇文章。** `PosterSheet`/`TocSheet` 是两条独立 chunk，挂在
`<Suspense fallback={null}>` 下而没有边界——chunk 下不来（离线、或页面比新版本旧）就在渲染时抛出，
一路撞到 `root.tsx` 的边界，把读者正在读的文章换成错误页。现在各套一层 `components/ui/ChunkBoundary`：
给一句"没能加载，请刷新页面重试"加一个关闭按钮，文章照读。**注意 `lazy()` 记住的是那个已经失败的 import**，
所以边界不提供"重试"，只提供刷新与关闭——原地重渲染等于再抛一次。

**6. 走查方式的教训（Playwright 本机）**：条目页有**两枚**「更多操作」（桌面头栏与移动端条），
`locator('button[aria-label="更多操作"]')` 直接违反 strict mode，要 `:visible` + `.first()`；
按需加载的浮层不能靠固定 `waitForTimeout` 判定，250 ms 时 chunk 还没到就会误判"打不开"，改用
`waitForSelector`（打开）与 `{state:"detached"}`（关闭）。本机 Chromium 的目录是 `chromium-1243/chrome-win64/`，
`playwright` 装在用户目录的 `node_modules`，仓库外脚本要用 `createRequire("file:///C:/Users/<你>/package.json")` 才引得到。
本轮结果：13 项断言全过（焦点归位、两条失败提示、chunk 失败不整页垮、海报浮层正常路径），页面零报错。

## 第二十八轮（2026-10-06 上午）：全站停更的真实原因，与接入真模型

**1. 现象**：站长截图指着三处说"没更新"——首页精选最新一条是 10-02，热点榜空，日报最新一期是 10-03。
今天 10-06。**这不是缓存**（`cf-cache-status: DYNAMIC`、`max-age=60`、加随机参数结果一样）。

**2. 真实原因（生产库实测，一条一条查出来的）**：
- 采集与分析都在跑：10-06 当天 419 次成功抓取、223 条新文章，`articles.processing_state=analyzed` 最新到 09:34。
- 断点在**编辑判断**：`analyses.relevance` 按天看，10-01 到 10-04 每天 991–1871 条 `pass`，**10-05 只剩 1 条，10-06 是 0 条**，其余全 `unknown`。
- `unknown` 进不了公开池：`publication/rules.ts` 的 `isPoolEligible` 要 `relevance='pass'` + 中文标题 + 中文摘要，
  于是 10-05 起 `publications.eligible` 是 0 → 全部动态、分类页、主题页、RSS、sitemap 一起冻在 10-04 15:28；
  精选（`selected`）停在 10-02；日报排出来 `content.sections` 是空数组，读取层按设计跳过空期次，`/daily` 就回落到 10-03。
- 转折点是 **10-04 22:07 那次上线**：那次把 10-02 定下的「没有人工中文稿就不写中文」闸门带上生产。
  当时生产没有模型密钥，`tooling/fixtures/*.jsonl` 只有 119 条 understand 样本，撑不住每天一千多条 → 全站冻住。
- 顺带查清的两件事：`articles.language` 一列几乎全空（8167 条里只有 36 条 `zh`），中文判定实际靠标题正文里的 CJK，
  不靠这一列；`selected_ledger` 那 1055 条孤儿只在 CI 库，生产是 0 条。

**3. 接入真模型（站长 2026-10-06 决定并给了密钥）**：Agnes AI 的 `agnes-3.0-flash`，OpenAI 兼容。
实测过三件事才写进 `.env`：`GET /v1/models` 回 12 个模型且含 `agnes-3.0-flash`；纯文本 `chat/completions`
200、`choices[0].message.content` 正常、带 `usage`；`response_format:{type:"json_object"}` 也支持（本站
预筛/打分/结构那几步要用）。生产 `.env` 改了三行（`LLM_BASE_URL=https://apihub.agnes-ai.com/v1`、
`LLM_API_KEY`、`LLM_MODEL=agnes-3.0-flash`），**密钥只进 `.env`**：走 stdin 到 `/run/agnes.key`（600、属 geohot）
再写进文件，随后 `shred`，不进命令行参数、不进仓库、不进日志。
`budgets` 表里 `llm` 那道熔断从 300/6000/40000 降到 **40/1500/12000**（每分钟/每小时/每天），
超了 `BudgetExceededError` 会让任务暂停而不是继续扣钱。`EMBEDDINGS_ENABLED=false` 且没有 embedding key，
所以向量那一族仍然完全不动。

**4. 措辞跟着改（条款与隐私是读者会拿来对照的两页）**：`industry/pages/terms.md` 原来写着
「本站目前不接入任何大模型服务，也没有任何模型密钥」，`privacy.md` 同一段、`README.md` 的「编辑大脑」一节与
徽标、`docs/deploy.md` 的「这个部署一分钱都不花」、`AGENTS.md` 的两条规则——**全部按新的真实情况重写**：
标准由人定（`industry/`），逐条结论由模型给，站长在后台抽查更正，本机与 CI 仍用 stub（零账单、零外发）。
`Score.tsx` 与 `site.ts` 的「入选分 / 编辑部写定标准」两处措辞核对过：它们没有宣称执行者是人，因此保留。

**5. 两条防复发的代码改动**：
- `editorial/writing.ts` 的 `finalizeCopy` 加中文兜底 `ownChineseLead()`：模型没给中文摘要时，
  **中文材料**退回来源自己那段话的开头（复用短帖那条密度判定 `needsShortTweetTranslation`，
  英文稿里夹一句中文不算中文材料；长度走同一处 `compactAnswerFirstSummary`）。`tests/identity-guard.test.ts`
  新增 4 条钉住：中文能放行、英文一句不放、混合密度不够不放、短帖与人工稿不受影响。
- 首页在精选超过三天没有新内容时渲染一块「最新收录」（`apps/web/app/routes/home.tsx`，取 `/api/site/pool`
  最新 8 条），标注「按收录时间排列，本站未作编辑筛选」，精选恢复后自动消失。本机验证：块渲染出 8 行 + 说明。

**6. 还没解决 / 留给站长决定**：热点榜要 ≥2 家独立信源写同一件事才出内容，而事件归并依赖模型判断
（`BRAIN_GROUP_DEFAULT` 未设时本机 stub 默认 `UNRELATED`）——生产接上真模型后能不能填上，**要在上线后实测**，
不实测不说它能。另外 6 条信源在持续失败（澎湃 403、中国地震局 403、UN OCHA 406、World Politics Review 403、
长江委 fetch failed、自然资源部 DNS `EAI_AGAIN`），这一项本轮没动。

## 第二十九轮（2026-10-06 上午）：页脚不是正文，思考要留预算

**1. 站长的要求**：「我的信息里不要出现"国家气象中心 版权所有…未经授权禁止下载"这种页脚，只要核心的信息。」
线上实测坐实：最近 400 条 `body_status=ok` 的正文里 **96 条（24%）开头就是这段页脚**，CJK 密度分布也印证了
（真中文正文 0.7-0.9，页脚 0.49，英文 0）。来源查清了：中央气象台预警详情页的正文只有 177 字（防御指南），
低于 `MIN_BODY_CHARS` 判为"没有正文"，于是 Jina 兜底把整页文字（连页脚）取回来当正文存了。

**2. 修法是一条规则只写一处**（`lib/text.ts` 的 `BOILERPLATE_LINE` / `BOILERPLATE_SEGMENT` /
`stripBoilerplate` / `isBoilerplateBody`），四个读它的地方：抽取（readable 与 Jina 两条路都先剥再判，
剥完不够 60 字就返回 null）、入库前喂模型（`cleanArticleTextForLLM`）、中文摘要兜底（`ownChineseLead`
拒绝从页脚开头）、以及 `MIN_BODY_CHARS` 200→**150**（让"防御指南"这种真正文能进来）。
新增 `tests/boilerplate.test.ts` 4 条钉住。存量那 96 条要清，见下面第 5 条。

**3. 模型思考强度（站长的口径：用最强推理与上下文）**。实测三种写法：
`reasoning_effort:"high"` 与 `thinking:{type:"enabled"}` 都会真的进入思考（4,094 / 3,619 个隐藏 token），
**但在 `max_tokens=512` 下答复是空的**（`finish_reason:"length"`、`content:""`）；把预算提到 8,192 才拿到
正常答复（52 秒 / 82 秒）。所以 `providers/llm.ts` 现在给"开了思考"的调用加 `REASONING_HEADROOM=6000` 的余量，
并把超时从 120 秒放宽到 240 秒——**且总和不越过 `MAX_OUTPUT_TOKENS=65536`**（那正是打分档自己已经要的量，
不因为加余量而膨胀）。生产 `.env` 用 `LLM_EXTRA_JSON={"reasoning_effort":"high"}` 打开，代码零改动。

**4. 我自己踩到的不变量**：第一次改法没加封顶，`tests/analyze.test.ts:122` 立刻红了——它钉着打分请求的
`body.max_tokens` 是 65536（`SCORE_CALL["glm-5.3-flash-selection"]` 自己算好的档位）。这条测试是对的，
错的是我的加法；补上 `Math.min(MAX_OUTPUT_TOKENS, …)` 后 13/13 绿。**教训：给"预算"这类数字加东西，
必须同时看有没有人钉过它。**

**5. 存量页脚正文（更正：这条已经跑了，站长在上一轮末尾点头「直接上线」）**。`scripts/strip-body-boilerplate.ts`
在 2026-10-06 11:09（+0800）以 `--apply` 跑了生产库，**1002 行**按新规则重洗（`body_text` 里那段页脚被剥掉，
剥完不够 60 字的把 `body_text` 置 NULL、`body_status` 改回 `pending` 等重抽），旧值全量备份在
`/opt/geohot/app/.data/boilerplate-backup-2026-10-060309.jsonl`。跑完之后生产库 6209 条有正文的行里，
仍能匹配 `版权所有|未经授权|违法和不良信息举报|All rights reserved` 的只剩 **3 条**，逐条看过都不是页脚：
两条英文长文里的图片署名与「All rights reserved」句、一条人民网漫画的「漫画作者：谭希光（人民网版权图片，
未经授权请勿转载）」——那是正文自己的署名，剥掉就是改内容。**这一轮的教训不是脚本，是它的备份**：
`appendFileSync(backup, JSON.stringify(row))` 少写了一个换行，1002 条被拼成**一行 1.3 MB**，
`.jsonl` 这个名字骗人——按行读的恢复脚本一条也读不出来。已修（补 `\n`），生产上那一份也用一个只读的
花括号扫描（字符串与转义感知）重排成了真正的 1002 行，原文件留在同目录 `.concatenated.bak`。
顺带在同一个仓库里找到同族的第二个坑：`config = ${JSON.stringify(x)}::jsonb` 会让驱动把那段文本当**字符串值**
序列化一次，落库是 jsonb 标量而不是对象，采集器读 `config.feedUrl` 直接 `undefined`（本轮真实踩到，
现场表现是"改完配置后这条源必然失败"）；写 jsonb 要用 `sql.json(...)`，与 `seed.ts:48`、`admin/sources.ts:116` 一致。

> **第三十三轮再更正：这一条里「剥掉页脚」那半句是错的，实际发生的是「把正文删了」。**
> `lost` 判的是 `isBoilerplateBody(r.clean)`，而 `r` 是查出来的原始行、根本没有 `clean` 字段——
> `undefined` 进 `isBoilerplateBody` 一律返回 true，于是 1002 条**全部**走了删除分支：`body_text=NULL`、
> `body_html=NULL`、`body_status='pending'`。"只剩 3 条还能匹配页脚话术"这个观察是对的，但它的成因
> 不是洗干净了，是那 999 条连着正文一起没了。线上现在的口径：`pending` 且无正文 1011 条，其中 1002 条在
> `article_revisions` 里留有 >60 字的旧正文、`processing_state` 仍是 `analyzed`（这就是被删的那批），
> 986 条来自 `json-nmc-weather-alarm`。还原见下面第三十三轮第 5 条。
>
> **第三十三轮的再再更正（跑完才对得上账）**：删是删错了分支，但**结果**只有 16 条是错的。
> 按备份还原 1002 条再重洗，落回 `pending` 的正好是 986 条——它们的存量 `body_text` 整段就是
> 「国家气象中心 版权所有 Copyright©2009-2026…京ICP备05055842号 技术支持邮箱 nmccn@cma.gov.cn」
> 那 219 个字，剥完剩 0 字，本来就该算「没抽到正文」。真正被误删的是剩下 16 条（人民网、科技日报、
> moe、nasa、osm-blog 这类有真正文的）。上面那句「1002 条本来有正文」说重了，按这处分。

## 第三十轮（2026-10-06 中午）：七条一直失败的信源，只有一条真能修

**1. 逐条重测，不用裸 curl 的状态码当结论**。上一轮接入真模型后回头看采集健康度，一直红着的是七条。
在境内本机与境外采集机上各跑一遍，用的是项目自己的 `fetchRss` / `fetchWebList`（后台「试抓一次」那段代码），
结果分三类，写在 [`docs/sources.md`](sources.md) 的「第三十轮」一节：一条修好（`intl-worldpoliticsreview`）、
五条停用（`intl-unocha` + 四条境内官方站）、一条是抖动不是坏了（`json-ceic-earthquake`，重跑 322 条）。
**这一类的价值在"哪一条也修不了"**：`web-mnr-ywbb` 的 DNS 在采集机上直接无应答、`web-cjw-cjyw` 解析到
一个境内 Telecom 地址但 TCP 连不上，换 UA 与换路径都不会改变结果，因为门槛看的是来源 IP。留着它们，
后台信源页就常年有四条红的，健康度这个工具对站长就废了。

**2. `rss` 支持单条信源的 `headers`**。`json_list` 早就有这一项（`config-keys.ts` 的 `KEYS.json_list`），
`rss` 没有，于是 WPR 这种「对爬虫标识 403、对浏览器标识 200」的站接不进来。现在 `sources/rss.ts:198`
把 `config.headers` 并进请求头，304 重取那一路（`res.status === 304` 后不带条件头重打一次）也继续带着，
否则第二次请求会把这条源自己的 UA 丢掉、拿回 403 再判一次失败。白名单加 `"headers"` 之后 seed 与后台预览
都认它。**没有全局换 UA**：那等于对所有守规矩的订阅源谎报身份，而只有极少数站需要这个。

**3. UN OCHA 这条为什么不追着修**。它的 `/rss.xml` 对采集器回 406 + 一段 awselb 的 JSON 告示
（`error` 字段是 `Blocked due to bot activity`，还留了邮箱），同一地址裸 curl 回 200——差别在客户端指纹，
不在请求头。补上浏览器才发的 `sec-fetch-*` / Client Hints 并伪造 TLS 指纹是能过去的，但那是**绕过站点明确
挂出的反爬告示**。本站的内容诚信红线同样管取内容的手段，所以不做；配置原样留着，等有授权通道或换境内出口
再打开。（如果站长判断「这只是普通订阅、对方并没有拒绝机器读取」，那就把它改回 `enabled=true` 并说明口径，
这条记录跟着更新。）

**4. 信源包改了，库里的行不会自己变**——这是设计（`seed.ts` 只增不改，之后开关归后台），但也是运维缺口：
`docs/sources.md` 说「按包重放」，而仓库里没有一条被授权的重放路径，手敲生产 `UPDATE` 又是本仓库不接受的写法。
新增 `scripts/set-source-state.ts`：默认 DRY-RUN，只打印指定 id 的库↔包差异；要写必须 `--apply` **且**显式
`--database-url=`（沿用 `retire-gdacs-green.ts` 那两个闸门），`--ids` 必填所以它不做整包对齐，不会把站长
在后台手动关掉的源悄悄打开；只写 `enabled` 与 `config`，副作用与后台那个开关一致（`admin/sources.ts:118`：
停用把 `health` 停到 `paused`，启用再清回 `unknown`）。

**5. 本轮在自己新写的脚本里踩到的两个坑**（都不是产品缺陷，但都会咬未来的运维）：
① 第一版比较差异用 `JSON.stringify(db.config) !== JSON.stringify(pack.config)`，而 Postgres 的 jsonb **会重排键序**，
于是六条全部显示"配置要改"，其中四条其实一个字没动——比较前必须按深度排序做规范化（脚本里的 `canon()`）。
② 写回时用了 `config = ${JSON.stringify(c.config)}::jsonb`，驱动把这段文本当**字符串值**再序列化一次，落库成了
jsonb 标量；后果是采集器读 `config.feedUrl` 得 `undefined`，这条源从此必然 "feedUrl missing"。本机已经写坏过一轮，
用 `tx.json()` 重写一遍并把 `jsonb_typeof(config)` 全表扫成 `object` 才算干净（0 行异常）。这条与上面第 5 点
是同一个族：**jsonb 的写入与比较都不能按文本处理。**
③ 顺带把上一轮 `strip-body-boilerplate.ts` 少写换行的备份文件在生产上重排成了真正的 JSONL（原文件留
`.concatenated.bak`），见第二十九轮第 5 条。

**6. 采集阀门与本脚本的关系**：`scripts/collect.ts` 对每条源带 `force: true`，它会**盖过 `enabled=false`**
（`collect.ts:209` 只在 `!force` 时拒绝）。本轮实测停用的澎湃在境内本机照样抓到 17 条——这是脚本的设计
（算子要能试抓一条已停用的源），但要知道：`enabled` 挡的是 worker 与看门狗，不是这个手动入口。

## 第三十一轮（2026-10-06 中午）：接了真模型，精选与热点榜为什么还是空的

上一轮接入 Agnes 之后线上确实在动（`/all` 当天有新条目，`api/site/stats` 的 `day.collected` 830），但读者仍然
看到精选很少、**热点榜空**、日报没有内容。本轮把这条链一路量到底，结论是**一个字符数下限卡住了整条链**。

**1. 测量路径**。48 小时窗口里 2611 条新条目、2799 次分析，但只有 **93 条 `relevance='pass'`**，2676 条是
`unknown`；`facts` 只有 54 个、`story_signals` 52 条且**每条只有一个参与方**（`events/hot.ts` 的门是 48 小时内
至少 2 个独立参与方），所以榜必然空。精选与日报读的是同一道闸门（`publication/rules.ts` 的 `isPoolEligible`
要 `relevance='pass'`）——**三个出口空是同一个原因，不是三个 bug**。

**2. `unknown` 是什么意思**。`analyze.ts:384` 的算式是「过了预筛，但中文标题或中文摘要缺一个」。2799 条里
2706 条没有 `summary_zh`。往下追：`summarize_article` 的 828 次完成调用里有 **789 次答复是空壳**——内容恰好是
`title_zh:` 换行 `summary_zh:`（23 个字符，标签后面什么都没有），而 `finish_reason` 仍是 `stop`、
`reasoning_content` 长达 3,000～8,500 字。模型面对「没有正文、只有一句标题加一行摘要」的材料就交了白卷。

**3. 真凶在抽取层**。在生产机上取最近 12 条中央气象台预警详情页，用项目自己的 `readable()` 逐条打印抽取长度
与剥页脚后的长度：整页正文 **126–308 字**，`stripBoilerplate` 一个字符都不删（页脚确实被上一轮挡住了）。
而 `MIN_BODY_CHARS` 是 150——12 条里 5 条（42%）因为差十几二十个字被判「这页没有正文」，`body_status` 停在
`unconfirmed` / `pending`。没有正文就没有中文摘要，没有中文摘要就进不了池，进不了池就没有事件、没有榜、
没有日报。**同一类官方预警，只因为预报那句写得短，就永久不上屏。**

**4. 改法**：`content/extract.ts` 的下限 150 → **120**，注释里写明这 12 条的实测区间。防页脚那道
`isBoilerplateBody`（剥完不足 60 个真字符算页脚体）一个字没动，所以「宁可留一条只有标题的条目，也不存一段页脚」
仍然成立。`tests/boilerplate.test.ts` 加一条对照用例：120–150 字之间的完整官方预警必须出正文，
只剩一句标题的页面仍然必须返回 null（5/5 绿）。

**5. 两件想过但没做的事**（成本或代价不对）：
① 不给 `summarize_article` 加 `usable` 拒绝闸门（`events/digest.ts:127` 那一族）。对空壳答复说「这不算答复」
会让同一个 `logical_key` 下次再掏一次真金白银，而那些材料的输入本来就是「没有正文」，重跑十次也是白卷，
除了账单没有别的收益。该修的是输入，也就是第 4 点。
② 不批量重洗已经卡住的旧预警：预警是**时效内容**，昨天的橙色预警今天洗出来只会误导读者；而这一条信源
每几十分钟就有新预警进来，下限一改就自动流起来。旧行留在库里，读者看不到（`unknown` 不进池）。

**6. 还剩一件没结论的，写在明处**：中新网·即时新闻 24 小时 268 条里 256 条也没有中文摘要。它的正文是长文,
不受第 4 点影响，所以这一族是**另一类**问题（详情页抽取失败，或模型对长文也交白卷）。本轮只把现象钉在文档里
（`analyses` 与 `receipts` 两张表都可复算），下一轮从「这篇文章到底有没有 `body_text`」往下走。
**这条已经被下一轮（第三十二轮）解答：正文是有的，白卷是 stub 交的。**

## 第三十二轮（2026-10-06 下午）：那 2676 条 unknown 不是模型不行，是它们没被真模型看过

上一轮结尾留了一条没结论的：中新网那一族 268 条里 256 条没有中文摘要，正文明明是 468–1158 字的长文。
本轮从 `receipts` 往下查，结论**改写了上一轮的因果**：`MIN_BODY_CHARS` 那道坎是真的（预警页 126–308 字、
12 条里 5 条被杀，实测没错），但它不是主因——主因是**上午那批条目的中文稿根本不是 Agnes 写的，是本地 stub 写的**。

**1. 证据链**。按 `purpose × model` 分组看 24 小时的回执：`summarize_article` 有 752 次落在
`geohot-editorial-brain`（stub）上，首次 10-05 13:36、**末次 10-06 10:22:42**；另有 60 次落在
`agnes-3.0-flash` 上，首次 10:36。`score_article` 1506 次是 stub、`prefilter_article` 766、`structure_article` 761，
末次全是 10:22:42——那正是上一轮装好 key、重启 worker 的时刻，之后 stub **一次都没有**。
再按答复形状把 `summarize_article` 分成两群，画像完全对得上：空壳那群 106 次，`max_tokens` 2048、
`completion_tokens` 恒为 8、没有 `reasoning_tokens`（8 个 token 就是 `title_zh:` 换行 `summary_zh:` 那两行标签）；
有内容那群 56 次，`max_tokens` 8048、平均 `completion_tokens` 2636、平均 reasoning 3098、`text_tokens` 97。
**所以"模型面对长文交白卷"这个判断是错的**：白卷是 stub 交的，真模型当时还没上岗。

**2. 现在的真实通过率**。切换之后（13:00–13:26 那 40 分钟窗口）9 次分析里 8 次 `pass`、0 次 `unknown`；
公开池 `eligible` 4975、`selected` 59。上一轮看到的 2676 条 `unknown` 是**存量**：它们是 stub 时期分析的，
而 `relevance` 不会自己翻新——回执按 `logical_key` 缓存，输入没变就还是那个答复。

**3. 补的工具与它的边界**。`scripts/refill-copy.ts` 加了一类候选 `--missing-summary`：正文有、≥150 字、
最近一次分析是 `unknown`；按入库时间倒序取（新闻站先修最新的），安全闸门照旧（默认 dry-run、候选 >50 必须 `--ids`）。
生产上入队 50 条，之后 8 分钟完成 12 次重跑：**7 条 `pass`、5 条 `block`、0 条 `unknown`**——那 5 条 `block`
是预筛判的「不属于地理」（例：斫琴师为古琴延寿的技艺报道），不是失败。
**没有一次跑完 400 条候选**：预算是 `llm` 8/分钟、420/小时、6000/天，24 小时已用 4345 次；
把 400 条全洗一遍要 ~1600 次调用，会把当天剩余预算吃光、饿掉正在进来的新消息。
**新消息的实时性优先于存量翻新**（站长要的是「实时同步更新所有信息」），所以按 50 条为单位跑，
剩下的每天腾出余量再洗，或者升 Token Plan 之后一次洗完——升配是站长的购买决定，不由我替他点。

**4. 热点榜为什么还是空的，以及为什么不去「修」它**。24 小时 59 次归组判定里 36 次确实拿到了向量候选，
相似度 0.31–0.605，模型逐条回 `UNRELATED`（置信度 0.55–0.95），只有 1 次并进已有事件；
`story_signals` 48 小时 69 条，**每条事件的参与方都是 1**。这一窗口的内容以县级预警为主（每条预警本身
就是一个独立事件），确实没有「两家以上信源报道同一件事」的素材。**把相似度门槛调低就能造出多参与方的榜，
但那是伪造编辑结构**，踩内容诚信红线，所以不做。等真正被多家报道的事件进来（地震、政策、发布类），
这张榜会自己起来——判据是 `events/hot.ts` 里那四个参数，不是今天有没有图可看。

**5. 本轮在自己刚写的代码里又踩到两处**：① `--missing-summary` 第一次上生产就抛
`ERR_PARSE_ARGS_UNKNOWN_OPTION`——`parseArgs` 是 strict 的，kebab 形式的命令行参数不会自动映射到
camelCase 的键，键名改成 `"missing-summary"`、读值处同步；② `refill-copy.ts` 头部那句
"The deployment's model is the local stub, so a re-run costs nothing" 在接入真模型之后已经是谎话，
按「花多少由这套部署说了算，一次重跑约 5 个调用」改写。**教训与第二十九轮第 4 条同族：改了运行前提，
就要把写着旧前提的注释一起改掉，否则下一个人（或下一个我）会照它做决定。**

## 第三十三轮（2026-10-06 下午）：正文里的页面外壳，和一次「读起来像洗过、其实是删掉」的批量写

**1. 「只要核心的信息」还有第二族**。第二十九轮处理的是页脚话术（版权所有、未经授权禁止下载那一套）；
这一族是**页面外壳**：中新网把「2026年10月06日 14:02　来源：中国新闻网」那行发稿信息、字号切换控件
（「大字体」「小字体」两个并排按钮）和电头收尾记号（`(完)`、`【编辑:刘欢】`）都排在正文元素之间，
抽取器一并收了进来。线上实测 `cn-chinanews-scroll` 有正文的 458 条里 **195 条**带字号控件，
`【编辑:` 与 `(完)` 更常见——本轮重洗前全库候选 1497 条，其中中新网这条源 470 条。

**2. 规则加在 `lib/text.ts` 一处，但要两层生效**。`stripBoilerplate` 加了三段：内联片段
（`【编辑:X】`、`大字体 小字体`、`责任编辑：X`）、开头的「年月日 + 时刻 + 来源：+ 信源名」、
结尾的 `(完)`。写完先在生产上抓了一条真页面（`https://www.chinanews.com.cn/sh/2026/10-06/10708416.shtml`）
对着存库的 `body_html` 核对，才知道形状和猜的不一样：**全文折成一行、没有换行**，
所以逐行删那一半永远不会命中；`中国新闻网` 是紧跟时间行的一个 `<a>`，逐节点清洗时不在同一段文字里。
于是补了 `content/sanitize.ts` 的 `stripChromeHtml`：先整段删掉「只有时间行」的段落（用整段文本判定），
再对每个文本节点跑同一份规则，最后交给已有的 `normalizeBlocks` 收掉变空的段。
`readable()` 与 `markdownBody()` 两条抽取路径都接上，存量脚本也改成**就地清洗 `body_html`**，
不再像第二十九轮那样「洗不干净就整块丢掉」。

**3. 一个自伤被测试挡住了**：`stripBoilerplate` 会删空行、并把连续空格压成一个——这对正文是对的，
对 `<pre>` 里的代码是破坏。第一版逐节点无差别跑，`tests/markdown-body.test.ts` 立刻红：
代码块 `first()\n\nsecond()` 被压成 `first()\nsecond()`。**这套测试的价值就在这儿**，
现在 `stripChromeHtml` 跳过 `pre` 里的节点。

**3b. 误删风险不是靠感觉排除的**。随机取生产近 36 小时的 400 条 `body_html`，只读跑一遍
`stripChromeHtml`，逐条比对删掉的文字：254 条 HTML 有改动，但其中 249 条**只动了空白与结构**
（`normalizeBlocks` 重新序列化），真正删掉文字的只有 5 处，逐处看过全是英文出版物的版权声明
（`copyright. Apart from any fair dealing for the purpose of private study…`）。这类"改完顺手量一遍全量"的
只读探针，比对着规则自我感觉良好便宜得多。

**3c. 但上面那次"量一遍"仍然不够——它量的是我自己写的规则，不是别人的句子**。上线之后独立评审智能体
拿真句子跑同一份代码，五条全部复现（我这边一条都没测到，因为我的测试全是"外壳该被删掉"的正向断言）：
① `PAGE_CHROME_LEAD` 的信源名做成可选贪婪匹配，于是
「2026年10月06日 14:02 来源：中国地震台网中心测定，云南德宏州盈江县发生5.1级地震。」被删成
「，云南德宏州…」——**时刻与机构名是灾害数据，这条撞红线**；② `责任编辑[：:]…{1,10}` 吃到句子里：
「一位责任编辑：您如何判断一本书值不值得做？」变成「一位 值得做？」；③「网页设计里常把大字体 小字体混排」
被删空；④ 逐节点跑 `stripBoilerplate` 时它末尾那句 `.trim()` 会吃掉行内边界，
「Researchers at `<a>NASA</a>` said」压成「atNASA said」——**所有英文信源的 `body_html` 都会被压坏**；
⑤ `CHROME_ONLY_BLOCK` 只看 `.text()`，时间行与 `<img>` 同段时连图一起删。
修法：三条规则都加了 `(?<!\S)` / `(?!\S)` 句子边界（①还要求"名字独立成段或整段就此结束"，否则一处都不删）、
`cleanTextNode` 保留节点原有前后空白、整段删除补上 `normalizeBlocks` 那道媒体判断。
**生产上被第一版洗过的 511 条已经撤销**：`restore-body-from-backup.ts` 新增 `--state=washed`
（库里正文还在、内容不是备份那一份、且 revision 恰好被那次洗 +1）先还原，再用改好的规则重洗。
复算凭据：`body_text` 以「，」开头的行 **0 条**、含 `【编辑:` 的 **0 条**、含「大字体」的只剩 1 条
（「手写放大字体票根」那句），400 条随机重跑只读探针只剩 46 条有改动、删掉的文字全是版权声明。
**教训：正向断言证明规则会删该删的，证不证明得了它不乱删，是另一件事——这一步该由没写它的人来做。**

**4. 本轮真正给读者的是「模型看到的输入」和「存的东西」，不是页面**。查这件事时顺手量到一个前提：
生产库 85 条启用信源里 `site_fulltext` 与 `syndicate_fulltext` **都是 0**，
所以 8429 条公开 publication 全是 `body_mode='summary'`——条目页、Markdown 下载、RSS、原文镜像
那几个出口都写着「只在 `body_mode==='full'` 时给正文」，也就是说**读者从来没看到过我们存的正文**。
这条前提是站点的许可边界（只发摘要 + 留原文地址），不是缺陷。于是本轮的实际收益是三件事：
喂模型的 `body_text` 不再带外壳（摘要与标题的输入更干净）、`body_text`/`body_html` 两份表示终于一致、
以及**哪天给某条信源开了 `site_fulltext`，不会把「大字体 小字体 【编辑:…】」直接端上页面**。
写在这里是为了别让下一轮把这一条夸大成「读者页面上的页脚没了」。

**5. 凌晨那次批量写到底做了什么（含更正）**。见第三十轮第 5 条下面那两段引用：`lost` 读了不存在的字段，
1002 条全走删除分支。本轮用 `scripts/restore-body-from-backup.ts`（新增，默认 DRY-RUN、`--apply` 必须显式
给 `--database-url` 且必须与 `DATABASE_URL` 同库）按备份还原 1002 条，再按信源排队重算 publication
（`publication.republish-source`，12 个任务全部 completed，不花模型额度）。还原后重洗，986 条落回
`pending`——它们的存量正文整段就是国家气象中心的页脚（219 字剥完剩 0 字），删掉是对的；
剩下 16 条是真正文，留下来了。重洗之后：`ok` 6281 条、`body_text` 里还带「大字体」的 **1 条**
（逐条看过：那是一篇写影院适老化服务的稿子里那句「电话订票、手写放大字体票根」——稿子自己的话，规则不该碰也没碰）、
`【编辑:` **0 条**、`body_html` 同样 0 条。池子 `eligible` 4986 → **5071**，`selected` 59。

**6. 为什么 `scripts/` 里能藏这种错**：根 `typecheck` 只跑 contracts/backend/api/worker/tests/web。
本轮加了 `scripts/tsconfig.json` 并把 `tsc -p scripts` 排进 `npm run typecheck`——整个目录只有 2 处既有
类型错误（`opentype.js` 没类型声明，补了 `scripts/opentype-js.d.ts`；`recompose-report.ts` 把
`string | Date` 当 `Date` 传），修掉了。**同族缺陷当场又抓到一个**：`strip-body-boilerplate.ts` 的
`--apply` 只看环境变量、`parseArgs` 还没声明 `--database-url`，所以第一次带它跑就抛
`ERR_PARSE_ARGS_UNKNOWN_OPTION`（这脚本已经在生产上写坏过一次）。现在三个运维脚本同规：apply 必须指名库，
而且指名的库必须真是连上的那个。

**7. 想过但没做**：① 给 `cn-chinanews-scroll` 开 `site_fulltext` 让读者看全文——那是许可与站点定位的决定，
归站长（站点标准第 3 条明确只发摘要 + 原文地址）；② 顺手把 1497 条重排分析——`--no-requeue` 是刻意的，
正文里被删掉的只是控件与署名，摘要本来就没引用它们，花 7485 次调用重跑一遍不值得，额度留给新消息。
**但要说清 `--no-requeue` 只是推迟、不是免单**：脚本仍然把 `revision` +1（正文确实变了，哈希也跟着变），
而回执是按「哪一版正文」绑定的，所以这些条目将来被任何一条路径重看一次都是新请求、要付钱。
本轮之后已经排过一次 15 条的小批量补摘要（`scripts/refill-copy.ts --missing-summary`），
剩下的按额度慢慢磨，不追求一次洗清。

## 第三十四轮（2026-10-06 下午）：四个评审智能体的账——修了九处，驳回两处

**0. 这一轮的来源不是我自己**。上一轮独立评审抓出五条过度删除之后，这一轮直接派四个只读智能体分头查
读者界面、出口一致性、作业与预算、库与增长。它们的产出比我一个人翻代码密得多（下面 1-9 条全是真缺陷），
也给了两条**错的**结论——一并记下来，免得下一轮照着改。

**1. /about 的「已出 N 期」是虚的（BLOCKER，已修）**。`site/stats.ts` 自己数 `reports WHERE kind='daily'`，
线上实测 12 行，而同一页旁边的归档写着「共 2 期」——差的是空刊与引注已撤的期次。
修法不是再写一道 SQL 判断（我先试了 `jsonb_path_exists`，随即自己推翻：那道门在读取层，
它除了"排得出内容"还要看引注是否还在，两套写法迟早再分叉），而是让 `stats.dailies = listReports("daily").length`。
`tests/publication-issue-gate.test.ts` 钉住两个出口同一个数。本机这一列两件事恰好一致（4 行 = 4 期），
README 的 STATE 说明已按新算式改写。

**2. 「另有 N 家信源报道」和它展开的列表不是同一套成员（MAJOR，已修）**。标题那个数走 `publications.fact_id`
（写库时就限定 `role IN ('primary','report')`），面板与首页卡片走 `fact_articles` 且**不带 role 过滤**，
于是「被顺带提到」的报道会多出现在列表里——数说 2 家、点开 3 条。现在成员判定收成一份：
`rules.ts` 的 `FACT_MEMBER_ROLES`，`publish.ts`、`groups.ts`、`timeline.ts`、`sitemap.ts` 都读它。

**3. 首页「查看全部 N 条」的链接丢了筛选（MAJOR，已修）**。N 是带筛选的池子总数，链接却指向裸 `/all`：
评审实测 `/?category=physical` 上写着「查看全部 245 条」、点过去是 2000+ 条。现在链接用 `listPath` 带上
同一组筛选——canonical 早就这么做了，只差这一处。

**4. 一次额度窗口就能把页面永久判成"没有正文"（MAJOR，已修）**。`extractFromUrl` 把 `BudgetExceededError`
吞成 `return null`，而 null 在 `extractArticleBody` 那条路上就是 `body_status='unconfirmed'`——
jina 的闸门是 5 次/分钟，兜底排队撞上窗口就永久定型（`waitsForPage` 只等 `pending`，再不会回头看它）。
现在异常照旧抛出，`afterFailure` 认得它：按 `retryAfterSeconds` 排回去，且**不消耗**条目的重试次数。

**5. 分析完成、发布投影没跑成 = 永久失踪（MAJOR，已修）**。`analyze.ts` 先提交 `processing_state='analyzed'`，
`publishArticle` 在其后；崩溃落在两步之间时，`sweepUnprocessed` 只捞 `'new'`，于是条目停在"分析过了但站上找不到"。
安全网现在补另一半：`analyzed` 且 `publications` 里没有行的，直接重算投影（确定性计算，不花模型额度）。

**6. 释放"结果未知"的回执后，条目并没有被排回去（BLOCKER，已修）**。`admin/runs.ts` 判的是
`purpose === "analyze_article"`，而真实 purpose 是 prefilter/score/understand/summarize/structure 那五个——
这个字符串从来没出现过（`git log -S` 只有上游基线那一笔）。于是一次 240 秒超时的条目就永久停在 `failed`，
而 `content.ts` 的注释承诺着"ops 释放一次就排回去"。现在认 subject 的形状（`article:<id>@…`），不认 purpose。

**7. 热点榜名次会在两块榜之间交换（MINOR，已修）**：排序只有 heat + 最新时刻，第 10 名是截断处，
同分的两条事件会轮换出现，读者看到"昨天的第一名今天凭空消失"。加了 `story_id` 稳定 tiebreaker。

**8. 硬删条目会留下孤儿向量（MAJOR，已修）**：`embeddings.ref_id` 没有外键（0006 的主键是
(kind, ref_id, model)），`scripts/delete-sources.ts` 硬删 `articles` 时向量永久留着，而归组每次比对都读这张表。
删除事务里现在一并删掉条目自己的向量。

**9. v1 的 page token 不校验 `t`（MINOR，已修）**：`t:"zzz"` 让下游时间比较抛错、对外回 **503「稍后再试」**
（客户端据此重试一个永远不会成功的游标），`t:123` 静默给空页还写 `hasMore:false`。现在两者都算游标不合法（400）。

**10. 驳回的两条**：① 「所有列表索引存 `article_id ASC` 而查询要 `DESC`，每页都在全量排序」——
在生产上跑 `EXPLAIN ANALYZE` 是 **Index Only Scan + Incremental Sort**，0.94 ms / 0.35 ms，
`Full-sort Groups: 8`、27 kB 内存；索引前导列方向对得上，Postgres 只需在小组内补排。不改四个索引，
② 「条目页从不解释为什么没有正文」——那句提示写的是「应来源方要求」，而站点不发全文是**自己的许可选择**，
条款与关于页已经写明；把那句话贴到每个条目页上既不准确也是全站文案改动，归站长决定，不在这一轮顺手做。

**11. 评审提出、这一轮没做的**（都记成工单，不留在空气里）：预算按"尝试"计数而非真实请求（429/连不上也算，
代理故障会把当天额度烧光而不产生任何结果）；`expireInSeconds=600` 小于一篇文章五次串行思考调用的最坏耗时、
`STOP_TIMEOUT_MS=195s` 的注释写着"最长付费调用 180s"对开了思考的调用已经不成立；
`admin/runs.ts` 的 receipts 查询走 seq scan（后台 20 秒轮询一次）；`feedback`/`monitor` 用非唯一列 OFFSET 翻页；
`articles_processing_idx` 少了 `discovered_at`；`receipts`/`deliveries` 的保留期（见第二十一轮那条，
现在多了一个前置依赖：`events/digest.ts` 读 `receipts.usage` 判断当期综述是不是机器写的，
不先把这个标记搬到 `story_digests` 就不能删任何一行）。
**其中前两条已由第二十五轮做掉**（预算分「速率」与「花费」两个口径、`expireInSeconds` 与停机窗口按一次思考调用重算），
剩下几条仍是工单。

## 第三十五轮（2026-10-06 傍晚）：改在代码里的队列参数，其实一直没进库

**0. 这一轮做的是第三十四轮留下的两张工单（#78 预算口径、#79 时间窗口），但真正的收获是第三条没在清单上的**。
`tests/` 跑全套时日志里一直有一行 `queue content.analyze: QUEUE_OPTIONS differs from the stored queue`，
那行是我上一轮写的，写的时候只当成"已知不一致，报出来"；这次顺着它查下去才发现：**pg-boss 的
`createQueue` 对一个已存在的队列是空操作**，所以第三十四轮把 `expireInSeconds` 从 600 提到 1500 这件事
只存在于代码里，线上那一格至今是 600 秒。

**1. 预算分成「速率」与「花费」两个口径（#78）**。`providers/receipts.ts:checkBudget` 原先三个窗口数的是
同一件事——`receipt_attempts` 里的行数。429、连不上、超时这些**没花一分钱**的尝试也照样占位，
于是代理故障能把当天 6000 次的额度烧光而不产出任何一条摘要，而这些条目本来就是我们要救的。
现在分钟窗口仍数全部尝试（那是给上游限速用的），小时与天窗口只数真花了钱的：`status='failed' AND usage IS NULL`
的行不再计入。`tests/receipts.test.ts` 用 300 条两小时前的失败尝试钉这条——旧写法在这里会直接判死。

**2. 一次开了思考的调用是 240 秒，所有窗口都按它重算（#79）**。
- `content.analyze` 的 `expireInSeconds` 600 → **1500**：一篇文章是 5 次串行调用（预筛 + 两次评分 + 写作 + 结构），
  5 × 240 = 1200，再给余量。窗口比这短，pg-boss 会在调用还在跑的时候把任务判死，而 `policy:"short"` 的去重
  只挡 `created` 状态——同一条目可能再跑一遍（钱花两次）。
- `STOP_TIMEOUT_MS` 195 → **255**：注释原先写"最长付费调用 180 秒"，那是接 agnes-3.0-flash 之前的世界。
  停机窗口比一次调用短，部署就会在调用中途收手，留下一张 outcome-unknown 回执：钱花了，条目还要等 ops 释放。
- systemd 的 `TimeoutStopSec` 210 → **285**（四个单元模板里的 worker、`install-units.sh` 生成的两份、
  `docker-compose.yml` 的 `stop_grace_period`、`DEPLOYMENT.md` 与 `README-deploy.md` 的说明）。
  这一条是"链条上每一环都比下一环宽"的对齐，不是给 worker 加保险。

**3. `ensureQueue` 现在自己把库里的行对齐代码（本轮新增，也是第 0 条的解）**。
pg-boss 12 其实有公开的 `updateQueue`：逐列 `COALESCE` 的 `UPDATE pgboss.queue`，**不重建队列**，
所以等待中的任务一条都不会掉——这正是我上一轮写"不能手工修，重建队列会丢掉等待中的任务"时漏掉的那个 API。
两条边界：
- `policy` 与 `partition` 它拒绝改（改了只能重建队列，那才是真会丢任务的动法），这两个键只报 warn；
- 写不进去只 warn，不抛。`enqueue` 是在业务事务里被 await 的（`publishArticle` 把精选通知与媒体准备放进同一条 tx），
  这里抛出去就等于那条发布回滚——第二十四轮刚修过一类"一次失败让之后每一次发布都回滚"的错，不重犯。

实测证据（本机 CI 库跑全套时新增的一行日志）：
`{"level":"info","msg":"queue content.analyze: stored options did not match QUEUE_OPTIONS, applied","wanted":{"expireInSeconds":1500},"stored":{"expireInSeconds":600}}`。
`tests/queue-options-drift.test.ts` 钉三条：对齐生效且等待中的任务还在、`policy` 不动库也不假装改好、对齐失败只报不塌。

**4. 部署含义 + 线上实测（本轮第一次真的把单元装上去）**：
- **那四个线上单元里根本没有 `TimeoutStopSec` 这一行**（`systemctl show` 全部是默认 `1min 30s`，文件日期停在 10-01 16:17）。
  也就是说单元文件写过的窗口从来没在线上生效过：worker 一停就 90 秒 SIGKILL，而一次开了思考的调用允许 240 秒
  ——过去每一次部署都在半途掐掉在途付费调用。本轮 `install-units.sh --apply` 之后四个单元都读到 `4min 45s`。
- `pgboss.queue` 里 `content.analyze` 上线前实测 **600**，重启 api/worker 后自动变成 **1500**，journal 里留着那行：
  `queue content.analyze: stored options did not match QUEUE_OPTIONS, applied wanted:{"expireInSeconds":1500} stored:{"expireInSeconds":600}`。
  这条对齐发生在**进程第一次碰到该队列时**，所以上线必须重启 `geohot-api` 与 `geohot-worker`；
  平时验收一条 SQL 就够：`SELECT name, expire_seconds FROM pgboss.queue WHERE name='content.analyze'`。
  幂等性有实证：第二次跑全套时不再有那行日志。
- 顺手记一笔免得下次吓一跳：线上 `geohot-web.service` 里有一行 `Environment=BASE_PATH=/geohot`，
  而 `install-units.sh` 生成的单元没有——**那行是惰性的**（`apps/web/server.ts` 全文不读 `BASE_PATH`，
  前缀来自构建时烘进 bundle 的值，见脚本里那段注释），重装单元不会把站点从 `/geohot` 挪走。
  本轮重装前先把旧单元备份到 `/root/units-backup-<日期时刻>/`。

**5. 顺带清掉一处测试泄漏（本轮发现）**。`tests/analyze-shutdown.test.ts` 每跑一次建三个真实的 pg-boss 队列
（`-final`/`-false`/`-true`），而 `purgeTagged` 收的是本站的表、收不到 `pgboss` schema——开发库里数到 **108 行孤儿队列**。
现在这个文件自己在收尾时按前缀删（`pgboss.job` 与 `pgboss.queue` 两张），顺带把泄漏存在期间攒下来的旧行一起清掉：
本机实测跑前 108 行、跑后 0 行，三条断言不变。**这与第七轮那批夹具泄漏是同一族**：
测试自建的共享基础设施（信源、队列）必须自己收回，否则红绿由"前面跑过几轮"决定。

**6. 验证基线**：typecheck 八份工程 0 错；`npm test`（CI 库、串行）**314 项 / 309 通过 / 5 跳过 / 0 失败**
（新增 4 条：预算两本账 1 条、队列对齐 3 条）。上线后：`verify-deploy.sh` ALL CHECKS PASSED（含 `smoke.ts` 全绿、
跨出口期数一致、六个出口每条都有中文标题），三端逐字节一致 **619 个 blob**（本地 HEAD = 服务器 = GitHub main），
隔壁主站首页哈希 `4edf0fc53636a680` 动手前后未变。生产库当天实况：`content.analyze` 过期窗 1500、
最近 30 分钟新入库 10 条、近 24 小时 753 条、近一小时真调用 248 次（小时闸 420）、
近 24 小时 `failed` 且无 usage 的**不计费**尝试 76 次——这 76 次在改动前会照样占用当天的 6000 次额度。

## 第三十六轮（2026-10-06 傍晚）：把 #80 那串零碎项逐条量了一遍——四条成立、三条不成立

**0. 这轮的方法**：第三十四轮留下的是一张混合清单（后台查询、索引、读者可访问性）。清单里每一条都可能是错的，
所以先量再改：生产库上只读 `EXPLAIN (ANALYZE, BUFFERS)`、把表复制成临时表做索引试验、派一个只读智能体逐条核对
七个读者端断言（它给的结论，关键两条我又自己读了代码复核）。**结论：四条成立已修，三条不成立记录理由。**

**1. 后台"需要运营处理"那条列表：确实每次都在扫全表（成立，已修）**。生产实测 `Seq Scan on receipts`，
51,206 行读 10,467 个页（约 82 MB）、**258.6 ms**，只为取出 22 行。已有的 `receipts_status_idx` 是部分索引，
只收 `pending`/`unknown`，而这条查询一半的行数来自 `failed`，用不上。把同一张表复制成临时表、加上
`(status, updated_at)` 再跑同一条查询：**BitmapOr（三个索引扫）→ 0.133 ms / 33 个缓冲页**，命中同样 22 行。
这条收益不依赖可见性位图（要回表取整行），所以临时表的测量可以直接外推——落成迁移 **0046**。

**2. 同一份清单里另外三条"索引类"判断，量下来都不成立**（记下来免得下一轮照改）：
- **状态计数那条**（`SELECT status, count(*) FROM receipts WHERE created_at > now()-'7 days'`，实测 803 ms / 10,175 页）
  加覆盖索引治不了：这张表从 10-01 部署到现在总共 5.1 万行，**全部落在 7 天窗口里**，规划器在同数据的临时表上
  两次都选了 Seq Scan（`(created_at) INCLUDE (status)` 和 `(status, created_at)` 都试过）。它的病根是"只长不清"，
  属于 #62 那张保留期工单，不属于索引。
- **`articles_processing_idx` 少了 `discovered_at`**：那条 30 天失败分组查询实测 **15 个缓冲页、亚毫秒**，现在的索引够用。
- **`deliveries` 的翻页**：这张表线上 **0 行**（通知模块没打开）。给它加索引是替一个不存在的读者做优化。
- 顺带一条好消息：每笔付费调用都要跑的预算窗口查询**走的是索引**（`receipt_attempts_service_time_idx`，
  2.97 ms / 329 页），评审担心的"每笔调用扫 5 万行"不成立。

**3. 三处后台列表按 OFFSET 翻页，排序列不唯一（成立，已修）**。`admin/feedback.ts` 排 `created_at`、
`admin/monitor.ts` 排 `published_at`、`admin/sources.ts` 排到 `name`——并列行的次序由执行计划决定，
同一条可能在第 1、2 页各出现一次，也可能一页都不出现。三处各补一个唯一列收尾（`fb.id` / `p.id` / `s.id`）。
**为什么钉的是写法而不是行为**：Postgres 对相等键做快排、不保证稳定，但单线程顺序扫描时两次执行**常常**给回同一个
顺序，于是"翻两页看有没有重复"这种测试在没有修复时也可能通过——那它记录的是抽样，不是规则。改成扫源码的不变量
（`tests/admin-page-order.test.ts`：每一处 `OFFSET ${` 的查询，ORDER BY 最后一项必须是 id 一列；本轮扫到 7 处，
正是这三处要修、读者侧那四处本来就对），把 `, fb.id` 删掉它立刻红。

**4. 读者端那七条里，成立并修掉的是四条**：
- **「另有 N 篇报道」比点开能看到的行数多 1**：面板 `others` 排除了读者正在看的那一条，提示印的却是含它的总数。
  现在印 `reportCount - 1`。"另有 N 家信源"那条分支不动——它数的是"家"，本来就是列表之外的信息。用真 SSR 输出钉住。
- **事件页摘要的两行截断在没有 JavaScript 时会咬人**：那个"展开摘要"按钮要靠客户端测量才出现，
  没脚本就既截断又没有出路，而 `root.tsx` 的 noscript 告示承诺过"事件页照常可读"。改成
  `[@media(scripting:enabled)]:line-clamp-2`：不认识这个媒体特性的浏览器整条不匹配，默认落在"不截断"那一侧，
  降级方向是对的。已核对构建产物里确实生成了 `@media (scripting:enabled){…-webkit-line-clamp:2…}`。
- **热点榜那个名次 span 带着 `aria-label` 却没有角色**：generic 角色不允许命名，读屏只会念"04"。补 `role="img"`，
  与分数徽标 `components/ui/Score.tsx` 同一个写法。
- **条目页的原文标题没有语种**（整页 `zh-CN`，那句往往是英文）：补 `lang={item.language}`——用条目自己登记的语种，
  不是猜一个 `en`（WCAG 3.1.2）。

**5. 不成立的两条**：主题页的空态早就修好了（`routes/topic.tsx:88-111` 有 `EmptyState`，还分"第 N 页没有内容"）；
"ScoreLabel 面板不可键盘操作"描述的其实是一枚静态徽标（`components/ui/Score.tsx` 没有 onClick、没有展开态），
真正的"热度是怎么算的"用的是原生 `<details>/<summary>`。评审还留了两条本轮没动：`Menu` 没有 ArrowUp/Down
（Esc、焦点归位、role 都对，是 APG 模式做了一半），以及监控模块那张日历的 `rowgroup → gridcell` 中间缺 `row` 一层
（那个模块 `FEATURES` 是关的，属于已经记在案上的"两个关掉模块"死代码范围，留还是删归站长）。

**6. 我自己在这轮里犯的一次错，值得单独记**：给两处 ORDER BY 补解释时把 `//` 注释写进了 **SQL 模板串内部**——
`//` 在模板串里不是注释，是**发给数据库的文本**；而我的注释里带反引号，于是**提前终结了这个模板串**。
后果：typecheck 报 6 处语法错、13 个测试文件起不来（它们都从 api 的 app 间接 import 到 admin）。
这条落成一条仓库级不变量（`tests/env-valves.test.ts` 新增：537 个 SQL 模板串里不许出现 `//` 行），
写注释要么写在语句上方的 TypeScript 注释里，要么用 SQL 自己的 `--`。

**7. 迁移是运营动作，测试不会替你跑**：`tests/setup.ts` 用的是一份**已经迁移过**的 CI 库，执行迁移的是
`scripts/migrate.ts`。本轮 0046 刚写完时 CI 库还停在 42 条、新索引不存在，而全套测试照样全绿——
也就是说"测试通过"从来不证明新迁移能跑。已对本机 CI 库与 dev 库各跑一次（两边都是 43 = 43，与 README 那句口径一致），
部署时在服务器同一脚本核对。

**8. 验证基线**：typecheck 八份工程 0 错；`npm test`（迁移后的 CI 库、串行）**316 项 / 311 通过 / 5 跳过 / 0 失败**；
web 构建 + `apps/web/tests` **35 项全绿**（新增 2 项）；`npm run db:migrate` 本机两份库各 1 条待迁移并跑通。

**9. 上线后的实测**（同一轮里跑，不是推断）：迁移 0046 在服务器执行（`applied 0046_…`，1 条），
同一条后台查询在生产库的计划从 `Seq Scan`（10,467 页）变成 **Bitmap Heap Scan，56 个缓冲页、22 行**；
`verify-deploy.sh` ALL CHECKS PASSED（含 `smoke.ts` 全绿）；线上 CSS 里能取到 `@media (scripting:enabled)`，
说明那条截断改动确实进了服务端的 bundle；三端逐字节一致 **621 个 blob**（本地 HEAD = 服务器 = GitHub main）；
隔壁主站首页哈希 `4edf0fc53636a680` 动手前后未变。
一处**没有**当场证明的东西如实记下：热点榜那个 `role="img"` 名次行的改动只在构建产物里核对到
（`apps/web/build/client/assets/hot-*.js` 含那句「热度排名第 N 位」），线上这一刻 `/hot` 的榜单不足 10 条、
第 4 名以后的行没有渲染，所以"读屏念得出名次"这件事要等榜单长到 4 条以上才算被真实数据走通过。

## 第三十七轮（2026-10-06 深夜）：#62 的前置搬完了——「这一版综述谁写的」不再住在回执里

**0. 这一轮做的是 #62 的前置条件，不是保留期本身**。那张工单挂着六轮没动手，原因是它写着"不先把这个标记
搬进 `story_digests`，删任何一行都会把综述永久冻结成机器签过"——这次把这件事做完。

**1. 标记搬到行自己身上（迁移 0047 + 读出点 + 写入点）**。`events/digest.ts` 判断"在服务的那一版是不是规则
拼的"时，原先 `LEFT JOIN receipts` 读 `usage.brain.rule`；现在读 `story_digests.machine_rule`（这一列由
迁移 0047 加，NULL = 人签的）。写入点也显式写这一列——走到插入说明答案已被接受、`rule` 必为 null，但让写入点
自己说清楚，日后闸门放松时这一列自动跟着是真的。

**2. 实测证据（回填脚本的 dry-run，两套库各跑一次）**：
- **本机开发库：1319 行里 1294 行**被标成 `rule:chronology`；**生产库：2946 行里 2593 行**（回填前实测）。
  这些正是闸门落地之前写下的存量——回执表一旦按保留期清理，它们会被旧读法读成"人签的"，机器的综述
  就此永久冻结。做完全量回填后生产库是 `2593 非空 / 353 空`（`SELECT count(*) FILTER (WHERE machine_rule IS NOT NULL), count(*) FROM story_digests` 现查）。
- **这一条差点被我写错，记下来**：动手前我用一句手写的 SQL 数过一遍，得到"生产 0 行"，据此在本轮第一版
  文档里写了"生产上的回填是一次空写"。**那句 SQL 是错的**（`usage -> 'brain' ->> 'rule' …` 拼得比
  `machineRuleOf` 严），脚本一跑就露出 2593 行。教训与这条迁移的动机是同一件事：**判据只能有一个**——
  脚本调的是运行时那个函数，我手写的那句不算数。
- **动作顺序也踩了一下**：代码先上线（读出点改成读空列）、回填后跑，中间那几分钟里这 2593 行会被读成
  "人签的"（它们原本靠回执里的 usage 才算机器写的）。回填一跑完就恢复了原语义。**这类"先改读、再搬数据"的
  迁移，正确顺序是先加列、先回填、最后才切换读点**——本轮已在生产上补正，顺序问题记在这里给下一次用。

**3. 回填与测试**。`scripts/backfill-digest-machine-rule.ts`：默认 DRY-RUN，`--apply` 必须显式给
`--database-url`（与 `set-source-state.ts`/`restore-body-from-backup.ts` 同规），判据调
`editorial/provenance.ts` 的 `machineRuleOf`——**不在 SQL 里抄一遍"什么叫机器写的"**。
`tests/story-digest.test.ts` 里那条既有测试改成**先把回执整行删掉**再验（旧读法在这时会读出"没有 usage ⇒
不是机器写的"），另加一条反面：标记清空后照旧不重写、不花钱（否则每次触发都要重付一笔，而且运营看到
"重写过"反而看不出哪一版已经签过）。

**4. 仍然没做的那一步，以及为什么不做**：真正的保留期是一条 `DELETE`。它同时是**破坏性动作**（删的是
编辑判断的凭据）与**内容诚信口径**（"谁写的"要能追溯多久），按仓库规矩属于站长的决定，本机不替它定窗口。
前置已清，开它是一行；要看它会删多少行，先跑那条 dry-run 脚本（`receipts` 里 `status IN ('completed','failed')`
且早于窗口的行；今天 5.1 万行全在窗口内，所以窗口定多大就删多少，这正是必须由人来定的原因）。

**5. 验证基线**：typecheck 三份相关工程 0 错（本轮改动落在 `packages/backend`、`tests`、`scripts`）；
`npm test`（CI 库、串行）**323 项 / 318 通过 / 5 跳过 / 0 失败**；`tests/story-digest.test.ts` 9/9（含新增两条）；
迁移 0047 已在本机 CI 库、开发库与生产库各跑一次（三份都到 44 条，`README` 与 `README.en.md` 的现值同步改成 44）；
生产回填后 `story_digests` 是 2593 非空 / 353 空（含 0 行缺回执）；四个单元重启后全部 active。

## 第三十九轮（2026-10-06 深夜）：精选与日报为什么这么薄——门槛压在分布的 p95 之上（**标定问题，等站长定**）

**0. 这轮没有改门槛。** 门槛与"什么算重要"在 `industry/selection.ts`，按 AGENTS.md 由站长逐条确认；这一轮做的是
**把它量清楚**，并把选择摆成一张随时可复算的表（新脚本 `scripts/eval-thresholds.ts`，只读、一条 SELECT）。

**1. 旗舰面薄到什么程度（生产实测，10-06 00:00+08 之后）**：精选近 24 小时新增 **3 条**；日报 `2026-10-04/05/06`
三期的 `sections` 都是 **0**（读取层跳过空刊，所以 `/daily` 回落到 10-03）。这不是读取层的问题，是上游供给。

**2. 根因：三个门槛都压在各自分数分布的 p95 之上**。真模型的打分（pass 条目）实测：

| 分层 | n | 均值 | p90 | p95 | 最大 | 现行门槛 |
|---|---:|---:|---:|---:|---:|---:|
| T1 | 351 | 22 | 33 | 41 | 61 | **56** |
| T1_5 | 14 | 35 | 49 | 53 | 53 | **59** |
| T2 | 49 | 28 | 45 | 50 | 57 | **62** |

T1_5 与 T2 两档**从来没有条目达到过自己的门槛**（样本内最大值 53 / 57，门槛 59 / 62）；T1 档一天也就 3–5 条过线。
`understandFloor` 46 同样够不到（T1 的 p95 是 41）——那条"没入选但过线也给完整中文稿"的设计路径在真模型下也几乎不触发。

**3. 换成别的门槛会选多少（同窗口，1.0 天）**：门槛 40 → 38 条/天（窗口内 38）；44 → 21；**46 → 16**；
48 → 15；50 → 12；52 → 10；54 → 7；56 → 5；58 → 3；60 → 1；62 → 0。
四条路摆在站长面前，各有代价，**没有一条由我替他选**：
- **不动门槛**：继续一天 3–5 条，日报多半还是空刊（`/daily` 一直回落到上一期）。这是"宁缺勿滥"，但站上最主要的两个面长期接近静止。
- **降到 46 附近**（与 `understandFloor` 同一条线）：一天约 16 条，日报每天能成刊；代价是精选里会混进更多"县级预警、例行数据更新"级别的条目。
- **降到 40**：一天约 38 条，接近上游那种"一天几十条"的密度；这与本站"只留几条"的自我描述冲突，也会稀释精选。
- **改提示词而不是门槛**（让五轴的 10 分锚点更贴近真实分布）：动的是"标准的执行者"，风险是新旧分数不可比——真要动，得先留一批双跑样本。

**4. 这一轮只做了一件事的两半**：把上面这张表和候选门槛做成 `scripts/eval-thresholds.ts`（`--since` 可换窗口，
生产上已可复算），并如实写在这里。**改不改、改成多少，等那句"可以"**；改的话是一行（`SELECTION.thresholds`），
改完要连 `README` 那句"门槛是推出来的"一起重写，并用 `scripts/refill-copy.ts` 把既有条目重跑一遍。

**5. 验证基线**：新脚本 typecheck 通过、本机 dev 库与生产库各跑一次（生产输出即上表）；
其余与本轮改动无关的面沿用第三十八轮基线（三端 625 blob 全等在此轮之后只多这一条脚本文档）。

## 第四十/四十一轮（2026-10-06 深夜）：门槛下移落地、六条权威信源，以及「补不了那三期」的真相

**0. 两件由站长点名的事**：入选门槛下移到 46（他看过复算表后选的）；再拓展一批权威官方信源。
两件都做完了，但**「把 10-04/05/06 三期空刊补上」这件事补不了**——原因不是工具不行，是一条我们自己定的归期规则。

**1. 门槛：56/59/62 → 46/49/52，写作线 46 → 36**。档差保持 3 分（`tests/noise-ceiling.test.ts` 钉着
`T1 ≤ T1_5 < T2` 这条原意：对同一份内容媒体层比官方一手更严——三档同值会让 T2 凭空松 6 分）。
历史推导（按**人工写的**两次分推的 56/59/62）原样留在 `industry/selection.ts` 文件头，不再生效。
`scripts/eval-thresholds.ts` 可随时复算；下一次重标定仍按 docs/selection.md 先标 100–200 条 gold 再动。

**2. 存量重判，不花模型额度**：`analyses.selected` 是分析那一刻按当时门槛写下的布尔值，改门槛不会回头改它；
但那两次分数一直存在 `analyses.output->'scores'` 里。新脚本 `scripts/reselect-by-threshold.ts`（DRY-RUN 默认、
`--apply` 必须显式 `--database-url`）用**同一个算式**重判并写回，再按源 `republishSource`。生产实测：
看 8069 条 analyses、17 条翻成入选、0 条退出；全站精选 59 → 77，今天新增入选 11 条（此前 3 条）。
核对口径：`publications.selected` 与 `analyses.selected` 双向 0 差（写完之后查过一次）。

**3. 那三期为什么补不上（记清楚，别再试）**：`reports/compose.ts:89-90` 的归期规则是
**「按读者能看到的时刻」**——`visible_after <= timeline_at` 用 `timeline_at` 归期，否则用 `visible_after`。
重判把三条 10-04/10-05 的老条目**在今天（10-06 23:15）才释放**，于是它们的 `visible_after` 落在 10-07 那一期，
**不会回到 10-04**。加上 `NOT p.backfill`（晚到的旧文不进当期）与 10-05 全天按新门槛**也只有 0 条**，
三期重排的结果就是 0 条候选——这不是工具没跑通，是这三期当时确实没有可印的内容。
**要让它们印进历史期次，只能去改 `visible_after`/`backfill` 的语义，那等于让报纸回头印刷"当时没人看过的稿"**，
与本仓库内容诚信的规矩冲突——当时没有做。**2026-10-10 的档案回填只对其一种来源放开**：`backfill_reason='archive'`（Crossref 按 ISSN + 出版日期回填的那批）进**它自己那一天**的报纸，并且**不进它入库那一天**的；first-import 与 stale-on-discovery 照旧一律不进（`reports/compose.ts` 的 `candidates()`，两个方向都由 `tests/archive-paper-rule.test.ts` 钉住）。版面上从 10-07 那一期起恢复。

**4. 信源 98 → 104**（IGU / AAG / ICA / IPBES / ISC / UN-Habitat）：全部先在**采集那台机器**上用采集器自己的 UA
实测（feed 活着、条目数正常、最近一条 45 天内），再写进包，再在生产库 `scripts/collect.ts` 真抓一次——
六家首次入库 32 条（2 / 2 / 2 / 22 / 2 / 2），全部通过。**退回清单**（UNEP 的订阅口是自定义 XML、GVP/GBIF/AMS/JAXA 等 403、
一批官方站页面可达但没有 feed、几家 feed 已停更）与「中国官方站下一轮候选（CAS / MOST 要按 web_list 写选择器）」写在
`docs/sources.md` 的「第四十一轮」一节。两份 README 的信源口径同步改成 104（徽标 104+1、启用 91、本机 106 行、
defaultCategory 56、可轮询 88 / 在轮询 83 及各级分档）。

**5. 验证基线**：typecheck 八份工程 0 错；`npm test` **323 项 / 318 通过 / 5 跳过 / 0 失败**；web **36/36**。
两条因写死算术而红的断言改成了从 `SELECTION` 派生（analyze 的 RESCUE/LOW/推文 分数、noise-ceiling 的 lopsided 对）。

## 第四十二轮（2026-10-07 凌晨）：条目页「更多操作」菜单补上方向键与焦点归还；日报恢复的先行指标

**1. `Menu` 的键盘行为补完（读者可见的那一处）**。上一轮评审留下的两条里，这条落在**在用的界面**上：菜单声明了
`role="menu"`，却只有 Escape 与"焦点归位"两件，方向键没人接——读屏用户按惯例拿方向键试，焦点会卡在原地。
现在按 APG 的 menu 模式补完：**打开就把焦点交给第一项**，↑/↓ 在项间环绕、`Home`/`End` 跳到首末、`Tab` 关闭菜单。
**关的时候是否把焦点还给触发按钮**，三种关法分开：Escape 与选中项 → 还给触发按钮；**点菜单外面**与**按 Tab 走出去** →
不还（用户正要去别处，抢回来是打断）。实现里踩到一个顺序问题：`hadFocus` 靠 `focusin` 监听置位，而"打开时主动聚焦
第一项"发生在这个监听挂上之前 → Escape 关掉时不会还焦点（浏览器实测抓到的），改成打开时直接置位并由上面两种情况清掉。

**证据（真浏览器，本地构建产物 + 本地 api，1280×900，零 console 报错）**：菜单可见 ✓、打开后 `activeElement` 是
`role=menuitem` ✓、↓ 到「生成分享海报」、↑ 回到「分享链接」✓、Tab 后 350 ms 菜单已关 ✓、Escape 后焦点回到
`aria-haspopup="menu"` 的触发按钮 ✓、点菜单外面关闭后焦点**没有**被抢回触发按钮 ✓（这条是本次改动的回归点）。

**2. 监控模块那张日历的 `rowgroup → gridcell` 缺 `row` 一层：**这轮没动，理由是它**不在读者路径上**
（`FEATURES` 里监控是关的，`/codex-reset` 404），而正确修法要么把每个星期包一层 `role="row"`（改 DOM 与栅格布局），
要么用 `display: contents` 的老办法（ARIA 在 `display:contents` 元素上的暴露行为浏览器之间仍有差异）——
**等这个模块真的要打开时再修**，那时它才承担读者责任。记在这里，免得下一轮当成新发现。

**3. 日报恢复的先行指标（任务 #85 的一半）**：用 compose 自己的候选查询（`scripts/recompose` 之外直接 import
`reports/compose.ts` 的 `candidates`）跑 10-07 那一期窗口：**16 条候选**已就位（水利部十五五水网目标、FAO 全球土壤
侵蚀报告、阿根廷土地外资化、Eos 朝鲜滑坡、中新网海水淡化……），来源横跨中新网、Phys.org、卫报、Grist、Eos。
也就是说 08:00 那一期会成刊；正式验收等它生成后再看一眼 `/daily`。

**4. 验证基线**：typecheck 八份工程 0 错；`npm test` **323 项 / 318 通过 / 5 跳过 / 0 失败**；web **36/36**；
本地构建 + 真浏览器走查 8 项全过（上表）。

**5. 门槛下移后的出口对账（本轮顺带核的）**：线上四路取同一个精选集合——`/api/site/stats` **visible 70**、
`/api/v1/selected/snapshot` **70**、`/api/v1/items?mode=selected` **69**、RSS 50（它自己的条数上限）。
差的那 1 条是 `cl13`（湄公河树木覆盖损失，时间线在 7 天窗口之外）：**列表接口带滚动窗口**（`v1.ts:17` 默认 7 天，
`window=24h` 可换），快照不带——这是 `window` 参数的设计差异，不是成员判定分叉；两边都没有英文标题条目（0 条）。
记下来，免得下一轮把它当成漂移重查。

**6. 文档口径（本轮做完）**：门槛作为"现值"出现在六份文档里（两份 README + `manual/selection/customize/runbook/sources`），
全部从 56/59/62、112/118/124、floor 46 改成 **46/49/52、92/98/104、36**，并在每一处写清两版的来历
（旧版按人工分推、新版按真模型分布重标定、**两版都未过 gold 集**）。`docs/sources.md` 的登记间隔分布按现值重数
（104 条：6/12/1/23/4/34/11/5/8）。`known-issues` 里的历史数字刻意保留——那是记录，不是现值。

**7. MCP 七个出口逐个实打（2026-10-07 00:1x +0800，线上 JSON-RPC）**：`initialize` 回 `geohot 2.0.0`；
`geohot_get_latest`（2 条，带"不可信资料"边界与前缀说明）、`geohot_search`（`q=洪水` 3 条命中，
首条《朝鲜拉森市降雨触发滑坡》）、`geohot_get_hot_topics`、`geohot_get_story`（湄公河事件，508 字符）、
`geohot_get_daily`（回落到 10-03 那一期——10-04～06 是空刊，与被读取层跳过一致）、`geohot_get_weekly` 全部 `isError=false`；
`geohot_get_monthly` 回 `isError=true` + "还没有公开的地理月报"——**这是既定口径**（MCP 遇空刊直接 not_found，
Agent 分不清空壳与内容），不是缺陷。另记一笔我自己的调用错：`geohot_get_story` 的参数名是 `public_id` 而不是 `id`，
传错时工具回的是明确的 `Input validation error`（不是静默空结果）——出口的入参校验是好的。

**8. 线上全站真浏览器走查（2026-10-07 00:17 +0800，生产构建）**：九个页面全 200——首页（42 张卡片 + 「当前热点」块）、
`/all`（40 张卡片）、`/hot`、`/daily`（回落 10-03，与空刊设计一致）、`/topics`（43 个主题链接）、条目页、
事件页、`/about`、`/changelog`；**搜索**输入"洪水"回车 → URL 带 `q=`、返回 40 条；**本轮改的菜单在生产构建上复验**：
打开 ✓、↓ 落在 `role=menuitem` ✓、Escape 后焦点回到触发按钮 ✓；**控制台零报错**。
两个坑都是探针自己的（不是站点）：① 用 `base + href` 拼接时 href 已经是根相对（`/geohot/…`），拼出
`/geohot/geohot/…` 的 404——**拼地址前先看 href 的形状**；② `domcontentloaded` 之后 hydration 还没落地，
键盘按下去没人接，看起来像"菜单坏了"——**线上做交互探针要先等 hydration**（`networkidle` + 约 1 秒）。

## 第四十三轮（2026-10-07 凌晨）：两条旧工单结案——一条早在第 23 轮就修好了，一条量完才敢删

**1. `admin/selectbench.ts`「report 未校验」是第 23 轮就已修好的旧账（结案）。** 第 21 轮第 5 条与第 22 轮
第 8 条把它记成"类型错报 500 而不是 400"，但第 23 轮第 2 条已经修掉：cases 与 meta 各过一层 zod
（`CaseSchema`/`MetaSchema`），`apps/api/src/routes/admin-auth.ts:81` 把 ZodError 统一映射成 400。
这轮重读这两处代码确认仍在（没被后来的重构退回去），上面两处按记录保留、不再当工单。

**2. `ITEM_COLUMNS` 里 `eligible`/`backfill` 两列删掉了（第 23 轮第 4 条"先不动"的三列里的两列）。**
第 23 轮评审说这三列无人读，当时我只核到 `syndicate` 确实被 `feeds.ts` 用，剩下两个没量就没动。这轮逐个
出口核完，这两列确实没有读者：

- `ItemRow` 的消费者全是 `Pick<ItemRow, …>` 或 `toItemSummary()` 投影（detail / feeds / groups / pool /
  timeline / topics / v1 七处），没有一处 `...row` 整体外传或序列化（grep 过）；
- 唯一读 `.eligible` 的界面是后台 `routes/admin/content-item.tsx:109`（「不进公开面」徽标），它的数据来自
  `admin/content.ts` 的 `contentChain()`（`SELECT * FROM publications WHERE article_id = …`），不走 `ITEM_COLUMNS`；
- 写入侧 `publish.ts`、采集侧 `materials.ts`、通知侧 `notify/selected.ts` 里的 `.eligible`/`.backfill`
  都是各自查询/参数，与读取层无关。

删的是 `ItemRow` 两个字段与 SELECT 里 `p.eligible`/`p.backfill` 两列；`syndicate` 留下（feeds 在读）。
证据：八份工程 typecheck 0 错——类型层有读者就编不过，这是最强的"无人读"证明；`npm test` **323 / 318 通过 /
5 跳过 / 0 失败**，与改动前基线逐项一致。

## 第四十四轮（2026-10-07 凌晨）：期号落库——「第 N 期」不再数下标

**1. 报眼「第 N 期」从「数出来的」改成「盖上去的」（工单：本文件「独立审计」第 5 条，结案）。**
以前的号是页面在最新 400 期索引里数下标（`index.length - at`）：办满 400 期之后先停再退，代码只好在
窗口满时把期号整个隐去——一份忽然没有期号的报纸。现在号在成刊那一刻盖一次章（`reports.issue_no`，
迁移 0048；模式与 `selected_ledger.seq` 相同）：

- **盖章条件照着读取层的门写**：有引注的期（daily 的 `sections[].items`、weekly/monthly 的
  `themes[].storyRefs`，与 `citedItemIds` 逐字段同形）才消耗号；空刊（10-04～06 那类）不占号——这
  与它不出现在归档里是同一件事；迟到的旧刊（后面那期已经先拿到号）同样不占号（见下第 6 条）。
- **号盖上就不动**：重排（版次前进）保号；一条引注日后被撤下也不重排全系列——期号从不回收。
- **并发下不当两个人**：同 kind 取号在同一事务里过 `pg_advisory_xact_lock`，另有 `(kind, issue_no)`
  唯一索引兜底——宁可是发布失败重跑，也不能把「第 3 期」印两遍。
- **存量回填（生产库实测）**：迁移按 kind、按 key 序盖章——`2026-10-02 → 第 1 期`、`10-03 → 第 2 期`
  （与站上当日展示一致）、`weekly 2026-W40 → 第 1 期`；全部空行（09-25～10-06 那批、10-04～06、W39、
  月报 2026-09）保持无号。回填结果先用同一谓词的 SELECT 在线上预演过，再随迁移执行。

**2. 前端降级为读字段。** `features/report/format.ts` 的 `issueNumber` 改读条目上的 `no`（读层从
`reports.issue_no` 带出，`listReports` 与 `reportNavigation` 都携带；契约 `ReportIndexEntry` 加
`no: number | null`）；`INDEX_WINDOW` 与「窗口满就隐去」连同 2027-11 的期限一起删除。月历格保持
既有三态：有号印号、有期无号只印日期（不说未出刊）、没有期的才说未出刊。

**3. `format.ts` 少一跳（顺带）。** `beijingWeekday` 改从 `@aihot/contracts/time` 直接引入——原来绕
`apps/web/app/lib/format.ts` 的转口再导出，是同一个函数；这也让这个模块能被 `node --test` 直接加载
（web 测试对无扩展相对导入有解析限制）。

**4. 证据。** 新增 `tests/report-issue-number.test.ts`（发布盖章递增 / 空刊不占号 / 重排保号 / 读层
携带，**4/4**）与 `apps/web/tests/report-issue-number.test.ts`（读数不数位次 / 无号不猜 / 月历三态，
**5/5**）；`industry/changelog.json` 记了一条读者可见的「修复」。全套基线：typecheck 八份工程 0 错；
`npm test` **327 / 322 通过 / 5 跳过 / 0 失败**（较基线 +4，正是新测试）；web **41/41**（+5）；web 构建 0 错。

**5. 顺带一条：api 的 Fastify 弃用警告清掉。** 部署后翻日志时注意到每次 api 启动都有一条 `FSTDEP023`
——`disableRequestLogging` 的顶层写法在 fastify 5 已弃用（fastify@6 要删），迁到
`logController: new LogController({ disableRequestLogging: true })`（同一个类、同一个子选项，语义 1:1）。
证据：apps/api 类型检查 0 错；`feedback-upload` 3/3、`publication-read-guards` 全过；部署后
`journalctl -u geohot-api` 里 FSTDEP023 计数为 0。这条不在测试清单上：fastify 的弃用警告只在进程启动
时出，测试套件看不到它，以后每轮上线后顺手 grep 一次日志是值得的。

**6. 评审代理的对抗面：两处真缺陷，都在这轮修掉。**（一个只读评审代理按形状一致性、迁移口径、
并发、读者面、fastify 迁移、测试强度六问逐条打，结论带复现命令）

- **迟到的旧刊会顶着更大的号印更早的日期（已修，MAJOR）**：`nextIssueNo` 原来只取 `max+1`——碰上
  「某天成刊失败、后面那期先出了号、catch-up 再把它补出来」这条路，先出的后一期拿 N、后补的
  前一期反而拿 N+1（评审按 `schedules.ts` 的 missed/catch-up 路径复现了推演）。现在取号前先查
  「有没有已编号的期比它更新」：有就不给号——它照常可读可翻，只是不印「第几期」。系列号与 key 的
  先后恢复一致，也和 0048 的回填口径（按 key 序）一致。
- **0048 的重放角落（已修，MINOR）**：原回填语句在「迁移之后又有更早 key 的已引注行落库、然后又重放
  迁移」时会与唯一索引相撞、整个迁移中断（评审在共享测试库上重现过）。现在每个 kind 只有在完全
  没有号的时候才回填，重放是干净的 no-op。复核用独立临时库（建库、复现、销毁一条龙）：apply#1 编号
  `daily 1/2、W01=1`；apply#2 幂等；apply#3（先落一行更早 key 的已引注行）不中断、已有号一个不动、
  那行保持无号。**顺带记一笔教训**：评审在共享测试库上复现时留下了 6 行夹具（`2099-W08` 等），其中
  一行是「有引注的周报」，比 `publication.test.ts` 自己的夹具更新——当场把那条 `latest skips the
  newer blank issue` 断言顶红；夹具清掉后 16/16 过。共享测试库上的复现素材必须自己收干净（或换临时库）。
- **测试盲区（已补）**：`reportNavigation` 丢掉 `no` 会让每一期的报眼跟着掉号，而全套测试仍绿——
  现在读层用例同时断言列表与导航；「迟到的旧刊」有自己的用例（先出后一期、再补前一期）。测试还
  顺带踩到两个真有意义的坑，写进用例注释：期键要取在所有别的测试夹具键之上（别人用 2099，
  这个文件用 2100），以及 `publishedAt` 放在未来时 `releasedAt` 必须写真实时钟，否则读取层的
  `itemHasPage` 认为它还没放行。

## 第四十五轮（2026-10-07 凌晨）：运维面的评审波——四条、修四条

**背景**：第 44 轮之后，第二个只读评审代理扫了较少被翻的运维面（operations / notify / worker 调度 /
lib/cache）。四条全中，全部修掉；它同时给出「查过、干净」的清单（见文末）。

**1. `notify.selected` 的重试会被队列去重静默吞掉（MAJOR）。** 首次入队带 `singletonKey:
selected:<id>`（`publish.ts:301`），而重试入队不带 key——两个条目在同一个窗口里都 `retry` 时，两条
重试的空 key 撞上 pg-boss short 策略的唯一索引（`job_i1`，`state='created'`），第二次 `send()` 冲突即
丢，返回值还没人看：那张卡永远到不了群。现在每次重试带 `selected:<id>:<attempt>` 的独立 key，且
`enqueue` 返回 null 时打一条 warn——重试再被吞就有日志可查。

**2. `reports.daily` 的 missed-once 会在窗口合上之前就成刊（MAJOR）。** worker 停机跨过某天 08:00、
又在次日 00:00–08:00 之间重启时，pg-boss 立刻补跑错过的 daily，而 runner 不看时间直接
`composeDaily(今天)`——今天那扇窗还开着（到 08:00 才合）。这正是 catch-up 明确拒绝的事（一份钥匙走在
读者时钟前面的刊）；后果是一份半成品的日报挂几小时，还（经第 44 轮之后）永久盖上期号。现在 runner
先看「今天 08:00 ≤ now」才排刊；没合窗就什么都不做——错过的那一天由 `reports.catch-up`（每小时 :15）
补齐，它本来就带着同一道闸。周报/月报 runner 取的是「上一个完整周期」，天然没有这个问题，未动。

**3. `cached().clear()` 与在飞加载的竞态（MINOR）。** `clear()` 把 `pending` 置空后，旧加载的 `finally`
会把「新的 pending」也清掉，下一个读者再发起第三次加载；并发合并的契约被打破（值仍是新读的，只是
白读一次、时序更绕）。现在 `finally` 只在 `pending` 还是自己那个 promise 时才清。触达路径是
`seedTopics()` 之后的读（topic 缓存），以及所有用这个 helper 的索引/统计。

**4. 运行手册说 retention 会清 receipts，实际不会（MINOR，文档）。** `operations/retention.ts` 只清
job_runs（成功 30 天 / 失败 90 天）、过期的 delivery_leases、stored_files 与图片/OG 缓存；receipts 与
deliveries 从不清（保留窗口是站长未决事项，第 8 条工单）。`docs/geohot-runbook.md` 那两行改成分列
实情，免得运维以为回执表有界。

**评审查过、确认干净的（有证据）**：retention 与读者面（job_runs 读侧只看 24 小时/最后 80 行）；
notify 的跨进程去重（deliveries 唯一键 + ON CONFLICT）与阀门关闭记 skipped；ops.recover 的陈旧窗口
（10 分钟 vs 最长 240 秒调用）与 compare-and-set 释放；cron 的 singleton 策略（job_i2 挡跨实例并发）；
alerts 的重复/恢复窗口；backup 的 `pg_restore --list` 校验；`cached()` 不存在「毒化条目 / 未处理拒绝」
（拒绝的加载不写 value、pending 会清、stale 路径带 .catch）。

**验证**：typecheck 八份工程 0 错（修 #2 时先踩到自己的类型回归——runner 提前 return 使
`Promise<unknown> | undefined` 过不了 `Scheduled`，改 async 闭包即回绿）；`npm test` **328 / 323 通过 /
5 跳过 / 0 失败**。部署与三端同步见本轮收尾记录。













## 第四十六轮（2026-10-07 上午）：日报恢复的正式验收 + 编辑链路的对抗面

**1. 10-07 期日报如约成刊（工单结案）。** 北京 08:01 由第 45 轮的新 runner 生成（时间闸放行正确：
08:01 > 08:00）：`/api/v1/dailies` count=3，10-07 期导读用了「海水淡化日处理能力突破300万吨」，
版面 3 个分栏，`issue_no=3` 落章，索引链 1→2→3，空日期行依旧无号。从门槛重标定（第 40/41 轮）→
先行指标（第 42 轮）→ 实际成刊（本轮），恢复线程闭环。

**2. 编辑链路的对抗面：五条、修五条。**（第三个只读评审代理，按"提示词漂移 / 模型路由 / 语言路径 /
出处门 / 花钱 / 拒答记账"逐条打，复现均带证据。）

- **英文提要会被当中文稿发出去（红线，MAJOR）**：`finalizeCopy` 不管语言，读者门只查「标题含中文、
  提要非空」——模型答「中文标题 + 英文提要」时，英文提要给到列表 / v1 / RSS / MCP 全部出口。现在
  `titleZh`/`summaryZh` 在 `finalizeCopy` 统一过 `looksZh`：标题不过退回原文标题（原文中文才用），
  提要不过置空（`normalizeAnalysis` 判"等待"而非发布）；两处写作调用同时补 `usable:
  noChineseAnswer`——整条答复无汉字时收据落 failed，下一次重试才会"真花钱重问"，不会把回声缓存成
  好答复反复回放。新增 `tests/copy-language-gate.test.ts`（4/4）。
- **翻译链回声同样入库（MAJOR）**：`translateArticle` 的正文块与 X 帖路径不查语言，回声（英文回填）
  能被存成 `complete=true` 的"AI 翻译"，读取层当译文展示且永不再译。现在逐块过门：原文有词而答复
  无汉字按"没翻出来"处理（走既有的一次重问、再不行保留原文），X 路径直接 skip——与引用帖路径既有的
  `looksZh` 门一致。（整条链路因 `body_mode` 全 summary 而休眠，这是为开全文时准备的。）
- **「今天」进了付费提示词的哈希（花钱，MAJOR）**：`buildArticlePrompt` 把当天日期写进 prompt，而
  回执键哈希整段 prompt——同一 revision 次日重跑（重试阶梯 / 部署重排 / `enqueue-analysis.ts --all`）
  会白付一次 summarize。现在时间锚点只留原文发布日期（语义不变：那句"不要把相对时间换算成年份"
  本来就管着它），跨日重跑命中回执。模板改动使 promptVersion 一次性变化——一次性的重问成本，换来
  之后每天不再漏。
- **引用帖解析失败无限重问（花钱，MAJOR）**：这个循环每 5 分钟一轮 × 3 天窗口，一条系统性解不开的
  引用帖本会 ≈288 次/天付费重问。现在按 `(tweet, 文本哈希)` 在进程内记失败、至多问 3 次（文本一变
  哈希就变、重新计数；进程重启清零）——封的是"解不开"的成本，不是重试本身。
- **离格式答复被整形成读者可见文字（MINOR）**：`**title_zh**: X` 整行进过标题、`{"title_zh": …}`
  整段 JSON 成为标题（含中文，读者门拦不住）。现在标签容忍一层 Markdown 加粗、整段 JSON 按字段解析、
  解析不了的花括号答复剥壳后逐行；`LABEL_PREFIX`/`LABEL_ONLY_COPY` 同步容忍加粗。解析器测试 12/12。

**3. 复核过、不成立的**：`LLM_VISION` 的阀门说明与代码一致——生产不发首图是有意的默认（`vision`
是 env 阀，只有显式 `vision:false` 的预设才跳过）——评审说的"注释与行为相反"不成立。

**4. 一次环境性红与它的处理。** 修完后首轮全套跑出 1 处 `fetch failed: bad port`（events.test.ts 的
stub 端口），中途失败把 receipt 11546 留成 `unknown`，后续十条同链测试跟着红。单跑 events 10/10、
清掉那条 unknown 回执后全量重跑 **335 / 330 通过 / 5 跳过 / 0 失败**。判断：本机 stub 用
`listen(0)` 抽到一个 undici 拒绝的端口（bad-port 名单靠运气命中），不是本轮代码的缺陷；名单在
ephemeral 段里有哪些值未能定案，未引入「端口避让」式的改动（避免为一个未定案的猜测加复杂度）。
复现时的手顺：先单跑涉事文件、`DELETE FROM receipts WHERE id=…` 清掉 unknown 行、再跑全量。

**5. 验证（本轮收尾）**：typecheck 八份工程 0 错；web 构建 0 错；web 测试 41/41；后端 **335 / 330
通过 / 5 跳过 / 0 失败**（较上轮 +7：copy-language-gate 4 条 + 解析器 3 条）。部署与三端同步见提交记录。

---

## 第四十七轮（2026-10-07 上午）：日报归档为什么只有 02、03、07——账算到这里，别再重查

站长两次问同一件事（「为什么地理日报只有 2 号和 3 号」「中间的呢，给我补一下」），因为那三天在归档页上是
**静默缺席**的。生产库实测（`reports` kind=daily；日报 D 那一期盖 `[D-1 00:00, D 00:00)` UTC）：

| 期次 | sections | 引注 | 期号 | 该窗口释放给读者的入选条目 |
|---|---|---|---|---|
| 09-25 … 10-01 | 0 | 0 | 无 | —（那时还没接模型） |
| 10-02 | 3 | 21 | 1 | 51 |
| 10-03 | 1 | 1 | 2 | 1 |
| 10-04 | 0 | 0 | 无 | **0** |
| 10-05 | 0 | 0 | 无 | **0** |
| 10-06 | 0 | 0 | 无 | **0** |
| 10-07 | 3 | 11 | 3 | 19 |

**三条结论**：

1. **那三天不是"没生成"，是生成了白页。** `sections: []`、`issue_no` 为空，读取层 `readableRows` 把没有
   引注的期次挡在归档 / 前后翻页 / RSS / v1 / MCP 所有出口之外——与"空刊不占期号"是同一件事的两面。
2. **补不了是数据事实，不是工具缺失。** 三个窗口的"窗口内释放的入选条目"都是 0：那三天站点没有把任何一条
   入选条目释放给读者（`visible_after` 非空的行数只有 2 / 1 / 1 行，全部落在 10-06 15:15 与 15:18 UTC，
   即"重判门槛那一刻"）。按 `reports/compose.ts` 的归期规则（按读者能看到的时刻归期）它们属于 10-07 期，
   也确实印在 10-07 里（庄河暴雨 2 条进版面、加里曼丹在 8 条快讯里）。按新门槛 46 重数 timeline 落在
   窗口内的条目：10-04 期 2 条、10-05 期 0 条、10-06 期 1 条 ⇒ 要"补"只能回头印当时没人看过的稿，
   或让同一条新闻占两个期次。前者是站长已经定过的语义线（第四十/四十一轮），不动。
3. **一条真实的边角，留给站长定口径。** 极地中心 ICESat-2（score 51、一手发布、新闻日 10-04）任何一期都不会
   印：它的 timeline 日属于 10-05 期（窗口在它释放前就关了），它的释放日属于 10-07 期（被 `NOT p.backfill`
   挡住）。放开这条会让新接信源的首轮 sweep 把几年存量灌进当天版面——那正是它存在的理由；改成
   "backfill 且 timeline 也在同一窗口才放行"也救不了这一条（它的 timeline 不在 10-07 窗口）。
   不动它，只把事实记在这里。

**本轮改的两处（都是"让页面自己说实话"，零语义变更、零数据改写）**：① `/daily/archive` 在相邻两期之间
显式补「未出刊」行——`missingRuns` 把连续空档合成一段（写作「10月4日—6日 · 共 3 天」）、不跨月切段、
不标最新一期之后（可能还是今天的稿样）与最早一期之前（还没创刊），页顶给出这一格的含义与"空刊不占期号"；
② `neighbourLabel` 只有真是前一天才说「前一日」，跨天空刊的那一个改口「上一期」（同一族缺陷：标签承诺的
节奏，数据并没有）。6 条用例在 `apps/web/tests/daily-archive-gaps.test.ts`；报眼月历本来就用淡点表示未出刊
（`periodGrid` 的 `none` 态），这次是把只有鼠标悬停才看得见的那句话，写成纸面上人人都能读的一行。

---

## 第四十八轮（2026-10-08 上午）：9 条权威信源，以及根域名换成介绍站之后的邻居基线

**信源 104 → 113（启用 91 → 100）**：EUMETSAT、CAMS、Nature Water / Sustainability / Food 当期目录、PNAS 当期目录、
IFRC、CMS（UNEP 波恩）、中国科学院「科研进展」。全部先在采集机上实测（订阅口活着、条目数正常、最近一条 45 天内），
再跑一次真抓取确认能入库。探过又退回的如实记在 `docs/sources.md` 的「看过但没有加的」：哥白尼海洋服务停在 2025-07、
UNCCD 停在 2026-03，另有一批官方站要么 403 要么没有订阅口。**不退让的一条线**：403 就是 403，不伪造浏览器 UA 绕反爬。

**顺带补的三个采集层闸门**（`tests/industry-pack-sources.test.ts` 新增一条用例盯着）：PNAS 的 `dropMarkersTitleOnly`
（Correction for / Retraction / Reply to / In This Issue 只按标题判，`markerPattern` 的 `(^|[^a-z])…s?([^a-z]|$)`
让 "Retractions" 不再误伤 "Retraction for"）、IFRC 的 `denyUrlPrefixes: ["/node/"]`（同一篇文章两个网址）、
八条期刊目录源的 `intervalMinutesLocked`（`adaptIntervals` 把包里的 `interval_minutes` 只当上限，会把投稿周期
一个月的刊当成"可以五分钟抓一次"）。

**根域名换人之后**：`verify-deploy.sh` 第 1 节的"没动邻居"这条不变量，现在管的是**两个**邻居（根＝介绍站、
`/nc15/`＝纪念册），基线文件重记为三个哈希。同一轮修掉了基线自己的一个洞：原来 `curl -s | sha256sum` 不看状态码
也不看正文，站点正在 502 时写进去的是**空正文的哈希**（`e3b0c442…`）且脚本 exit 0——最需要重取基线的那一刻，
恰好是把不变量作废的那一刻。现在非 2xx、空正文、空哈希一律拒绝写盘；Cloudflare 的邮箱混淆载荷让介绍站首页
每次响应都不一样，比对前先归一化 `email-protection#<hex>`，否则"哈希变了"是埋点的锅不是我们的锅。

---

## 第四十九轮（2026-10-08 下午）：评审波——十条修、三条驳回、一条量完再放

**修的十条**（每条都有用例）：空刊那一期的 `readable` 判据（contracts 的 `ReportDetail.readable` + `loadReport` +
报眼 + 月历 + MCP 五处同一件事）、`nextIssueNo` 的先加锁再探迟到、日报大标题的署名与身份闸门、
混合中英文答复不再被当成中文稿（`noChineseAnswer` 现在两问都问）、240 秒思考调用的超时不再被 120 秒截断、
`llm.ts` 的请求身份带上 `jsonMode`、MCP 点名要空刊时直接回答"没有可读内容"、`periodGrid` 的期数只数读得开的期、
`sync-source-config.ts`（把包里声明的 config/tier/interval/默认分类推进库，默认 DRY-RUN，`--apply` 必须点名库且
库必须与进程 env 是同一个）、以及 `verify-deploy.sh` 的备份步骤不再被 `ogcache` 的并发写打断。

**驳回三条（都拿证据驳回，不是拿感觉）**：① "CAS 那期按重新列出的日期出刊"——条目页印的就是同一个日期；
② "`missingRuns().reverse()` 是死代码"——它被 `daily-archive-gaps.test.ts` 的一条契约用例钉着；
③ "撤下引注仍保留期号与图例矛盾"——图例说的只是空刊。**放一条**：/hot、/all、/item 的发布绑定缓存——实测只有
timeline 那一个端点发 `X-Accel-Expires`，残余陈旧只有 180 秒回看之外的约 120 秒，为它加一层缓存键要付的是
每次发布刷一片 URL。

**这一轮自己制造的一个缺陷，值得单独记**：把花费口径合成一个 `unbilledAttempt(alias)` 时，第一版写成
`sql\`(${p}status = 'failed' AND ${p}usage IS NULL)\``，`p` 是个字符串——postgres.js 把模板里的 `${}` 当**绑定参数**，
于是生成 `$1status`，三条语句全部语法错误。typecheck 过、构建过、`tsc -p tests` 也过，是新增那条用例第一次跑
就撞出来的（`PostgresError: trailing junk after parameter`）。⇒ **拼列名或表别名不能进 `sql` 模板**；现在返回
不带别名的字面片段，三个使用点里 `status` / `usage` 都只可能来自 `receipt_attempts`（`budgets` 没有这两列），
歧义不存在。用例还带"注入验红"：把 `count(a.id) FILTER (WHERE NOT …)` 改回 `count(a.id)`，
断言立刻红在「连不上的尝试不产生账单，不该报额度用完」这一句上。

---

## 第五十轮（2026-10-08 晚）：两个分类改用学科本名

站长指定：「地理与政治」→「政治地理」、「地理与历史」→「历史地理」。

- **改的只有 `industry/taxonomy.ts` 的 `CATEGORIES[].label`**。两个 key（`geopolitics` / `histgeo`）一个字没动 ⇒
  网址 `/all?category=…`、库里的 `category` 值、v1 与 MCP 的枚举、`/feed/category/<key>.xml` 全部照旧，
  **零迁移、零重判**：分类是逐条的判断结果，改名字不会让它重新判断一次。
- **跟着 label 走的四处**：`prompts/structure.md` 的类别 key 行（`tests/industry-vocabulary.test.ts:112` 逐字对拍
  label，改一处不改另一处就是红）、`prompts/rules-domain.md`、`docs/sources.md` 的「归到」列、两个 README 的分类表。
- **顺带改正两处注释事实**：`taxonomy.ts` 里"五个主题页拿政治地理当入口"——topics.json 根本没有 `opinion-analysis`
  这个主题，实测是**四个**（一个不存在的入口被当成了改词表的理由）；以及"类别名与主题标签同名"这件事写进注释，
  免得下一轮有人当笔误改掉。
- **一个可见后果，如实记着**：一条 geopolitics 的条目在卡片上会同时出现「政治地理」（类别，链
  `/all?category=geopolitics`）与「#政治地理」（主题标签，链 `/all?tag=…`）——两个入口、两种写法，不是重复渲染。

**站长自己那一轮的 README（宣传片那一节）没有动内容，只补了顶部导航那一行**：`tests/readme-anchors.test.ts`
要求每个二级标题都在导航里，新加的「🎬 宣传片展示」少了这一格，两条用例红。按那条用例自己的话
（"挪走或改名了就同步这一行"）补上 `[🎬 宣传片](#-宣传片展示)` / `[🎬 Product film](#-product-film)`，
10/10 复绿。**留给站长的一处呈现小毛病（没有替他改）**：README.md 里 `## 🎬 宣传片展示` 之前是
`---` + 空行 + `---`，两条连续的水平线在 GitHub 上会画成两道细线——删掉多余的那一对即可。

**Tier-2 已清账（同一晚做完，逐条带证据）**：
- **A4 单元检查不再免检**：`verify-deploy.sh` 第 2 节以前是"systemctl 在 **且** 有 geohot-\* 单元文件"才检查，
  于是四个常驻进程一个都没装的机器照样报 ALL CHECKS PASSED。现在只有"这台机器根本没有 systemd"才跳过，
  单元列表为空是**报红**。服务器上双向验过：真 systemctl → 4 个 OK；把 `list-unit-files` 换成返回空的假货 → 1 个 BAD。
- **A5 装完要数一遍**：`install-units.sh` 以前只把数量打给人看，写了三个也算成功；现在不等于 4 就 exit 1 并列出已有的。
- **A6 验收脚本不再共用一个 /tmp 文件**：`verify-github-sync.sh` 的 gh 错误输出从写死的 `/tmp/geohot-verify-gherr`
  改成 `mktemp`。并进已有的 `trap … EXIT` 而不是新写第二个——第二个会把清 `$WORK` 的那条盖掉，临时目录就漏了。
- **A3 回滚脚本两处真会伤人的**：① 强制备份那条是 `bash -c "sudo -u postgres pg_dump … | gzip > 文件"`，
  新起的 bash 没有 pipefail，pg_dump 失败时 gzip 照样退出 0 ⇒ **"先备份再删"可以带着一个空文件继续 DROP DATABASE**；
  而且那个重定向用的是发起命令的人的权限，`/opt/geohot` 归 geohot，非特权操作者在 `--apply` 时根本写不进去。
  现在整条在 sudo 里跑、带 `set -euo pipefail`、`test -s` 要求产物非空。② `run "…" sudo userdel "$APP_USER" 2>/dev/null || true`
  —— `run` 用 `"$@"` 执行，`2>/dev/null` 是**传给 userdel 的参数**（报多余操作数），`|| true` 又把这句连"用户其实
  没删掉"一起吞了。现在先 `id` 查在不在，报错就让它报错。`--purge-database` 的 DRY-RUN 在服务器上跑到 R5、exit 0。
- **B5 预览与采集走同一条流水线（但两个数不是一个意思）**：`previewSource` 以前直接数解析出来的候选，站长批准
  一条源时看到的数字比规则实际留下的那一个大。采集那条流水线（`allowed` → `rewriteUrl` → `noiseFiltered` → 可选
  按发布时间排序）抽成 `collect.ts` 的 `applySourceFilters`，两处共用；返回值多带 `offered`。
  **卡片写的是「本站规则留下 N 条（解析出 M 条，挡掉 K 条）」**——第一版我写成「会入库」，被复审当场否掉：真采集
  还要过首次导入上限（`_aihot.initialBackfillLimit`，缺省 30）、每轮 120 条的上限和按身份去重，预览一条都不过；
  包里 113 条源有 89 条自己写了首次导入上限（当场数：`node -e` 读 `industry/sources.json`，例如 `rss-gdacs-alerts` 12、
  `web-mwr-data` 8、`json-ceic-earthquake` 10），说「会入库」就是又造出一句不实陈述。`web_list` 那一族的 `offered` 也是解析
  **之后**的数（`fetchWebList` 自己已经丢过导航与重复链接），所以措辞用「解析出」而不是「列表给了」。
  用例：`tests/source-rules.test.ts` 把预览的 `count` 与真采集实际入库的行数对拍（那条夹具没有上限也没有历史行，
  两个数在那里确实相等）—— 把 `count: kept.length` 换回 `candidates.length` 它就红。
- **顺带补一条形状闸门**：`allowUrlPrefixes` / `denyUrlPrefixes` / `allowCategories` / `denyCategories` 与
  `ingestNoiseFilter` 那四个列表项在采集里是被当数组用的（`.map` / `.some`）。写成字符串时采集抛 TypeError、
  后台看到的是 500，而预览走同一条流水线之后连「试抓一次」也打不开。`assertSupportedConfig` 现在按形状先拒
  （create / edit / preview 三个入口共用它），错误里点名是哪一项；`null` 与缺省不算写错——读它们的地方一律 `?? []`。
**B8 量完驳回，不做**：评审建议"解析时把 RSS 里的 `http://` 链接升级成 https"。生产实测库里 `url LIKE 'http://%'`
有 **540 行 / 9 条源**（`web-mwr-data` 153、`cn-people-*` 200、EUMETSAT 只有 11），而 `www.mwr.gov.cn` 是
**只有 http 应答 200、https 握手超时**的那一个（`taxonomy.ts` 的 PUBLISHER_DOMAINS 注释里 2026-10-01 逐域 curl 记的）
⇒ 一刀切升级会把 153 条水利部的读者链接改死，还会让已入库条目的身份键（`identityKeyForUrl`）变掉、
同一篇稿被再采一遍。真要给 EUMETSAT 单独开一条 `itemUrlPrefixRewrite` 就够（那是既有配置项，不用新代码），
但那 11 条现在能打开，不值得为它动版面。
C6（translate / embeddings 的 `received` 收据无人认领）**判定不做**：两条链路都是休眠的，为不存在的路径加
回收器是凭空长代码。

---

## 第五十二—五十三轮（2026-10-09 中午）：复审自己上一轮的措辞，再把"翻不开"这条判据收成一条

**五十二轮修的是五十一轮自己造的话**：卡片上那句「会入库 N 条」被复审当场否掉（依据在上面 B5 那一条里），
改成「本站规则留下 N 条（解析出 M 条，挡掉 K 条）」，同时补了一条形状闸门。这一条的价值不在代码量，
在于**别让它继续替一个没人实现的承诺背书**。

**五十三轮是一轮只针对"同一条判据被抄了四份"的复审**，读的是空刊那条链（`readable` / `readableRows` /
`citedItemIds`）。三处成立、一处驳回、一处记为未覆盖：

1. **同一页两个答案（成立，已修）**：`ReportPaper` 的空版面条件数的是 `count`，而 `count` 来自 `pagesOf`，
   `pagesOf` 只看去重、**不看条目还在不在**。于是"引注已全部下架"的那一期：报眼（五十轮改的）写着
   「本期未出刊」，正文却照样印一版导语、「N 件大事」、按已下架标题算出来的「约 N 分钟读完」。
   现在整页用读取层那一个 `report.readable`：翻不开就没有正文，只有一句实话——
   有引注但全下架说「这一期当时选中的条目已全部下架」，本来就没有内容说「本期没有入选内容」。
   同一轮还gate掉了报头下面那条**指标带**（`metricItems(report.metrics)` + 「约 N 分钟读完」）：它写的是
   **成刊那一刻**的数，撤下条目不会回头改它，所以翻不开的那一期会顶着一句"5 件大事 · 约 4 分钟读完"。
   线上 10-04 那一期量过：`0 件大事 / 0 个来源`（它本来就是空刊），改动对它是不可见的；对"曾经有内容、
   后来全下架"那一期才是可见的。
2. **MCP 是第三个表达式（成立，已修）**：四十九轮我给日报加的那道拒绝写的是 `sections.every(items.length === 0)`，
   而 v1 的 `ok` 保留**没有 itemId** 的引注（`!i.itemId || available`），读取层的 `readable` 要求
   `itemId && available`。两者只在"有引注但没有 itemId"这种状态下分开——本站的写手（compose）不会产出那种引注，
   所以线上没有活案例，但"三个出口一个判据"这件事不该靠"没人会写坏"成立。现在 MCP 用
   `hasReadable(sections)`：v1 已经滤过下架，剩下的引注里有一条带本站页面才算有内容。
3. **报眼点格的提示（成立，已修）**：正在读的那一期若是空刊，格子状态是 `current`、提示却只写日期，
   与同一页报眼的「本期未出刊」对不上；从邻居那一期看同一天又写着「未出刊」。现在空刊的 current 格子
   也说「未出刊」，`state` 仍是 `current`（读者确实在看它）。用例在 `apps/web/tests/daily-archive-gaps.test.ts`。
4. **「空刊也可能有期号」（驳回，不是缺陷）**：`compose.ts` 盖章看的是这一版排出来的条目数（存在性），
   不是当下还能不能读。印的时候那些条目都是活的；之后被撤下，期号照旧留着——这是站长已经定过的口径
   （「撤下引注仍保留号」），改它等于让一份出过的报纸从序列里消失。
5. **两处判据仍没有用例（记下来，别当已覆盖）**：① MCP 的 `hasReadable` 与 v1 `filter(ok)` 的等价性只有注释和
   类型撑着，没有一条测试真的调过那个工具（`tests/publication.test.ts` 只覆盖周报月报的空白拒绝）；
   ② `ReportPaper` 这一族（正文、分版、快讯、指标带跟着 `readable` 收起）是**组件里的条件渲染**，而
   `apps/web/tests/` 全套都是纯函数与 loader 的测试，没有一处把组件 SSR 出来（仓库里没有
   `react-dom/server` 的用例）。补任何一条都要先决定：是给 web 测试加一条渲染路径，还是把这些条件
   下沉成可测的纯函数。下一轮做，别在文档里当已经测过。

---

## 第五十五轮（2026-10-09 下午）：删掉「考研」分类——删 key 比改名多碰一层

站长指定：「删掉 geohot 网站的考研板块相关的内容」。第五十轮那次只改 `label`，零迁移；这一次是**从身份表里删掉一个
key**，所以要一路跟到网址、库里的值、接口枚举、提示词与迁移。逐条记着实际动了什么、以及哪些是量过才写的。

1. **词表只有一处**：`industry/taxonomy.ts` 的 `CATEGORIES` 从 7 条变 6 条。筛选栏、卡片角标、日报分节、
   `/feed/category/<key>.xml`、v1 与 MCP 的枚举、后台信源表单的分类下拉全部从这张表推导——当场验过"没有第二份
   硬编码清单"：`grep -rn histgeo packages apps industry scripts` 在 taxonomy 之外**零命中**。
2. **旧 key 的行为**：`isCategoryKey` 不再认 `geoedu` ⇒ `toPublicApiCategory` 返回 null，`/all?category=geoedu`
   与任何未知键一样回落到不过滤的全部列表（`apps/web/app/routes/all.tsx:20` 那一个三元就是这件事），**不做重定向**
   ——与 2026-10-04 删板块那一层同一口径：为一个已经判定不要的功能留一张永久映射表不值。
3. **库里只有 1 行**：迁移 `0049` 把 `analyses` / `publications` 里的 `category='geoedu'` 置 NULL，**不猜一个新分类**。
   部署前在生产库量的：analyses 只有 1 行 geoedu（2026-10-07 判的，`selected=false`），publications 对应那 1 行
   `selected=false` 且 `visible_after` 为空 ⇒ 从未释放给读者；`editorial_overrides` / `selectbench_results` / `reports`
   三处 0 行。所以这一轮**没有 0041 那种"21 行按内容逐条改归"的活儿**；NULL 是既有合法状态（线上本来就有九千多行
   没有分类），而凭空写一个「人文地理」等于替读者给出一个没人判过的角标。
4. **信源一侧分两种处理**：`cn-chsi-kydt`（研招网 政策与规定）是 2026-10-03 专为这个板块接的，它自己的
   `requireTitleMarkers` 就是"专业目录/学科/学位/分数线/研究生招生"那一串——板块没了它就没有服务对象。
   **包里整条删除，库里停用而不删行**（删行会连带删掉已入库的稿，不可逆；`enabled=false` 随时能在后台翻回来）。
   `cn-web-moe-xwfb`（教育部·新闻发布）留着：它 49 条入库稿是 48 条 NULL + 1 条 human，一条都没被判成 geoedu，
   只是默认分类写着 geoedu ⇒ 清 `default_category`、不动 `enabled`。两条 UPDATE 都**按值清而不点名 id**，
   因为库里可以有需要包里没有的行（`docs/manual.md` 第 7 节记着这件事）。
5. **一处容易漏的通路**：信源的 `tags` 会被写进写作提示词（`editorial/writing.ts:92` 把它排成「【来源标签】…」那一行），
   所以教育部那条源身上留着 `"考研"` 这个标签，就是继续告诉模型这个板块还在。包里删掉，迁移里
   `array_remove(tags, '考研')` 按值摘掉。
6. **提示词**：`prefilter.md` 的招考豁免整段收回——PASS 清单里那一项、「不算 BLOCK」那句的三条件检验、以及末段
   "除非它自证是上面那条豁免里的招考事实"那一句；招生口径回到 ①「教育与文旅营销」那一类里，不再有独立放行理由。
   `rules-domain.md` 与 `structure.md` 的分类清单同步去掉 `geoedu`（`tests/industry-vocabulary.test.ts` 逐字对拍
   key 与 label，改一处不改另一处就是红）。
7. **三条测试跟着改，其中一条本来会假红**：`tests/exit-category-parity.test.ts` 原来钉的是「geotech 排在 geoedu
   之前」，key 删掉之后 `indexOf("geoedu")` 返回 **-1**，那条会**因为"删干净了"而失败**——这是删类别与改名的一个
   真实区别：相对次序断言在缺少一方时不是"没东西可钉"，而是钉出一个假红。现在钉两件事：词表六个、`geotech` 是末位键。
   `tests/report-default-section.test.ts` 的末键死值从 `geoedu` 改成 `geotech`——这正撞上 `taxonomy.ts` 头注警告的
   那件事：兜底分节由 `section` 的**首现顺序**决定，末位键只是两次都碰巧对上，不能当判据。其余按计数钉的
   （`channel-row`、`admin-source-category`）跟着从 7 改 6；`sources.test` 那行注释改成"机制与样本留着、板块已删"。
   顺带修掉一处**指针已经死了的措辞**：`channel-row` 那条失败信息原先指向 README 的「八个格子」，README 里从来没有
   这句话（`grep -rn 八个格子 README.md` 零命中），换成说清"格子来自这张词表、文档里的计数要跟着改"。
8. **文档与介绍页**：README 两版的分类表、徽章与锚点、`AGENTS.md`、`docs/customize.md`、`docs/deploy.md`、
   `docs/manual.md`（分类与分节那段、`taxonomy.ts` 那一行的 7→6、信源层那段给 `cn-chsi-kydt` 加了停用注记）、
   `docs/sources.md`（第八轮那张表的「归到」列加删除标记 + 那段"未接入候选"的说明改成当时的口径）。
   `docs/known-issues.md` 与 `industry/changelog.json` 里**历史那几段没有改字**——它们记的是当时发生的事；
   读者可见的只有 changelog 最前面新加的那一则「下线」。
9. **本地闸门（当场实跑）**：`npm run brain -- --lint` 0 条 problems、`--anchors` problems 为 `[]`、
   `npm run typecheck` exit 0、`npm test` 341 项（336 通过 / 0 失败 / 5 skip），web 构建 + `apps/web/tests` 48 项全绿；
   迁移在 `geohot_r15_ci` 上 `applied 0049_drop_geoedu_category.sql`。**注意本机这台集群这次只听了 IPv6 回环**
   （`listen_addresses='localhost'` 解析到 `::1`），`DATABASE_URL` 写 `127.0.0.1:5433` 会 ECONNREFUSED，
   写 `localhost:5433` 才连得上——不是代码问题，别照着它改配置。
10. **线上复验（2026-10-09 部署后当场量的）**：迁移在生产库 `applied 0049`，之后
    `analyses/publications` 里 `category='geoedu'` 各 **0 行**，`sources` 里 `default_category='geoedu'` **0 行**、
    带「考研」标签的 **0 行**，`cn-chsi-kydt` 那一行仍在且 `enabled=false`，`sources_total=117`（库里比包多的那些行照旧）、
    `sources_enabled=99`。出口一侧：首页与 `/all` 的筛选栏是 **全部 + 六个分类**（DOM 实测，`考研` 在两页文本里 0 命中、
    控制台 0 条消息），`/all?category=geoedu` 打开的是不过滤的「全部地理动态」（当日 304 条、没有任何 chip 被点亮、
    翻页链接把未知键原样带着走，第 2 条说的回落就是这个样子）；`/feed/category/geoedu.xml` **404** 而 `geotech.xml` 200；
    v1 `items?category=geoedu` 回 400 并列出六个合法键，`api/site/pool?category=geoedu` 同样 400（未知键一直是 400，
    不是本轮新加的行为）；MCP `tools/list` 七个工具、`category` 枚举六个 key，全文不含 `geoedu` 或「考研」；
    OpenAPI 全文不含这两个字符串；`/api/site/changelog` 的 `latestVersion` 已是 `2026-10-09T16:30`、首条是那条「下线」。
    整站点过的读者页与机器出口（首页、`/all` 两种、日报、归档、热点榜、主题、关于、更新日志、`llms.txt`、
    分类订阅、统计接口、收藏页）里，唯一还出现「考研」的是 `/changelog` 本身（它记的就是这次删除）。
    `verify-deploy.sh` **ALL CHECKS PASSED**，四个单元 active。
---

## 第五十六轮（2026-10-09 下午—晚上）：新增「前沿地理」+ 一次接 95 条学术信源，以及三条骗人的量具

站长两件事：**加「前沿地理」板块收学术界前沿成果**、**信息源"一定要全，越多越好"**，并允许同时派十五个子智能体。
落成的：分类 6→7（`frontier`，插在 `geotech` 之前）、信源包 **112 → 207**（+95，全部采集机实测）。

### 分类这一半（比改名多碰一层，比删 key 少碰一层）

- **加类别只有两种安全写法**（`industry/taxonomy.ts` 头注那条不变量）：复用已有分节，或插在同节类别旁边。
  `frontier` 两样都用上了——`section: "学科"`、位置在 `histgeo` 之后 `geotech` 之前，于是
  `SECTION_ORDER` 仍是「学科 → 技术」、兜底分节仍是「技术」、末位键仍是 `geotech`，
  `cache.test.ts` 与 `report-default-section.test.ts` 一条都不用改。**站长指定的那一格位置现在有用例钉着**
  （`tests/exit-category-parity.test.ts` 断言 `indexOf("frontier") === indexOf("geotech") - 1`）。
- 跟着词表走的四处：`prompts/structure.md` 的 key 行（`industry-vocabulary.test.ts` 逐字对拍 key 与 label）、
  `prompts/rules-domain.md` 的清单、`prompts/prefilter.md` 的 PASS 枚举（新增"学术前沿与研究进展"，
  并写明**预印本不必已发表，但材料要指出这是哪项研究**）、两个 README 的分类表与徽章锚点。
- 分类判据写成"看创新度不看地理要素"，并给了反例（讲全新世季风的古气候论文仍归历史地理）。
  `defaultCategory` 只给"整条源都是研究进展"的预印本线/学会精选/机构动态兜底成 `frontier`（31 条），
  期刊当期目录一律留 `null` 交给模型判（64 条）——**信源属性不该替编辑判断说话**。

### 信源这一半：256 条候选 → 95 条登记，判据是四条同时成立

15 路只读发现代理按互不重叠的切片交回 **256 条候选**（每路 8–20 条，带"直连/未直连"标记与淘汰理由），
一份汇总代理把它们并成 `D:/tmp/r56/candidates.tsv`。之后**全部在采集器所在那台服务器重跑**
（`GEOHOTBot` UA、不伪造浏览器 UA、不枚举 id、4xx 不重试）：HTTP 200、≥1 条 item、最新一条 ≤45 天、
**条目自带 ≥80 字摘要**。四条拦下来的：Elsevier 与 Taylor & Francis 的当期目录（只有卷期/作者/DOI，
**没摘要 = 英文条目永远过不了中文闸门 = 接进来就是一批发不出去的条目**）、MDPI 全站 403、IEEE Xplore 418、
EurekAlert 403、45 条停更（`psl.noaa.gov/news` 停在 2017、`oceanservice.noaa.gov/news` 停在 2015、
`climate.gov` 停在 2025-06）、以及三条同源重复形状（arXiv 合并 feed、GRSS 分类 feed、Newswise 的 feedburner 镜像）。

**平台侧实测事实**（下一轮别再重新试）：Wiley 期刊页 403 但 `/feed/<ISSN 去连字符>/most-recent` 通、
摘要在 `dc:description`、校验位 X 要小写、后缀只有 `most-recent`；Copernicus 十刊
`<刊>.copernicus.org/xml/rss2_0.xml` 全通、每轮 20 条；**EGUsphere 的 RSS 时间戳是请求时生成的**（两次实取秒数随
请求时刻跳），不能当水位用；arXiv 有 `<arxiv:announce_type>`（约三分之一是 replace/cross），
**不需要新过滤项**——重公告的 `<link>` 与首发同 URL，`identityKeyForUrl` 按地址判重天然吸收；
Springer `search.rss?facet-journal-id=` 有摘要有真 pubDate；Magtech 中文期刊的 RSS 端点要过人机验证、
`home.shtml` 列表是服务端渲染 ⇒ 只能走 `web_list`，与 Crossref 那 23 条 `json_list` 一起留下一批。

### 三条骗人的量具（本轮最值钱，都是我自己造的）

1. **`npm run brain -- --lint` 在临时 worktree 里会静默跳过身份守卫**：`tooling/brain-stub.ts:1271` 写的是
   `if (built && finalizeCopy && fixture.guard && …)`，而 worktree 没有 `node_modules`，`finalizeCopy` 解析不到
   ⇒ 整段检查不跑，报"0 problems"。我白天据此对站长说过"lint 0 条 problems"，**那是假绿**：主仓库实跑一直是 1 条。
   同一段代码还让"改词典前 / 改词典后"的对照两边都报 0。**教训：任何"绿"要先证明那段检查真的跑了**——
   本轮的证法是数 `report` 里带 problems 的条数，而不是看顶层有没有 `problems` 键。
2. **探测脚本的日期提取只认 ISO**：`raw.slice(0,4)` 对 RFC-822 的 `Fri, 09 Oct 2026 08:11:43 +0000` 取到的是
   `"Fri,"` ⇒ 判不出年份，**63 个"有条目、有日期"的 feed 被误判成停更**（stale 一度 92 条）。改成 `Date.parse`
   之后 stale 降到 45、可接入从 45 涨到 111。**教训：解析外部日期先看真实样本的格式，别按一种写法写死**。
3. **十五路代理在本机并发 curl 时，`tests/egress-and-feedback.test.ts` 两条会假红**（`TypeError: fetch failed`，
   那两条要起本地 HTTP 服务再 fetch）。单跑 3/3 绿、代理收工后全套重跑 337 通过 / 0 失败。
   **跑套件时别同时压本机网络。**

### 顺带修的一条既存缺陷（不是本轮造成的，但被本轮的量具照出来）

`IDENTITY_LEXICON.wmo` 的 pattern 只有 `/\bwmo\b|世界气象组织/i`，而 `ENTITIES.wmo.aliases` 与 `TAG_SYNONYMS`
都收了英文全称 "World Meteorological Organization"。身份守卫只读 pattern ⇒ **原文写英文全称时，
有依据的中文摘要会被整条丢掉**（Mongabay 那篇厄尔尼诺证据稿就是这么中的）。这一轮成批接英文学术源，
这种句式天天有，等于埋着的地雷。已补 pattern，并在 `tests/identity-guard.test.ts` 加了一条**注入验红**的用例：
去掉英文全称它就红，反例（原文没提这个机构、摘要却写了）仍然红。

### 第四条：这台采集器根本没有 IPv6 出口（本轮两条新源上线即死，已修在拨号层）

`rss-egu-highlight-articles` 与 `rss-egu-announcements` 上线五分钟后 `last_error=fetch failed`，
但在同一台机器上 `curl -A GEOHOTBot` 拿两条 feed 都是 200 + 真 RSS（16.8KB / 14.2KB）。分开测就露底了：
`curl -4` 200、`curl -6` "Couldn't connect"、Node 的 `fetch` 与 `curl` 默认行为一样超时、
直连 egu.eu 的 AAAA `2a01:4f8:c01e:4e5::1:443` 报 **ENETUNREACH**——**这台 VM 没有 IPv6 路由**。

`guardedLookup`（`packages/backend/src/lib/url.ts`）原本把解析列表的**第一个**地址交给 socket，
双栈主机就经常拨到 AAAA 上。修法是抽出 `preferIPv4()`：列表里同时有 v4/v6 时先拨 v4，
纯 IPv6 主机照旧（那种列表里只有 v6，排完还是它）。**SSRF 检查一点没松**——列表里每一个地址仍然先过
`isBlockedAddress`，改的只是先拨哪一个；用例在 `tests/url.test.ts`，含"纯 v6 不许被排空"与
"link-local v6 仍然被拦"两条反例。

**这条的适用面比 EGU 大得多**：第三十轮修过的那批"持续失败信源"里，凡是主机有 AAAA 记录又恰好 v6 不通的，
病根都可能是这个而不是对端反爬。下一轮巡检 `last_error=fetch failed` 的信源时，**先 `dig AAAA <host>`
再看要不要动配置**。

### 现状与遗留

- **A10 那一路（地球系统与可持续性机构）到收工时还没交**，它的候选不在 256 里；下一轮并进来。
  → **第五十七轮已交**：那一路交回 5 条候选，实测后接入 Mercator Ocean 与 WCRP 两条，其余三条（PIK /
  Stockholm Resilience / WRI）是 `web_list` 且要逐条核选择器，与中文期刊一起留在下一批。
- 待复核停用：包内 `rss-igu-online`（国际地理联合会）两次直连只拿到 "One moment, please…" 的 JS 挑战壳、
  **0 条 item**，按 `intl-unocha` 先例应当停用而不是空跑。
  → **第五十七轮复核：这条推断不成立，源是活的，不许停用。** 生产库里它自己的账是 13 次抓取 / `found` 20 /
  `new` 10 / 库里 10 条 / `health=ok` / 最近一轮 304；同一分钟采集机直连取到 42 KB 真 XML、10 条 item、
  最新 2026-10-06。**"某一次抓不到挑战壳之后的内容"不等于"这条源空跑"**，停用要看这条源的运行账（逐轮
  `found/new/arts`），那才是判据。
- 生产容量已量（决定"能接多少"）：接入前每天约 1000 条入库、1000–2400 条分析，预筛 7 天
  pass 5457 / unknown 3327 / block 1068。+95 条按 iv=240/720 与首轮回补 6–8 条估算，是"一天内多几百条"的量级，
  分析队列会短时滞后，但不改变能不能入选（入选看 46/49/52）。**上线后第一次巡检要看 `pgboss.job` 的积压与
  新源的 `last_error`**；如果 unknown 比例异常升高，先怀疑新源的形状而不是门槛。
- 验证账：`npm test` 342 项 / 337 通过 / 5 跳过 / **0 失败**（含 `industry-pack-sources` 与 `sources` 两条
  专门校验信源包的用例）；typecheck 0 错；seed 会把新源写进库（只增不改）。

## 第五十七轮（2026-10-09 晚）：上一轮"105 ok"那句话掩盖了八个空跑的源

第五十六轮收尾时报的健康度是「105 ok / 1 条 fetch failed」。这句话**方法上是错的**：它只看
`sources.health` 与 `last_error`，而这两列分不清「抓到了却一条都没存」和「这一周确实没新东西」。
这一轮把 95 条首次导入的 `fetch_runs.detail` 逐条拉出来，用 `found / filtered / dropped / stored` 四个数对读，
当场翻出两类静默缺陷（逐条数值与修法在 `docs/sources.md` 的第五十七轮一节）：

**其一：Wiley 把每本刊放在学会自己的子域上，入口白名单只写了主域名。** 六条刊的目录 feed 是
`found 92/13/9/5/5/2 → filtered 0 → stored 0`——`allowed()` 认为整份列表都是站外。
`rmets.`（英国皇家气象学会）、`rgs-ibg.`（皇家地理学会）、`wires.` 三个主机各归各的刊。
**教训：`allowUrlPrefixes` 要按"这个 feed 的 item `<link>` 到底是什么主机"来写，不能按出版方的品牌域名推**；
同一条规则也救了本轮新接的 Mercator Ocean（feed 在 `.fr`、条目链接全在 `.eu`）与 PIAH（链接是 `doi.org`，
所以 allow 写死 DOI 前缀而不是放开整个 doi.org）。**发现方式**：一次 `curl` 打印前 3 条 `<link>` 就够了，
成本远低于事后查为什么没有内容。

**其二：`<title>` 里放未转义 HTML 的订阅源，条目被当作"无标题"整批丢掉，而运行记录写着 `found: 0`。**
Byrd 极地中心与 ECMWF 各 10 条 item，Drupal 写成 `<title><a href="…">文字</a></title>`。这是合法 XML，
`fast-xml-parser` 交回结构而不是字符串，`rss.ts` 的 `text()` 只认 `#text`/`#cdata` 便返回空串，
`rss.ts` 里那句 `if (!link || !title) continue` 把十条全丢掉，而 `collect.ts` 里 `found = candidates.length` 的 `found` 记的是解析器的产出。
**这一类没有任何一列会变红**：HTTP 200、无 `last_error`、`health=ok`、`found=0`，与"这周没更新"逐字相同。
修法两处（各有用例，都是先看红再修绿）：`text()` 在没有文本节点时递归读子节点；解析器自己发现
「feed 里有 item 而一条都读不出来」时抛 `FetchError`，让这条源在后台真的标红。
**用采集机上当真取回的 `byrd.xml` / `ecmwf.xml` 两份字节复跑解析器：各 10 条、标题/日期/摘要齐**。
影响面是零：全库扫 `found_all = 0` 的启用源，只有这两条，且都是本轮新增的。

**第三条是判据，不是缺陷**：一条新源第一次抓取若「抓到了却一条都没留下」，现在直接记失败并写明
「列表发布的是 X 主机、配置允许的是 Y」——这正是上面那六条 Wiley 病根的自述文字。
它只在 `firstImport` 触发：成熟源偶尔只回一批更正页是正常的一周，不该被标红。
用例 `tests/collect-debut.test.ts` 把两侧都钉住了（debut 必须红、成熟源必须绿），
注入验证过：把闸门关掉，debut 那条当场变红。

### 产量账：上一轮的队列积压是一次性的首轮导入，不是稳态流量

第五十六轮上线后有 607 条待分析、分析速率 51–79 条/小时，当时按"信源太多"去打算降间隔——**那个判断是错的**。
从生产库逐源读首次导入那轮的 `stored` 之后：95 条里绝大多数首轮回补上限只有 8 条，期刊目录 feed 本身按周更新，
稳态新增接近 0；600 条里 **600 条来自首次导入那一轮**（`unanalyzed_last5h / unanalyzed_articles = 600 / 607`）。
也就是说那是一次性的债，会自己排干，降 `interval_minutes` 只会让每一轮抓到更少的新东西，不解决任何问题。
真正的天花板量出来是预算不是并发：`budgets` 里 `llm` 是 **8/分钟、420/小时、6000/天**，
而 08–18 点实测每小时 `receipts` 在 **236–358 之间**（峰值 358 ≈ 上限的 85%），
`failed` 每小时 1–11 条（免费档 429 由重试阶梯吸收）。**想让队列排干得快，唯一有意义的杠杆是提高
`llm.per_hour`（或降单条延迟），把 `ANALYZE_CONCURRENCY` 从 6 提到 12 只会在同一小时内撞那条 420。**
这一条属于站长的花费决定，本轮不动，只把数记在这里。

**第四条（接 PRIC 时挖出来的，与上面两条同源：都是"抓取规则把整页判空"）**
`listingItself()`（`web-list.ts:75`）原本只比 `host + pathname`，**把 query string 丢了**。
中国极地研究中心整站只有一个路径：`/index.php?c=category&id=89` 是栏目、`/index.php?c=show&id=3501` 是文章，
于是每条文章都"就是列表页自己"，被当作页面装饰丢掉 ⇒ `fetchWebList` 抛 `no items matched (html)`，
`web-pric-news` 连败 9 轮。这条**至少是响的**（health `failing` + 错误可读），不像前两条伪装成健康。
修法是把"本页"判据补上路由参数：列表页自带的每个 query 键值**都还在** ⇒ 同一页（含 `&page=2` 翻页）；
任何一个值变了 ⇒ 是另一页。用例 `tests/sources.test.ts`「a CMS that routes by query string keeps its articles」
三侧都钉：两条文章收进来、分页与「返回列表」仍丢掉、姊妹栏目 `?c=category&id=62` 留着（它是另一个列表页，
交给入口白名单管）。**适用面比 PRIC 大得多**：境内机构站大量使用 `?c=show&id=` / `?p=123` 这类查询串路由，
修之前它们**根本不可能**接成 `web_list` 信源；本轮把 `web-pric-news` 重指到站点自己导航里的
`科技进展`（`li.gsgg-item` / `.gsgg-title h3` / `.gsgg-time`，日期是服务端直出的 ISO，标题如
「极地中心在北极海冰干舷高度高分辨率反演方法研究中取得重要进展」）就是这一修的产物。

### 第五条（第五十八轮，收尾评审代理发现、生产数据证实、当天修掉）：`dc:description` 从来没被读过，于是整个 Wiley 家族喂给模型的是一行卷期号

第五十六、五十七两轮接了 **36 条 Wiley 系刊源**（AGU 与各学会刊），登记时逐条实测的是"`dc:description`
里有 1500–2600 字的摘要"。字节确实有——**但解析器不看那一列**：`rss.ts` 只读 `it.description` 与
`content:encoded`。Wiley 的目录 feed 把卷期行放在 `description`（"Antipode, Volume 58, Issue 6,
November 2026."＝44 字），摘要放在 `dc:description`。

生产库里对最近 20 小时的相关条目按 `excerpt`（=模型实际拿到的材料）做一次中位数统计，后果就摆出来了：

| 源的形状 | 中位 excerpt | 结果 |
| --- | --- | --- |
| Wiley 系目录 feed（terranova 22 / antipode 44 / ijc 48 / geobiology 55 / palaeontology 58 / wrr 60 / rgs-geographical-journal 61 / sedimentology 64 / rgs-wires 65 / grl 67 / rgs-tibg 88 / jawra 92 字） | **22–92 字** | pass 基本为 0 |
| 摘要就在 `description` 或 `content:encoded` 里的源（dhg 301 / epb 334 / phg 332 / eartharxiv 403 / wwa 499 / mercator 533 / piahs 713 / egusphere 729 / copernicus-hess 768） | **301–768 字** | 前沿条目基本全从这里出 |

修法：RSS 分支取 `description` 与 `dc:description` 中**较长**的那一个当摘要；用例
`tests/rss-xhtml.test.ts`「a table-of-contents feed that hides its abstract in dc:description…」，
注入验证过（把这一行退回原样，用例当场变红）。**已在库的条目会自动愈合**：`contentHash` 含 `excerpt`
（`content/materials.ts:100`），下一轮抓到同一 URL 就是 revision+1 ⇒ 重新分析。
**教训：实测"这族 feed 有没有摘要"必须顺着解析器真正读的那几列去量**，否则量到的是发布方的字段布局，
不是模型看到的材料。新接一族之后，先看一眼 `articles.excerpt` 的中位长度再宣布"接成了"。

### 同一轮评审另外改掉的两处（都是判据本身过宽/错位，不是风格问题）

- **首次导入闸门过宽**：原先 `found>0 && filtered==0` 就判失败，而 `filtered` 是在**噪声标记之后**才量的。
  包内 76 条源带着 `Issue Information` / `Correction` / `Book Review` 这类标记，一条新源若正好在"两期之间"
  首次导入（整页都是前置页），就会**每轮抛错、永远写不进 `initializedAt`**，从此永远空跑——比它要防的病更糟。
  现在只有**入口地址白名单把整页判掉**时才失败（`!offered.some(c => allowed(c.url, source))`），那才是 Wiley
  那一类配置病；纯前置页的一周照旧是成功的空轮。用例第三侧钉住（front-matter-only 的 debut 必须 ok 且写下
  `initializedAt`）。另注：这条闸门对已经初始化过的源不起作用，所以它救的是下一批，不是上一批。
- **`text()` 的回退面收回到"只用于标题"**：上一轮为救 Drupal 的 `<title><a href>`，把回退加在了通用 `text()`
  上——那会顺带把 `content:encoded` 的多段正文压成第一段（数组只取 `v[0]`）、图片消失，而 `feedText` 见到
  非空正文就标 `bodyStatus:"ok"`，于是**本该去抓详情页的那一步被跳过**。现在 `text()` 回到原样，新增
  `nestedText()` 只被 `titleText()` 用在 RSS/Atom 两个标题位；用例「markup inside content:encoded does not
  become a body that pretends to be complete」钉住这一侧。
- **三条 tier 与一条兜底分类修正**（评审指出，见 `industry/selection.ts`）：`rss-piahs-articles` T2→T1_5
  （T2 是"媒体与个人"档，与 `first_party:true` 矛盾，还把入选门槛从 49 抬到 52）、`rss-wcrp-climate-news`
  T2→T1、`rss-wwa-attribution` T1_5→T1，都按各自一族对齐；`rss-mercator-news` 的 `defaultCategory`
  从 `frontier` 改回空——它多数的条目是计划与服务公报，按 `industry/taxonomy.ts` 里 frontier 的 guide
  （判据是创新度、"观测公报…按各自类别归类"），兜底不该把它们判成前沿。**tier 是分数天花板，不是标签。**

### 现状与遗留

- 包 218 条（第五十六轮 207 → 撤 1 条 Phys.org 子集 → 接 12 条）。库里那一行 `rss-phys-org-earth-sciences`
  要停用：`set-source-state.ts` 只镜像包里还在的行（包外的 id 它直接 exit 2），所以用一条打印过前后值的
  `UPDATE enabled=false`。
- Springer 那六本（Bulletin of Volcanology 445、PalZ 12542、Mineralium Deposita 126、Climatic Change 10584、
  TAC 704、KN 42489）：发现代理 40 分钟前取到过真 XML，本轮两次探测都只拿到 `200 + 3036 字节 Client Challenge`。
  **限流是时段性的**，未取到字节就不登记，下一轮错峰重试（不换 UA、不试刊号）。
- A16 那一路（中文期刊 `web_list`）交回 7 条带选择器的候选，但只有 3 条把摘要路径实测通过
  （《地球信息科学学报》的详情页 `<meta name="description">` 就是完整中文摘要；空天院科研动态走
  `.trs_editor_view p`）。Magtech 模板的列表页 `div.j-abstract` **全为空**——不配 `detail` 就发不出稿，
  而 `detail` 要逐条核，本轮没接。下一批照 A16 那份表接。
- **`geohot_test` 这台库曾落后 6 份迁移**（0044–0049 未应用），`npm test` 当场报 26 条失败，
  全部是 `column "issue_no" does not exist` 一类。跑套件前先
  `DATABASE_URL=postgres://geohot:geohot@localhost:5433/geohot_test node scripts/migrate.ts`；
  看到成片 report/期号类用例齐红，先怀疑库没跟上，不要怀疑代码。
- 验证账：`npm test` **347 项 / 342 通过 / 5 跳过 / 0 失败**（本轮 +4 条用例：
  未转义标题、读不出来要红、debut 被自己过滤器清空要红、成熟源清空不红）。


## 第五十八轮（2026-10-09 深夜）：量具自己也要被量——两条判据在探测脚本里复发

本轮接入 53 条学术信源（218→271）。过程中最值钱的一条不是接入数量，而是**我自己的探测脚本把 12 条好源判成了死的**，
而那两条缺陷正是我在同一轮里刚在生产代码里修掉的：

1. **大小写。** 探测脚本读日期用 `/<pubDate>([\s\S]*?)<\/pubDate>/`，Frontiers 写的是小写 `<pubdate>`，
   于是 6 本 Frontiers 全部被算成"没有任何日期 → 最新 9999 天前"。生产侧 `rss.ts` 这轮已经改成
   `text(it.pubDate) || text(it.pubdate) || …`，**脚本没跟着改**。
2. **Atom 的 `<content>`。** 探测脚本量摘要长度只看 `description` / `dc:description` / `content:encoded` / `summary`，
   PLOS 的 Atom 把摘要放在裸 `<content>`，于是 4 本 PLOS 全部被算成"摘要中位 0 字"。
   生产侧 `rss.ts` 认 `<content>`，脚本不认。
   复核方式：把这两个字段补齐、日期大小写不敏感重测，12 本全部落回 **最新 1–2 天、摘要中位 1773–2089 字**，与最终登记一致。
   **教训：改判据时，量它的脚本要同时改；否则红的是量具，被误判的是源。** 本轮最后用一份
   `/tmp/r58-final.json`（53 条逐条测、按 feedUrl 键、文档表格由它生成）收口，不再用终端回滚里的数字写文档。

**另一条只在量具上出现的坑：`TypeError: fetch failed` 在这台机器上有两种相反的含义。**
域名不存在是它，目标有 AAAA 记录而本机没有 IPv6 出口也是它（见第五十六轮 D 的 `guardedLookup` 一节）。
`www.egu.eu/news/blogs/rss/` 在 Node `fetch` 下报 fetch failed、`curl -4` 下 200 + 10 条（摘要中位 5426 字、最新当天），
差一点就不接；反过来那 12 个猜出来的 Copernicus 子域名是**真 NXDOMAIN**（`dns.google` 查得出），
不是 IPv6 问题。**分流办法：DNS 与 IPv4 抓取分开跑，别用一个 fetch 的失败去断言两件事。**

**`allowed()` 是整串 URL 前缀匹配，这决定了 `allowUrlPrefixes` 的表达边界。**
`https://hal.` 收 hal.science、丢 shs.hal.science / amu.hal.science / ifp.hal.science（`rss-hal-geography` 实测四条主机），
而第五十七轮加的"首导全被过滤算故障"闸门**看不见这种半个匹配**——首导能存下几条就一切正常。
本轮的处理是删掉这条源的前缀清单（它已被自己的查询串 `q=geography` 限定），不是给匹配器加后缀能力。

**发现路线的三条死路与一条活路**（逐条在本机实测，下一轮不必重走）：
`copernicus.org/en/journals.html` 404 且首页导航 `void(0)` 无列表；DOAJ v4 journals 字段化查询一律 `total: 0`、
Cloudflare 对 `GeoHotBot` UA 403（无 UA 200）；Crossref `/journals` 命中 617 本地理刊、登记 RSS 链接的 0 本。
活路是 **Crossref `/prefixes/10.5194/works`**：DOI 形如 `10.5194/<刊>-<卷>-<页>-<年>`，
从注册数据里反推出 91 个真实活跃刊 slug（2026 年 6094 条、2025–26 合计 12977 条），再逐 slug 量 feed。

**刊名不是缩写。** 本轮 27 本 Copernicus 里有 5 本的 `name` 是我按 slug 猜的，feed 自报名与猜测不符：
`esd`=Earth System Dynamics（不是 Earth System Science Data，那是包内已有的 `essd`，撞名会把读者带错）、
`ar`=Aerosol Research（不是 Advances in Radio Science）、`sp`=State of the Planet、`eo`=Earth Observation、
`egqsj`=Quaternary Science Journal。判据现在写死在流程里：**登记 `name` 之前先读 `<channel><title>` 与 `<description>`**。

**采集侧数量与模型吞吐的矛盾本轮更清楚了**（第五十七轮记的是 420 次/小时上限、实测峰值 402 次）：
包内从 218 到 271、`rss` 到 226 条，**再往上加源不再等于读者看到更多东西，只会让每条等得更久**。
首导上限已经按 5 条钉住、间隔最快 240 分钟，所以本轮增量不会立刻打爆预算；
但下一次扩容前需要站长决定的是 `budgets.llm.per_hour`（现值 420）而不是信源清单。


### 上线首轮真采集当场照出来的四处（第五十八轮 C）

**其一：`allowUrlPrefixes` 写的是路径形状，路径形状必须从对端的链接里抄。**
Pensoft 三条我按"文章一般在 /articles/ 下"的语感写了复数，对端是 `/article/<id>/` 单数，
于是 `found: 100`、入库 0。首导闸门把它叫出来了；**同形制的部分匹配（例如只有一半链接前缀对）闸门叫不出来**，
所以 `docs/sources.md` 第五十八轮记了 HAL 的 `https://hal.` 半匹配案例——
写 allow-list 之前先打印这个 feed 的真实 `<link>`，不要凭平台的通用 URL 习惯。

**其二：`accept-language: zh-CN` 会让语种固定的 OJS 站把自己重定向到死。**
`guardedFetch` 对每个请求都发 `accept-language: zh-CN`（`packages/backend/src/lib/http-fetch.ts`），
`revistas.usp.br` 对任何非 `pt-BR` 的 Accept-Language 一律 302 回同一个 URL，撞满 5 跳报
`Too many redirects`——**表现完全像对端坏了，实际是我们的头触发的**。
判法：同一 URL 不带该头 / 带 `pt-BR` / 带 `en`/`es`/`zh-CN` 各跑一次，只有前者与 `pt-BR` 出 200。
修法用 `rss` 已有的每源 `config.headers`（`feedHeaders()`），不去改全局默认：
全局一改动 226 条 rss 的语种协商，那是更大的面。

**其三：`fetch failed` 一次不等于源坏。** EGU 博客 270ms 报 `fetch failed`、重试 1509ms 就 200 + 10 条。
第五十六轮 D 之后这台机器的 IPv6 坑已经由 `guardedLookup` 兜住，剩下的瞬时故障要靠重试与下一轮复看，
**不要凭一次失败就下"这源不行"的结论**（也不要在没有取到字节时登记）。

**其四：对端给的占位符不是我们的缺陷，但要看清它有没有连带影响。**
HAL 有 3/40 条 `<description>` 就是 `<![CDATA[[...]]]>`，于是 `excerpt` 存成 5 个字的 "[...]"；
库里 40 条 `body_status` 全 ok、正文最短 389 字，所以进模型的不是占位符。
判据是**问"正文列有没有拿到东西"**，而不是看到短摘要就动手改采集器。

## 第五十九轮（2026-10-09 深夜）：条目页「返回精选」404，与全站功能面核查

**站长实测报的那一单是真的，而它不是数据问题。** 首页 →「政治地理」→ 点开一条 →「返回精选」，落在
`/geohot/?category=geopolitics` 的 404 页上，地址栏正确、页面说"你访问的页面不存在"。
`/api/site/timeline?category=geopolitics` 实测 200 且 `cards=4`，`/?category=geopolitics` 直接刷新 200——
**只有客户端跳转这条路会死**。

根因是 `root.tsx:44` 早就写下来的那条：React Router 在 basename 部署下把 `to="/"` 解析成**裸的 `/geohot`**
（basename 之外没有尾斜杠），它自己的匹配器认不出这个串；root.tsx 的历史补丁只把**地址栏**改成
`/geohot/`，路由匹配已经按裸串算过了，于是渲染 404 路由。同一个行为此前已经出过三次事
（首页 tab、报告 tab、首页筛选 chip），每次都只在调用点补一次——**`backPlace()` 服务的那两处
（条目页与事件页的返回链接）是第四个，没人管**。它把来路 `/geohot/?category=…` 折成 `to="/?category=…"`，
正好就是那个解不开的串。

修法沿用 chip 的先例：`backPlace()` 多返回一个 `hard`（只有首页那一格为真），两处页面在 `hard` 时
交回浏览器真导航（`publicPath` 出去是 `/geohot/?…`，SSR 实测 200），其余路径仍走 `<Link>`。
判不出去处那条兜底（`selected ? "/" : "/all"`）同样带 `hard`：直接开条目页再点返回是同一个坑。

**同一晚的另一半在 nginx**：`location = /geohot { return 308 https://$host/geohot/; }` 把目标写死了，
于是 `/geohot?category=geopolitics`（手打、分享、任何没带尾斜杠的筛选链接）被规范化成**丢掉查询串**的
`/geohot/`。改成 `$is_args$args` 后实测 `location: …/geohot/?category=geopolitics`。
线上已改并 reload，备份 `sites-available/xxc2007.me.bak-geohot-args-20261009-225501`，`nginx -t` 通过。
**主站没被动过**：改前后 `https://xxc2007.me/` 都是 20817 字节；它的 sha256 每请求都不同，
因为 Cloudflare 的邮箱混淆串是每次重写、编码进 href 的——**这条路径的哈希不是可用基线**，
要比就得先归一化（`D:\个人展示网站\tools\normalize-cf.mjs` 那一份）。

**为什么用测试而不是点击来收尾**：这类缺陷只有点击才会露。新增
`tests/root-link-navigation.test.ts` 扫全仓 `<Link to="/">`，不带 `reloadDocument` 就红
（扫描要先剔掉整行注释，否则它会去举报解释这个坑的那句注释——本文件写的时候就这么误报过一次），
并断言 item/story 两处确实读了 `hard`；`tests/back-place.test.ts` 钉住判定本身
（首页为 hard、其余不 hard、站外来路不成链接、剥前缀的纯函数规则）。`back-place.ts` 此前一行测试没有，
所以这颗坑才会反复踩。为了让根测试套件能 import 这条链，`public-path.ts` 的 `import.meta.env`
改成本地类型读法（不为一个纯函数把 `vite/client` 塞进 tests 的 tsconfig）；
构建产物复核过：bundle 里 `/geohot/` 264 次、无残留 `import.meta.env`，前缀照旧烧得进去。

### 全站功能面核查的结果（生产公网，逐条实测）

- **读者端 16 个页面**（首页 + 七个分类筛选、`/all` 七个分类与翻页与相关度排序与搜索、`/hot`、`/topics`、
  `/daily`、`/daily/archive`、`/weekly`、`/monthly`、`/more`、`/about`、`/changelog`、`/feedback`、
  `/agent`、`/terms`、`/privacy`、`/starred`）全部 200，无一渲染成 404 块；
  未知分类 `/?category=nonexistent` 落回未筛选首页（这是 `Filters.tsx` 里写明的既有口径，不是新坑）。
- **链接图**：上述页面里 229 条站内链接逐条取回，只有两处误报——`/changelog` 命中"暂时无法加载"是
  更新日志正文在描述一次旧修复，`/api/mcp` 返回 405 是它只收 POST。再从 35 个条目页/事件页爬 93 条，
  **零问题**。
- **空态都是诚实的**：`/all?tag=<没用过的标签>` 说"这个筛选下暂时没有内容"；`/monthly` 说
  "第一期发布后会出现在这里"；`/starred`、`/topics` 各说各的来由。没有一处把"没有"写成"坏了"。
- **机器出口**：`/api/v1/items`、`/hot-topics`、`/dailies`、`/dailies/latest`、`/weeklies/latest`、
  `/selected/snapshot` 全 200；`/monthlies/latest` 404 与月报页口径一致（还没有第一期）；
  `/selected/changes` 409 是**契约要求**（"Missing or invalid v1 cursor; fetch snapshot first"）。
  openapi / 四个 RSS / sitemap / robots / manifest / og 图 / 图标全 200。
- **交互**：分类 chip、`/all` 翻页（1…50 下一页，翻到第 2 页条目确实换了）、`/` 聚焦搜索框、
  主题三档（深色/跟随系统/浅色）、条目页收藏开关（`aria-pressed` 翻 true 且写进
  `localStorage.aihot-starred-items`）都通；390px 宽下底部四格 tab 可见、**无横向溢出**、
  控制台**零 error / 零 warning**。
- **权限面**：`/admin/login` 正常渲染，未登录访问 `/api/admin/sources` 返回 401。
  后台内部页面没有站长凭据，本轮**没有**逐页登录验证——这一条留给站长自己点。
- **仍然在跑的账**：分析队列 `processing_state='new'` 2803 条（第五十八轮那批首导占了其中约一半），
  已分析 10195 条。frontier 板块 76 条已发布、其中 5 条已入选。**前沿板块是陆续出全的，不是一上线就满**，
  瓶颈仍是 `budgets.llm.per_hour=420` 那一条，站长拍板之前不宜再加信源。

## 第六十一轮（2026-10-10）：档案出刊链已经打通，但档案还排在队伍最后

上一段那句「瓶颈是 `budgets.llm.per_hour=420`」**已经过时**：`.com` 端点当日文字额度用尽后只剩每分钟 1 次，
池子现值 `MODEL_POOL=agnes-3.0-flash-cn`，熔断行 `agnes-cn` 9/540/12000（迁移 0054）。
2026-10-10 02:50 线上实测：最近一小时 85 篇分析、24 小时 1,089 篇，`content.analyze` 还压着 3,475 条 created。

**档案的真实形状**（同一时刻的数）：`backfill_reason='archive'` 1,002 篇，覆盖 2026-01-01 → 2026-05-30，
其中**判过的只有 1 篇**。原因不是档案管道坏了，是排序——档案条目按 `isHistorical` 落 priority -2，
队伍前面还有几千条实时条目。所以"日报周报月报同步出刊"这条链本轮用测试钉住了（`tests/archive-paper-rule.test.ts`：
同一条档案文章真的进了它自己那天的日报、那周的周报、那月的月报，补刊不占期号、已编号期次号码不动），
但线上要看到 1 月的报纸，得等队伍排到它——按实测 85–1,000 篇/天，是**天到周**的量级，不是分钟。
`scripts/backfill-papers.ts` 默认只出计划，正是为了让操作者先看清"哪几天有米、哪几天还差判断"。

**一次没有复现的测试红**（记下来，不当"已修"也不当"没有"）：同一库第四遍全量跑时
`event-regroup-failure`（两条）与 `receipts`（一条）红，红因是 `TypeError: fetch failed`——
每个测试文件自己起的临时 stub 连不上；紧随其后的 `Receipt 323 has an unknown outcome` 是它的下游后果。
把这 3 个文件单独连跑两遍 12/12 绿，整库再跑一遍 373 项 fail 0 绿。判据「空库连跑两遍 fail 0」本轮满足。
值得知道的机制：一套全量会起一百多个 ephemeral 端口的 stub，Windows 默认 240 秒 TIME_WAIT，
所以"某个文件的 stub 起不来"是可预期的抖动，不是被测性质的证据。下一次再红先看错误码是不是 transport 层。

## 第六十二轮（2026-10-10 凌晨）：两把门都做出来过又都撤了；真正的卡点是入选门槛

**先立口径**：下面每个数都标它自己的窗口。生产 `receipt_attempts` / `analyses` / `archive_ingest`，
最后一次复核是 2026-10-10 05:13（北京时间）。上一版这一节写"时刻是 04:00–05:00"，那个窗口罩不住 10-09 的数。

**站得住的四条观察**

1. `-1` 档不是慢，是零：02:00 前后 -1 档 1,790 条、45 分钟被服务 0 条，同一时段实时档 145→156；
   04:20 是 1,506 条、当天判定 3 条。05:13 再复核：近两小时 815 个 `content.analyze` 作业"completed"，
   其中真的落进 `analyses` 的只有 6 条。**"作业完成数"不是产出**——本轮第二次被这个数骗
   （第一次是第五十七轮那句"105 ok"）。要问产出只问 `analyses`。
2. 空转是真的，但对端不是拒绝：10-09 全天 quota 型拒绝 2,386 次 / 全部请求 6,938 次（34%），
   10-10 00:00–05:00 是 327 次 / 374 次。原话是 `You have used up today's text quota and are now limited to
   1 request every 1 minutes`（`code: rate_limit_exceeded`）——**降速**。同一晚 20:00–23:00 实测
   1,382 发 / **403 接受** / 965 拒，那 403 次是实打实的产出。
3. 按分钟分桶（01:40 之后，即 `per_minute=9` 生效期）：8 发/分的分钟 176 发 17 拒（9.7%），
   9 发/分的分钟 1,429 发 220 拒（15.4%），≤7 发/分只有 8 个分钟样本、0 拒。
   所以 9→8 的账是**少 0.4 次接受、少 0.6 次拒绝**，近似持平。上午那句"降速必亏"是算错的
   （把 `9×(1−15.4%)=7.6` 写成了 8.2，四个文档里都跟着错了一遍，已一起改）。
4. 一篇判定 ≈ 5–6 次成功请求（03:00 那小时 469 接受 / 73 篇）。`prefilter_article` 在 10-10 00:00–05:00
   是 911 张回执 / 1,577 次请求，只拦下 115 篇（12.6%）；同窗口昂贵步骤（score/structure/summarize/understand）
   1,196 张回执里 1,150 张（96%）花在没入选的条目上。**后一条不是浪费**，是"事件页要 pass 条目、
   精选只收 1.9%"的必然形状，下一轮别去"优化"它。

**做出来又撤掉的两把门**：细节与每条撤的理由在 `docs/geohot-runbook.md` 第 13 节。要点是——quota 关门
会把**还在答**的对端关掉，而线上是单成员门型池（`MODEL_POOL=agnes-3.0-flash-cn`），60 分钟又比所有队列的
重试预算长一个量级（`events.group` 是 retryLimit 4 / 20s + backoff），后果是条目被单独成页并留在只有
操作者脚本才清的 `regroup_pending`；份额门把档案抬进 `priority 0` 时带着旧的 `created_on`，
于是**插到所有实时条目前面**，而"实时积压就让开"的阈值取 `share×20`，买得越多越难触发。
代码回到 `77a6ca6`（五个文件逐字节一致），撤的提交是 `95ca304`。
**别再当新点子做一遍**：要做对得换成"按速率分配 + 让开条件看实时积压的绝对值"，而那是站长的额度决定。

**真正的卡点是入选门槛（本轮新发现，未动）**：判过的档案里只有 1 篇是真论文（另一个数是它的重复行），
得分 33；`industry/selection.ts:10` 记的全体分布是均值 22、p90 33、最大 61，门槛 46/49/52。
`scripts/backfill-papers.ts` 对 2026-01-01→10-09 的计划是 **325 期里 308 期"没有可刊条目"、17 期已出刊**。
也就是说判定就算无限快，按现门槛也出不出 1 月的报纸。但**样本只有 1 篇**——"论文都上不了门槛"不能当结论用，
要把 n 做大才谈得上调门槛。

**采集的真相（纠正上一版口径）**：runbook 里那句"每片实得 1.3–3.2 条，所以 Jan→今约 1,800 条"
是**我自己 `--per-month=8` 截的**，不是 Crossref 只给这么多——每条厚切片的 `seen` 恰好等于 8（脚本默认 60）。
当前 `archive_ingest`：329 片 done、506 片 pending、1 片 running，1—10 月每月约 87 片，1 月已在库（142 条），
两个进程正在跑 2–5 月与 6–10 月。加深采集随时能做，但多收一条就多一次要花钱的判定，
所以门槛与额度没定之前先不加深度。

**数据完整性（记着，没改）**：`analyses` 有 119 组 `(article_id, input_revision)` 重复行，
表上只有 `analyses_pkey` 和一个非唯一 `(article_id, id DESC)` 索引。读者侧安全：唯一的读路径
`publication/publish.ts:164` 取 `ORDER BY input_revision DESC, id DESC LIMIT 1`。
加唯一约束会打断"预算触顶→重排→同修订再判一次"这条路，所以先别动。
**本轮的教训**：我拿这张表算"每月判了几条"时用了 join 计数，重复行会双计——档案的 judged 数要以
`analyses` 的行数为准，不能用 join 出来的条数。

**没装上的那把 key**：站长在第六十轮给过 dots.ai 的 `dots3-note`，但服务器 `.env` 里只有
`LLM_API_KEY` / `AGNES_CN_API_KEY` / `OPENCODE_API_KEY` / `INGEST_TOKEN`，仓库里 `providers/llm.ts` 的
`MODELS` 也没有这个端点的注册项。多一把门就多一条产能，而且不动实时——**等 key 落进 `.env` 之后
按迁移 0050/0054 的方法在采集机上实测再接**，别照 OpenCode 那次"82 个模型只有 1 个能答"的教训靠猜。

## 第六十三轮（2026-10-10 清晨）：中文过刊这扇门开出来了；产能这一头量清楚是只有一扇门

**中文档案落地（本轮的主活，细节与实测在 docs/sources.md 与 docs/geohot-runbook.md §13）**：
`--source=web-dlyj-toc --from=2026-01 --to=2026-10 --apply` 在生产上写出 **149 条**（1—9 月各 15—18 条），
10 月那一期 18 条全部与实时采集同一批 URL，`dup=18` 一条没重入；账本按设计只把已经过完的月份判 done，
当月留 pending。抽正文那一步 149/149 `body_status=ok`（生产实测 149/149 条，字数 min 721 / 中位 801 / max 920），所以这一批不是"只有标题"的材料。

**补刊计划器此刻的真实形状（只读跑）**：330 期里 **312 期「没有可刊条目」**、18 期已出刊，另有 3 个整期因为
越界没排（W01、W41、2026-10）。也就是说交付里"1 月到今天天天有报"这句，缺的不是排期代码，是能进报的条目。

**判不动的原因量清楚了，是门不是队**：

| 观测 | 数 | 怎么来的 |
|---|---|---|
| 近 90 分钟生产回执 | **只有 `agnes-cn` 一扇门**：711 成功 / 80 打回 | 按分钟数 `receipt_attempts`（06:39–06:56）成功落在 6–9 之间＝熔断那一行的 9，门已经在自己天花板上 |
| 池子配了几个成员 | 1（`MODEL_POOL=agnes-3.0-flash-cn`） | 服务器 `.env`。分片机制在 `editorial/models.ts`，`usable()` 会剔掉不能答的成员；配一个成员＝六步全走同一扇门 |
| `.com` 那扇（`default`／服务 `llm` 8/420/6000） | 直连三次全拒 | 2026-10-10 **07:00 北京**实测：`You have used up today's text quota and are now limited to 1 request every 1 minutes`。把它加进池＝把一半工作交给一分钟只接一次的门，所以本轮**不加** |
| OpenCode 的 `space-bunny-free` | 短提示三次回了可解析 JSON（664–1,373ms） | 它的 `jsonMode:false` 是按真实编辑提示的形状量出来的，一条短提示词的成功不足以翻这个判据——记下，不动 |
| `dots3-note` | 仍然不在 `.env` | 本轮 grep 复核：只有 LLM_ / AGNES_CN_ / OPENCODE_ / INGEST_ 四把 |
| 队列 | band 0 实时 70｜band −1 档案 28｜band −2 迟到新闻 2,448 | `pgboss.job` `state='created'` 按 priority 分组。档案排在实时之后是设计如此（AGENTS.md「实时仍然第一」没有商量余地） |

**#110 的判据还没有第二次观测**：`analyses` 里 `archive` 一共 10 条，其中 relevance=pass 2 条——样本仍小到不能当结论。
本轮那 149 条中文稿子全都还在 band −1 的队尾（pg-boss 同级按 `created_on` 先旧后新，它们比那 2,066 条 Crossref
晚登记），所以"中文档案能不能过门槛"这件事要等它们排到才有数。**能改这个顺序的只有站长**（要么给档案单独一条
份额，要么把门槛按材料类型分开定），本轮不动排队，也不造第二把"门"——第六十二轮已经量过那样的门会把还在答
的对端关掉。

**读者侧四处「不声不响」（工单 #111）修了三处、驳了一处**：
1. 期点图上「未出刊」那一格只渲染 `<span aria-hidden />`：鼠标悬停靠画布容器的 `title` 还能看见，读屏与触屏
   什么都拿不到——4 月、5 月与月底的空白格在无障碍树里和 padding 长得一样。现在按 `state="none"` 单独立一支，
   `sr-only` 说出「10月1日 · 未出刊」。线上验过：/daily/2026-10-09 的 HTML 里 26 个这种 span。
2. 网址没有期次时三种情形共用 root 那句「内容已不再公开」，而它在说"本站发过又收回"。改成 loader 先分期号写法、
   再用 `dueAt` 分「没出过」与「还没到」，2026-02-30 这种算前者（它不是下一期，是永远不会来）。线上四种全验过：
   09-24 没有这一期 / 12-25 还没到 / 2026-02-30 没有这一期 / 2026-13 这个期号本站认不出来。
   **一次改坏又被线上抓回来**：第一版在 `.catch` 里判 `error instanceof Response`，而 `loadOr404` 抛的是 `data()`
   那个对象，分诊从来没跑过——只有我自己抛的那一支能带出 reason，所以 09-24 线上仍是「暂时读不到」。
   现在这一条自己抓 `apiGet`＋`ApiError`。
3. 翻不开的那一期（`report.readable=false`）没有 robots 标签，搜索引擎照收——报眼都写着「本期未出刊」了。
   修前线上验过 /daily/2026-09-25 确实一个 robots 都没有。
4. **驳回**：工单写「期头每天 08:00 与 feed 的每周一 10:00／每月 1 日 10:30 口径不一致」。对过
   `apps/worker/src/schedules.ts`：`0 8 * * *`、`0 10 * * 1`、`30 10 1 * *` 三条 cron 与三句话一一对得上，
   不同种类本来不同时间，不是漂移。工单第 2 条（归档少一整月）也不是解析缺陷：
   `missingRuns` 只在最早可读期与最新可读期之间找空，那是"创刊前没有报纸"这句话的边界；等 1—9 月一段一段填起来，
   最早可读期自己会往前移。
---

## 第六十四轮（2026-10-10 早）：这套量具自己的四个洞（工单 #112）

上一轮所有"产能／门槛"的数字都是从测试与探测脚本里量出来的，所以先把量具本身查一遍。四处都是真缺陷，
其中一条是我自己上一轮的口径说过头了，一并改口。

1. **四道闸门被绕过**。`tests/setup.ts` 里放着三样东西：`DATABASE_URL` 必须以 `_test`/`_ci` 收尾那道废库闸门、
   桩用的凭据、"什么都不推出去"的阀。`availability-chunking`、`queue-options-drift`、`queue-start-retry`、
   `search-capacity` 导入了 `@aihot/backend/db` 却没导入 setup——四个文件里有一个（`queue-options-drift`）
   是真的往队列发任务。修法不止是补四行：`import "./setup.ts";` 必须排在 db **之前**，因为 `db.ts` 在导入那一刻
   就读 `process.env.DATABASE_URL`，而 ESM 按源码顺序求值。规则从此不靠人记得住——
   新增 `tests/test-db-hygiene.test.ts` 扫全部测试文件，"碰 db 却没先碰 setup"直接红。摘掉 search-capacity
   那一行验过红，装回去验过绿。
   **顺带纠正我复核时的数法**：审计报告说"四个"，我第一次用 `from "./setup.ts"`（双引号）去 grep 得出"十一个"，
   多出来那七个是单引号写法，虚警。数法自己也要被数。
2. **等待中的队列任务永久堆积**。pg-boss 那张表不是我们的子表，删条目级联不到它。`geohot_test` 实测
   **9,940 条 `state='created'`，其中 9,800 条指向已经不存在的 article/story/source**（每跑一遍约 +700）。
   危害不是占磁盘：取活按 `priority DESC, created_on`，后来那一遍真起 worker 时先领到的是上一轮的垃圾——
   `analyze-shutdown.test.ts` 就是为躲这件事才自建队列名。修在 `purgeTagged` 末尾新增 `purgeOrphanJobs()`：
   只删主体已消失的，主体还在的一条不动（测"在飞／重试"的文件不受影响）。整套跑完再量：**0 条**。
3. **budgets 泄漏——工单标题说过头了，这里撤回**。`signals.test.ts` 与 `x-article.test.ts` 把
   `dashscope`/`deepseek`/`socialdata` 抬到 1000/10000/100000 之后不还，实测这三行就停在那儿，而迁移种的是
   100/2000/20000 与 10/100/1000。但工单标题那句"让预算熔断的断言永远不可能红"是我的推断：逐个查了全部八个
   会抬预算的文件（另外六个都存了再还），也查了会读它的断言（`alerts.test.ts:72` 先读现值再 `+1`、
   `receipts.test.ts:97` 用已计数反推上限），**没有任何一条判据的红绿被这个泄漏决定过**。真正的问题只有一条：
   一张共享的表被留在任何迁移都没产生过的状态上。修：两个文件按 `savedBudgets` 那一套存／还（与
   `collection.test.ts` 同形），并把这三行一次性改回迁移种值。
4. **两句永远不会红的断言**。`publication.test.ts:325` 用 `SELECT max(seq)` 比"没多出一条账本"——`max()`
   在零行时照样返回一行 null，夹具若根本没进账本，null 对 null 也是绿；现在先断言这一行存在（该夹具
   `selected=true`）再比。`fetch-schedule-jina.test.ts:65` 断"三种配置都排得上"取的是"还剩 0 条到期"，
   而"夹具压根没插进去"也是 0 条——补一条前置断言：三条都得先是到期态。
5. **四个文件收不干净自己的行**：`default-model`（`after` 里没有任何 purge）、`model-pool`（同上）、
   `materials`（`purgeTagged(SOURCE)` 碰不到 `OTHER`，两个 tag 来自两次独立的 `tag()`）、
   `report-candidates`（手删 articles 与 reports，唯独不删自己的 source）。

**验收**：`tsc -p tests` 0 错；整套连跑三遍 **389 项／384 通过／5 跳过／0 失败**（第三遍在预算改回迁移种值之后跑），
等待任务 9,940 → 0；两条新闸门各自先证红再证绿。改动全在 `tests/`，线上代码与生产数据一行未动。

---

## 第六十四轮（续）：补刊顺序从"文档里的约定"变成一处代码（工单 #113）

工单写"从旧到新只是文档里的约定，四个写入方会互相打脸"。逐个读过之后，四个里两个是真问题、两个是我记错了，
分开记：

1. **真的会打脸的是"补一个已经出刊区间中间的空天"**。日报的去重只看**更早**的期次
   （`recentlyCovered("daily", key)` 里是 `key < before AND key >= before-7`），所以无论是
   `backfill-papers` 补一个洞，还是 `recompose-report` 重排某一天，只要它后面那几期已经在架上，
   这一期就可能把那些期发过的同一件事再印一遍。方向本身不能反过来——让新报纸的内容否决旧报纸当天的选题，
   等于三月的报纸悄悄少一条三月的事，那是比"重印"更贵错。所以做**说清楚**而不是改语义：
   `editionsAhead("daily", key)`（与 `recentlyCovered` 共用新导出的 `DAILY_DEDUPE_DAYS`，两个数不再各写一遍），
   补刊脚本把"后面 N 期已出刊、跑完 --refresh 重排它们"打进计划末尾，`recompose-report` 在重排前把同样的话
   打给操作者。`--refresh` 整段重跑时不提示——那段本来就是按序全部重排。
2. **`catchUpReports` 没有打脸**：它按 `i = days-1 → 0` 走，即**从旧到新**，而且只补**没有**的期次。
   工单把它算进"四个写入方"是错的。
3. **周报月报与日报的去重关系不是缺陷**：`recentlyCovered` 只被 `composeDaily` 调用，周报月报是把这一段的
   条目重新组织成一份报纸，重复是它的本职。runbook §13 早就这么写，本轮把它落成一句可执行的话（上一条）。
4. **`visible_after IS NULL` 不是洞**：`items.ts:93-96` 明写"selected 行遇到 NULL 永不放开"，三值逻辑是刻意的；
   逐个查过写 `selected` 的路径（只有 `publishArticle`，它必然同批写 `visible_after`），也没有别的写入方
   能把这个状态造出来。查完不改，理由记在这里。
5. **月份算法收成一处**：`Date.UTC(y, m, 0).getUTCDate()` 这种"这个月有几天"的写法在 `backfill-archive.ts`
   里有两份内联拷贝，`sources/dates.ts` 里还有一份同式的私有函数。现在导出 `daysInMonth`，两处内联改调用。

**验收**：六份工程 typecheck 0 错；整套 390 项／385 通过／5 跳过／**0 失败**；新判据先证红
（把 `key <=` 改成 `key <`，那条边界断言立刻失败）再证绿；`backfill-papers` 干跑一次输出正常。

---

## 第六十六轮（2026-10-10 中午）：五路模型门、移动端量具、可迁移备份与一次 GitHub 发布

站长给的两把 key 与"移动端体验不太好"，逐条落成：

1. **五路模型门都实测过**（采集机上真发请求，不看文档）：
   - `dots3-note-prev`（小红书，512K 上下文）**可用**：`api-key` 头与 `Authorization: Bearer` **两种都收**，
     开思考一次 13–19 秒、1.1k–1.6k 隐藏 token，4 连发 4 个 200；文档默认 RPM 60 / TPM 150 万。
     登记为 `service=dots`，extra 带 `reasoning_effort`（让 240 秒超时与 6k 余量那支生效）。
   - **OpenRouter 那把 key 不能推理**：`GET /api/v1/key` 回 `is_management_key: true`，`/models` 能列 458 个
     模型（15 个 `:free`），但任何 `chat/completions` 都 `401 User not found`。**要另建一把普通（推理）key**；
     `openrouter-free` 通路已登记好、**先不进池子**——池子按 shard 分活，配一个只会 401 的门等于把 1/N 的
     工作扔进重试阶梯。key 一到位：设 `OPENROUTER_MODEL` 为实测可用的 `:free` 模型、加进 `MODEL_POOL` 即可。
   - `opencode`（4 连发 4 个 200，2–5 秒，只扛自由文本）与 Agnes 国际版（4 连发 4 个 200，5–12 秒）都在；
     **Agnes 国内版当天额度已用完**（429「今日文本额度已用完…每 1 分钟可请求 1 次」）。
   - 现值 `MODEL_POOL=agnes-3.0-flash-cn,default,dots3-note-prev,space-bunny-free`；逐 capability 读回：
     除 `summarize` 四路外，其余十步都是 `agnes-cn, default, dots` 三门，opencode 只出现在自由文本那一步。
   - 迁移 `0055` 给 dots / openrouter 各建一行熔断（20/600/6000 与 15/300/6000）。
2. **量具踩坑记一条**：`receipt_attempts.status` 成功写的是 `received`，而"完成"是 `receipts.status='completed'`。
   我第一次按 `attempts.status='completed'` 数，得到"90 分钟 767 次尝试全部失败"的假事故；按 service 数 receipts
   才是真的（dots 47 completed、llm 586 received、agnes-cn 1,392 failed）。**数表之前先确认两列的词表不是一套。**
3. **移动端**（`scripts/mobile-audit.ts`，headless Chrome + CDP，Node 自带 WebSocket、零新依赖）在 390×844 上
   逐页量：横向溢出 0、无错误页；改前最小命中区域是条目页「返回」「原文」与两个图标按钮 32px、热点榜展开
   按钮 28–32px、筛选片 32px、翻页片 36px、两条行内文字链 16px。`app.css` 新增 `@media (pointer: coarse)`：
   控件 `min-height: 44px`，行内文字链用 `padding-block` + 等量负 margin 撑命中区域（行高与版心不动），
   只作用于触摸设备。改后复量：图标按钮 32×44、文字链 16→38px；仍小于 40px 的只剩"整卡可点的标题链"
   （命中区域其实是整张卡）与 ≥24px 的方形按钮——**这两种不是缺陷，别再当新发现报一遍**。
4. **可迁移备份**（站长要求"随时迁移部署"）：`/opt/geohot/backups/geohot-<UTC>-full.tgz`（153 MB）＝
   整库 `pg_dump`（145 MB）＋ 与服务器同一棵 HEAD 的代码 tar ＋ `env-keys.txt`（**只有键名**）＋ 四个 systemd
   单元 ＋ nginx 片段 ＋ `README-restore.md`（八步恢复顺序与验收命令）。**当场做过恢复演练**：灌进临时库
   `geohot_restore_drill`，数出 sources 287 / articles 18,370 / publications 12,018 / reports 19 / budgets 13，
   然后删库。踩坑：服务器 `/opt/geohot/app` **没有 .git**，`git archive` 在那里必然失败——代码 tar 必须在本地
   生成再上传。
5. **GitHub 发布**（站长要求三端一致）：本地 HEAD 与 `origin/main` 已分叉（远端 12 个提交里有他自己的三个
   宣传片提交，`docs/promo/{geohot-promo.mp4,index.html,poster.jpg}` 是**只在远端存在**的路径）。用临时 index
   把这 3 个路径＋两份 README 从 `origin/main` 取回来，与本地 HEAD 合成一棵树（`e345ef5`），父节点指向远端
   HEAD，推成 `28d610d`——远端 main 现在逐字节等于该提交，他的宣传片与 README 都在。事后 `verify-github-sync.sh`
   仍报 4 项"不同"，那是**他工作区里未提交的第二次改动**（README×2 与未被本地 HEAD 跟踪的 promo），
   不是发布错误；发布状态以 `git diff origin/main 28d610d`（空）为准。
6. **档案侧同日结果**：七家中文期刊目录源共入库 **+868 条**（档案材料 2,076 → 2,944），
   **`published_at IS NULL` 的档案行现在是 0**（那 12 条被实时目录写成 undated 的地理学报条目已补上刊期）。
   `--per-month` 改成数"入库"之后，重跑能越过旧的 12 条墙：`web-geog-toc 2026-03` 从 0 条变 5 条，
   月度切片能正常收 `done`。

### 第六十六轮补记（同日中午）：OpenRouter 两把 key 都是"管理 key"，而管理 key 能签出推理 key

站长先后给了两把 OpenRouter key，`GET /api/v1/key` 两次都回 `is_management_key: true` / `is_provisioning_key: true`：
`/models` 能列 458 个模型（15 个 `:free`），但任何 `chat/completions` 都 `401 User not found`。
管理/开通 key 的用途正是**签发普通 key**——`POST /api/v1/keys`（`{name}`）当场回 201 并带一把推理 key，
它就能推理了。签出来的那把只写进两个 `.env`，签发用的临时文件已 shred；**没有任何 key 进仓库**。

实测（同一提示、JSON 模式、免费档）六个 `:free` 模型可答：`nemotron-3-ultra` 12 秒 / 296 token、
`nemotron-3-nano-omni-reasoning` 19 秒、`nemotron-3-super-120b` 45 秒、`dots-studio/dots-3-note-preview`
（与直连那条同模型，多一条并发放量）、`liquid/lfm-2.5-2.6b`、`cohere/north-mini-code`；`gemma-4` 两条当时
对端 429。六条各登记一条 `MODELS` 条目（池子按 shard 分活，得能单独点名），reasoning 那三条带
`reasoning_effort: high`。迁移 `0056` 把 `openrouter` 那行熔断改成 **18/300/600**：免费档额度按**账号**算，
成员多不等于额度多，刻意取小，撞到对端限制时交给 `sickServices()` 换人。

**生产验证（不只是登记）**：重启后逐 capability 读回，`score` 一档服务成员为
`agnes-cn, default, dots3-note-prev` + 六个 `or-*`；随后三分钟内的 receipts 里出现
`openrouter|nvidia/nemotron-3-super-120b-a12b:free|received×4` 与 `openrouter|liquid/lfm-2.5-2.6b:free|failed×1`
——**免费模型真的在替站点干活**（小模型失败是预期的，健康判据会把它换下去）。

另一条同日修好的缺陷（`de6be4e` `56ed1f7`）：池子此前不知道"某道门正在整体失败"。线上三小时里
1,051 次尝试全砸在额度用完的 Agnes 国内版上（另两道门只答 112 次），而成员是按条目 id 的哈希选的，
于是那不是"慢四分之一"，是**四分之一的工作直接死掉**。现在 `modelFor` 跳过"十分钟内 ≥6 次尝试且答出
不到一半"的服务（用速率而不是连败——被降到每分钟一次的门零星成功足以骗过连败判据），**绝不清空池子**：
全部不健康时仍用完整列表，停不停由熔断与重试阶梯决定；后台面板用同一份判断。
