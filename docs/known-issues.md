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

## 第八轮（2026-10-03 傍晚）：四个板块上线之后仍然开着的东西

这一轮做的是"加考研 / 地理信息系统 / 地理与政治 / 地理与历史四个板块 + 信源扩容 + 信息密度"。下面这些是
**做完之后仍然开着**的，逐条带证据，免得下一轮重新发现或误以为已解决。

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
   ③ 板块页仍没有 MCP/RSS 出口与后台视图（第 3 条）；④ 上游 issue #86 的 14 天年龄截断仍然没有照抄
   （第 4 条的口径不变）。

