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
5. **报眼「第 N 期」仍由「最新 400 期」索引的下标倒推**（`publication/reports.ts` 的 `INDEX_LIMIT`）。
   日报从 2026-10-02 起算，约 2027-11 之后会卡在 400 并逐日倒退。修法是让数据给出真实序号（新增
   `seq` 迁移，或 `listReports` 返回总数），前端读它——动 schema 与前端两处，留待下一轮。
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


