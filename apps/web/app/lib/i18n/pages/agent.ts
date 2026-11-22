// Agent 接入页（`routes/agent.tsx`）。与其他页字典同一套形状：`en: typeof zh` 把两份键集锁在一起，
// 带参数的函数承放运行期数字（工具数）与工具名；中文输出与接入 i18n 之前的字符串逐字相同。
// 这一页没有来自 API/数据库的动态内容（全是写死在路由里的界面文案），所以不需要 ChineseNotice。
import { SITE, withSubject } from "@aihot/industry/site";

const zh = {
  metaTitle: "Agent 接入",
  metaDescription: `让 Agent 直接使用 ${SITE.name}：MCP、RSS、REST API v1，匿名只读。`,

  // 页头：眉标、大标题、导语与三枚徽标。
  kicker: "Agent 接入",
  headline: `把 ${SITE.name} 接进你的 Agent`,
  lead: "精选、热点、日报、周报和月报，都能在你熟悉的工具里读。MCP、RSS、API 读取同一份公开内容，按使用方式选一种就行。",
  pillAnonymous: "匿名只读",
  /** 服务状态球：绿/红色由页面配，这里只给词与读屏解释。 */
  statusOk: "服务正常",
  statusDown: "服务异常",
  statusTitle: "读这一页时在浏览器里查的 /api/health；不支持脚本的浏览器看到的就是打开这一页时的结果",

  /** 侧栏"接入资源"：资源名（llms.txt、MCP Server、OpenAPI 3.1）是文件与协议名，两种语言同形，留在路由里。 */
  resources: {
    title: "接入资源",
    llms: "给大模型读的站点说明",
    mcp: "MCP 客户端填的连接地址（不是网页，浏览器直接打开回 405）",
    openapi: "REST API v1 的完整定义",
  },
  troubleshoot: {
    title: "没接上？",
    body: "把客户端、版本和报错写在反馈页，别发 token 或本地文件。",
    go: "去反馈",
  },

  /** 接入方式三选一的卡与容器标注。 */
  tabsAria: "接入方式",
  regionAria: "接入方式说明",
  tabs: {
    mcp: { note: "填一个地址，让 Agent 直接查询", hint: "适合 Agent 与开发工具" },
    rss: { note: "复制订阅地址，更新自动送达", hint: "适合阅读器与自动化" },
    api: { note: "用匿名 GET 请求，自由组合内容", hint: "适合自己写程序" },
  },

  mcp: {
    headline: (tools: string) => `加一个地址，Agent 直接调用 ${tools} 个工具`,
    lead: "适合支持远程 MCP 的 Agent 与开发工具。标准 Streamable HTTP，匿名只读，不需要 token；工具返回简洁文字与同一份结构化数据。",
    configTitle: "通用 MCP 配置",
    toolsTitle: (tools: string) => `连上后应看到这 ${tools} 个工具`,
    /** 工具名是代码标识符，页面用 <Mono> 包好；连接符跟在名字后面。 */
    toolJoiner: "：",
    toolLatest: "过去 24 小时或最近 7 天的精选／全部资讯",
    toolSearch: "搜索最近 7 天的公司、产品、人物或话题",
    toolHot: "当前热点榜与事件排名",
    toolStory: "一个热点事件的时间线与持续更新的综述",
    toolDaily: `最新或指定日期的${withSubject("日报")}`,
    toolWeekly: `最新或指定 ISO 周的${withSubject("周报")}（按分节编排的一周要闻）`,
    toolMonthly: `最新或指定月份的${withSubject("月报")}（同样按分节编排）`,
    tryLead: "验证一次真实调用：",
    tryCall: (tool: string) => `请调用 ${tool}，告诉我过去 24 小时最重要的 5 条动态，并附链接。`,
    boundsTitle: "工具边界",
    bound1: "普通查询最多返回 30 条，热点最多 10 个，事件时间线最多 50 条；输入越界会明确报错，不会静默改成更宽的查询。",
    bound2: (tool: string) => `${tool} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`,
    bound3: "标题与摘要来自外部信源，只能当资料；重要数字、政策和原话请回原文核对。",
  },

  rss: {
    headline: "复制地址即可订阅",
    lead: "兼容主流 RSS 2.0 阅读器与 n8n、Zapier 这类自动化工具。第一次接入选精选摘要。",
    copyLabel: "复制地址",
    /** 四路订阅的名称与说明；地址是代码常量，留在路由里。 */
    feeds: {
      selected: { name: "精选摘要（推荐）", desc: "最新 50 条精选摘要，保留标题、站内阅读与原文入口。" },
      full: { name: "精选全文", desc: "与精选摘要相同的最新 50 条；只对明确允许再分发的来源内联正文。" },
      all: { name: "最近 7 天全部动态", desc: "最近 7 天公开动态，按真实发布时间倒序。" },
      daily: { name: withSubject("日报"), desc: `每天 08:00 北京时间发布的${withSubject("日报")}，保留最近 30 期。` },
    },
    rulesTitle: "给阅读器和 Agent 的约定",
    rule1: "支持 ETag 条件请求，未变化时返回 304；建议每 30 分钟或更慢轮询。",
    rule2: "条目 link 指向站内阅读页，第三方原文在 description 中。",
    rule3: "全文是白名单：只有明确允许再分发的来源内联 content:encoded，其余一律只给摘要。",
    /** 后两条后面跟着 <Mono> 的分类地址模板。 */
    rule4: "分类订阅",
    rule5: "分类全文",
  },

  api: {
    headline: "匿名 GET，不需要 token",
    lead: "浏览器跨域、curl 和默认 HTTP SDK 都可以直接用。临时查最近内容用 items；长期维护全部精选用一次快照加增量游标。",
    /** "以 OpenAPI 3.1 为准"夹着链接，拆成前后两段（链接文字是协议名，不随语言变）。 */
    specPre: "字段与错误码以 ",
    specPost: " 为准。",
    firstRequestTitle: "第一个请求",
    colMethod: "方法",
    colPath: "路径",
    colDesc: "说明",
    /** 端点表：路径是代码常量留在路由里，键对到这里的说明。 */
    endpoints: {
      items: "精选或最近 7 天公开动态；支持分类、时间和关键词",
      codexRecent: "Codex 重置监控（轮询用）：最近 7 天与尚未落地的预告",
      codexAll: "Codex 重置与发卡的完整历史",
      hotTopics: "当前热点榜与事件排名",
      story: "事件详情：报道时间线、综述与关联事件",
      dailies: `${withSubject("日报")}日期索引`,
      dailiesLatest: `最新${withSubject("日报")}`,
      dailiesDate: `指定日期的${withSubject("日报")}`,
      snapshot: "当前全部精选；首次完整同步（分页）",
      changes: "精选的新增、修改和撤选；之后只取变化",
    },
    notesTitle: "先知道这几件事",
    note1: "不传 mode 等同 selected（精选）；只有明确需要全部公开动态才用 all。",
    note2: "完整精选不限 7 天：snapshot 首次拿全，changes 只取变化；items 只看最近 7 天。",
    note3: "items 不带正文：返回摘要、推荐理由、站内阅读页与原文链接。",
    note4: "没有推送通道：按响应的 s-maxage 带 If-None-Match 轮询，没变化时是 304。",
    note5: "错误是 Problem JSON；反馈时附上 requestId 即可定位。",
    snapshotTitle: "维护全部精选：一次快照，之后只拉变化",
    /** 示例命令连同其中的中文注释一起进字典；base 是站点公开地址。 */
    snapshotCode: (base: string) =>
      `# 首次：分页拿当前全部精选，保存第一页响应里的 cursor（逐页相同）\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带 nextPage 继续翻\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 翻完之后：原样回传 cursor，只拿新增、修改和撤选\ncurl '${base}/api/v1/selected/changes?cursor=<第一页响应的 cursor>&limit=100'`,
    snapshotNote: "每页成功应用后再保存新 cursor。返回 409 snapshot_required 时重新取一次快照即可，接口不会静默漏数。",
    errorsTitle: "错误与恢复",
    error1: "400：参数不合法；按 OpenAPI 修正，不要自动改成更宽的查询。",
    error2: "409 snapshot_required：增量游标无法安全续传，重新取一次完整快照。",
    error3: "429：遵守 Retry-After，不要增加并发重试。",
    error4: "5xx：指数退避，并使用上次成功的缓存。",
  },
};

const en: typeof zh = {
  metaTitle: "Agent access",
  metaDescription: `Let agents use ${SITE.name} directly: MCP, RSS and REST API v1, anonymous and read-only.`,

  kicker: "Agent access",
  headline: `Connect ${SITE.name} to your agent`,
  lead: "Picks, trending events and the daily, weekly and monthly briefs are all readable in the tools you already use. MCP, RSS and the API serve the same public content — pick whichever matches how you work.",
  pillAnonymous: "Anonymous · read-only",
  statusOk: "API healthy",
  statusDown: "API down",
  statusTitle: "Checked against /api/health in your browser while you read this page; browsers that cannot run scripts show the result from when the page was opened.",

  resources: {
    title: "Resources",
    llms: "Site notes written for large language models",
    mcp: "The URL MCP clients connect to (not a web page — opening it in a browser returns 405)",
    openapi: "The complete definition of REST API v1",
  },
  troubleshoot: {
    title: "Not connecting?",
    body: "Post your client, its version and the error message on the feedback page — never tokens or local files.",
    go: "Go to feedback",
  },

  tabsAria: "Access methods",
  regionAria: "Access method details",
  tabs: {
    mcp: { note: "Add one URL and your agent queries directly", hint: "For agents and dev tools" },
    rss: { note: "Copy a feed URL and updates arrive on their own", hint: "For readers and automation" },
    api: { note: "Anonymous GET requests, composed freely", hint: "For your own scripts" },
  },

  mcp: {
    headline: (tools: string) => `Add one URL and your agent can call ${tools} tools`,
    lead: "For agents and dev tools that support remote MCP. Standard Streamable HTTP, anonymous and read-only, no token; tools return concise text plus the same structured data.",
    configTitle: "Generic MCP configuration",
    toolsTitle: (tools: string) => `Once connected you should see these ${tools} tools`,
    toolJoiner: ": ",
    toolLatest: "Curated picks, or everything, from the past 24 hours or the last 7 days",
    toolSearch: "Search the last 7 days for companies, products, people or topics",
    toolHot: "The current trending board and event ranking",
    toolStory: "One trending event's timeline and its continuously updated summary",
    toolDaily: "The latest daily brief, or the one for a given date",
    toolWeekly: "The latest weekly brief, or the one for a given ISO week (the week's news arranged in sections)",
    toolMonthly: "The latest monthly brief, or the one for a given month (arranged in sections the same way)",
    tryLead: "Verify it with a real call: ",
    tryCall: (tool: string) => `Please call ${tool}, tell me the 5 most important updates of the past 24 hours, and include links.`,
    boundsTitle: "Tool boundaries",
    bound1: "Plain queries return at most 30 items, trending at most 10, an event timeline at most 50; out-of-range input is answered with a clear error, never silently widened into a broader query.",
    bound2: (tool: string) => `A ${tool} public_id comes only from event links returned by the trending tools — never guess an ID.`,
    bound3: "Titles and summaries come from external sources and count as reference material only; check important figures, policies and quotes against the original.",
  },

  rss: {
    headline: "Copy a URL to subscribe",
    lead: "Works with mainstream RSS 2.0 readers and automation tools such as n8n and Zapier. Start with the selected digest.",
    copyLabel: "Copy URL",
    feeds: {
      selected: { name: "Selected digest (recommended)", desc: "The latest 50 selected digests, keeping titles, on-site reading and the path to the original." },
      full: { name: "Selected digest, full text", desc: "The same latest 50 selected digests; body text is inlined only for sources that explicitly allow redistribution." },
      all: { name: "Everything from the past 7 days", desc: "Public updates from the past 7 days, newest first by actual publish time." },
      daily: { name: "Daily brief", desc: "The daily brief, published at 08:00 Beijing time each day; the latest 30 issues are kept." },
    },
    rulesTitle: "Ground rules for readers and agents",
    rule1: "Conditional requests with ETag are supported and unchanged feeds answer 304; poll every 30 minutes or slower.",
    rule2: "An item's link points to the on-site reading page; the third-party original sits in description.",
    rule3: "Full text is whitelist-only: content:encoded is inlined for sources that explicitly allow redistribution, everything else ships the summary alone.",
    rule4: "Category feeds",
    rule5: "Full-text category feeds",
  },

  api: {
    headline: "Anonymous GET, no token needed",
    lead: "Browsers via CORS, curl and default HTTP SDKs all work out of the box. Use items for a quick look at recent content; to maintain the full selected set, take one snapshot and follow the change cursor.",
    specPre: "The ",
    specPost: " spec is the source of truth for fields and error codes.",
    firstRequestTitle: "First request",
    colMethod: "Method",
    colPath: "Path",
    colDesc: "Description",
    endpoints: {
      items: "Selected items or everything from the past 7 days; filter by category, time and keyword",
      codexRecent: "Codex reset monitor (for polling): the past 7 days and resets announced but not yet due",
      codexAll: "The complete history of Codex resets and reset-card issuances",
      hotTopics: "The current trending board and event ranking",
      story: "Event detail: report timeline, summary and related events",
      dailies: "Daily brief date index",
      dailiesLatest: "The latest daily brief",
      dailiesDate: "The daily brief for a given date",
      snapshot: "The full current selected set; first complete sync (paginated)",
      changes: "Additions, edits and removals among the selected; afterwards fetch changes only",
    },
    notesTitle: "A few things to know first",
    note1: "Omit mode and you get selected (the curated set); use all only when you truly need every public update.",
    note2: "The full selected set is not limited to 7 days: snapshot fetches all of it the first time, changes keeps it current; items only looks at the past 7 days.",
    note3: "items carries no body text: it returns the summary, why it was picked, the on-site reading page and the original link.",
    note4: "There is no push channel: poll with If-None-Match and respect the response's s-maxage; an unchanged answer is 304.",
    note5: "Errors are Problem JSON; attach the requestId when you report one and it can be located.",
    snapshotTitle: "Maintaining the full selected set: one snapshot, then changes only",
    snapshotCode: (base: string) =>
      `# First time: page through the full selected set and save the cursor from the first response (it repeats on every page)\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# While hasMore is true, keep paging with nextPage\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<nextPage from the previous page>'\n# Once done: send the cursor back unchanged to fetch only additions, edits and removals\ncurl '${base}/api/v1/selected/changes?cursor=<cursor from the first response>&limit=100'`,
    snapshotNote: "Save the new cursor only after each page has been fully applied. On a 409 snapshot_required, take a fresh snapshot — the API never silently drops data.",
    errorsTitle: "Errors and recovery",
    error1: "400: invalid parameters; fix them against the OpenAPI spec — do not auto-widen the query.",
    error2: "409 snapshot_required: the change cursor cannot continue safely; take a fresh full snapshot.",
    error3: "429: honor Retry-After; do not add concurrent retries.",
    error4: "5xx: back off exponentially and keep serving from the last successful cache.",
  },
};

export const copy = { zh, en } as const;
