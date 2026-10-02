# 已知问题与未完成项

这份清单是给读者和维护者的：这个仓库知道自己哪里还没做好。写在这里的每一条都在
`2026-10-02` 那天被验证过要么是真的问题、要么是尚未完成的工作，而不是猜测。

## 站点已部署，但有四件事还没跟上

`https://xxc2007.me/geohot/` 于 2026-10-01 上线（装法、验证命令、踩过的坑见
`deploy/geohot/DEPLOYMENT.md`），主站首页逐字节未变。以下四项是上线时就知道的缺口：

1. **日报已出刊（2026-10-02 更新）**：`/daily` 现在是「第 1 期 · 2026 年 10 月 2 日」，21 件大事、14 个来源、
   12 件一手发布。上线首日（10-01）确实是诚实的空态，原因见下面「上线首日没有日报」一节。
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
逐条状态记在 `docs/manual.md` 第 9 节。模型榜（`/leaderboard`）与 `/codex-reset` 已由
`industry/features.ts` 关闭，路由存在但接口不注册，实际 404。

## 本站的 sitemap 目前对搜索引擎不可发现

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
