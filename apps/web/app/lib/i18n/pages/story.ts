// 事件详情页（routes/story.tsx）的界面文案字典。同其他页字典一个形状：en 的类型锁成 typeof zh，
// 两边键集合不会漂移；需要运行时数字或样式包裹的值做成函数或前后分段，页面把动态部分传进来，
// 字典只出文字（.ts 字典不写 JSX）。中文输出与 i18n 之前的字符串逐字相同。
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** 从 `YYYY-MM-DD` 里拆出月、日，给日期标题与相对时间的落日格式共用。 */
const monthDayParts = (day: string): [number, number] => {
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  return [m, d];
};

const zh = {
  // —— 页面元数据 ——
  /** 事件不存在时的标题；正文标题来自事件本身（动态内容），不进字典。 */
  notFoundTitle: "事件不存在",
  metaDesc: (sources: string, reports: string) => `${sources} 个报道来源 ${reports} 篇报道，完整时间线与最新进展。`,
  /** /en 回退中文事件时 meta 的英文兜底；中文页永不使用。 */
  metaNoEnglishTitle: "这条事件还没有英文版",
  metaNoEnglishDescription: "这条事件目前只有中文版，尚无英文标题与英文综述。",
  /** 面包屑结构化数据里指向热点榜的那一级。 */
  crumbHot: "热点榜",

  // —— 返回链接 ——
  /**
   * 「来路」的名字由共享的 lib/back-place.ts 折出来，那边是中文词；英文页在这里对译，
   * 键与 back-place.ts 的 PLACES 表一一对应，没收录的名字原样展示（中文对中文读者无害）。
   */
  backNames: {
    "精选": "精选",
    "全部动态": "全部动态",
    "热点榜": "热点榜",
    "收藏": "收藏",
    "主题": "主题",
    "主题页": "主题页",
    "事件页": "事件页",
    "日报": "日报",
    "周报": "周报",
    "月报": "月报",
    "榜单": "榜单",
    "关于": "关于",
    "更新日志": "更新日志",
    "更多": "更多",
  },
  /** 来路判不出时的兜底去处（热点榜）的名字。 */
  backFallback: "热点榜",

  breadcrumbAria: "位置",
  breadcrumbHere: "事件详情",
  kicker: "热点事件",

  /** 状态徽标的词，键来自数据；颜色在页面里配。 */
  status: {
    active: "持续更新",
    watching: "观察中",
    settled: "历史事件",
  },

  untranslatedNote: "这条事件还没有中文稿：上面的标题和下面的报道都按原文照录。",
  untranslatedLink: "看已写成中文的热点事件",

  /** 数字后面直接拼的单位（数字由页面用 `<b class="num">` 包好）。 */
  reportUnit: " 篇报道",
  sourceUnit: " 个报道来源",
  updatedAgo: (rel: string) => `${rel}更新`,

  navAria: "事件内容导航",
  tabOverview: "事件概览",
  tabReports: "报道时间线",
  tabHeat: "热度走势",

  overviewTitle: "先了解这件事",
  overviewLabels: {
    digest: "事件提要",
    facts: "事实说明",
    excerpt: "报道摘要",
  },
  digestNote: (rel: string) => `按报道时间整理 · ${rel}更新`,
  digestNotePlain: "按报道时间整理",
  excerptNote: (name: string) => `摘自 ${name}`,
  overviewEmpty: "还没有综述，先看下面的报道时间线。",
  latestLabel: "最新进展",

  devTitle: "事件进展",
  devCount: (n: string) => `${n} 个进展`,
  sortDesc: "最新在前",
  sortAsc: "最早在前",
  devSortAria: "事件进展排序",
  reportsSortAria: "报道时间线排序",
  reportsSub: "沿着报道，了解事件的不同侧面。",
  filterAria: "报道筛选",
  filterAll: "全部报道",
  filterOfficial: "官方一手",
  filterSelected: "精选报道",
  filterEmpty: "这个筛选下没有报道。",
  timelineCapped: (shown: string, total: string) => `显示最近 ${shown} 篇，共 ${total} 篇报道。`,
  /** 一天分组的标题行：`9月1日`。 */
  dayHeading: (day: string) => {
    const [m, d] = monthDayParts(day);
    return `${m}月${d}日`;
  },
  reportsCount: (n: string) => `${n} 篇报道`,
  /** 信源名接代表报道标题的连接符。 */
  sourceJoiner: "：",
  expandSummary: "展开摘要",
  collapseSummary: "收起摘要",

  heatTitle: "本事件热度走势",
  relatedTitle: "关联事件",
  relatedStoryline: "同一故事线",
  relatedOther: "相关事件",

  whyHotTitle: "为什么热",
  /** 两个参与数由页面用 `<b class="num">` 包好，前后中三段拼回一句话。 */
  whyHotPre: "过去 48 小时，已观察到 ",
  whyHotMid: " 个独立主体参与讨论或报道，最近 6 小时新增 ",
  whyHotPost: " 个。",
  whyHotIncomplete: "部分信源观测不完整，以上仅为已观察到的参与。",
  recentReportsUnit: " 篇近期报道",
  rankOnBoard: (n: string) => `热点榜第 ${n} 名`,
  countShort: (n: string) => `${n} 篇`,
  officialHint: "直接了解当事方的说法",
  officialFilterCta: "在时间线筛选全部官方报道",

  recordsTitle: "事件记录",
  firstReportLabel: "最早报道",
  latestUpdateLabel: "最近更新",
  recordsNote: "同一事件的报道集中在这里，新的进展会继续补充。",

  /** 英文页的一行说明（zh 页永不渲染，此值只是文档）：报道行（StoryReportView）与事件（StoryRef）都不带信源原题，维持中文现状。 */
  chineseNotice: "界面已英文化：事件标题、提要与下面的报道仍为中文。",

  // —— 相对时间的措辞（口径与 lib/format.ts 的 relativeTime 一致，页面按语言取词）——
  relJustNow: "刚刚",
  relMinutes: (n: string) => `${n} 分钟前`,
  relHours: (n: string) => `${n} 小时前`,
  relDays: (n: string) => `${n} 天前`,
  /** 超过 30 天落到具体日期：今年内 `9月1日`，跨年 `2025年9月1日`。 */
  relDate: (day: string, today: string) => {
    const [m, d] = monthDayParts(day);
    const base = `${m}月${d}日`;
    return day.slice(0, 4) === today.slice(0, 4) ? base : `${day.slice(0, 4)}年${base}`;
  },
};

const en: typeof zh = {
  notFoundTitle: "Event not found",
  metaDesc: (sources: string, reports: string) => `${sources} sources, ${reports} reports — the full timeline and the latest developments.`,
  metaNoEnglishTitle: "This event has no English edition yet",
  metaNoEnglishDescription: "This event is currently published in Chinese only; no English title or digest is available.",
  crumbHot: "Trending",

  backNames: {
    "精选": "Selected",
    "全部动态": "All updates",
    "热点榜": "Trending",
    "收藏": "Saved",
    "主题": "Topics",
    "主题页": "Topic page",
    "事件页": "Event page",
    "日报": "Daily brief",
    "周报": "Weekly brief",
    "月报": "Monthly brief",
    "榜单": "Leaderboard",
    "关于": "About",
    "更新日志": "Changelog",
    "更多": "More",
  },
  backFallback: "Trending",

  breadcrumbAria: "Breadcrumb",
  breadcrumbHere: "Event detail",
  kicker: "Trending event",

  status: {
    active: "Ongoing",
    watching: "Watching",
    settled: "Historical",
  },

  untranslatedNote: "This event has no English write-up yet: the title above and the reports below are shown in their original language.",
  untranslatedLink: "See trending events with Chinese coverage",

  reportUnit: " reports",
  sourceUnit: " sources",
  updatedAgo: (rel: string) => `Updated ${rel}`,

  navAria: "Story sections",
  tabOverview: "Overview",
  tabReports: "Report timeline",
  tabHeat: "Heat trend",

  overviewTitle: "The story so far",
  overviewLabels: {
    digest: "Digest",
    facts: "Fact summary",
    excerpt: "Report excerpt",
  },
  digestNote: (rel: string) => `Compiled from reports · updated ${rel}`,
  digestNotePlain: "Compiled from reports",
  excerptNote: (name: string) => `Quoted from ${name}`,
  overviewEmpty: "No summary yet — start with the report timeline below.",
  latestLabel: "Latest development",

  devTitle: "Developments",
  devCount: (n: string) => `${n} developments`,
  sortDesc: "Newest first",
  sortAsc: "Oldest first",
  devSortAria: "Sort developments",
  reportsSortAria: "Sort report timeline",
  reportsSub: "Follow the reporting to see every side of the event.",
  filterAria: "Filter reports",
  filterAll: "All reports",
  filterOfficial: "Official",
  filterSelected: "Curated",
  filterEmpty: "No reports under this filter.",
  timelineCapped: (shown: string, total: string) => `Showing the latest ${shown} of ${total} reports.`,
  dayHeading: (day: string) => {
    const [m, d] = monthDayParts(day);
    return `${MONTHS_EN[m - 1]!} ${d}`;
  },
  reportsCount: (n: string) => `${n} reports`,
  sourceJoiner: ": ",
  expandSummary: "Expand summary",
  collapseSummary: "Collapse summary",

  heatTitle: "Heat trend",
  relatedTitle: "Related events",
  relatedStoryline: "Same storyline",
  relatedOther: "Related",

  whyHotTitle: "Why it's hot",
  whyHotPre: "In the past 48 hours, ",
  whyHotMid: " independent accounts have been reporting or discussing this event, with ",
  whyHotPost: " more joining in the last 6 hours.",
  whyHotIncomplete: "Some sources are only partially observed; the counts above cover observed participation only.",
  recentReportsUnit: " recent reports",
  rankOnBoard: (n: string) => `No. ${n} on Trending`,
  countShort: (n: string) => `${n} reports`,
  officialHint: "Read the parties' own statements",
  officialFilterCta: "See all official reports in the timeline",

  recordsTitle: "Event record",
  firstReportLabel: "First report",
  latestUpdateLabel: "Last update",
  recordsNote: "Reports on this event are collected here; new developments will keep coming in.",

  chineseNotice: "This story has no English version yet and is shown in Chinese.",

  relJustNow: "just now",
  relMinutes: (n: string) => `${n} min ago`,
  relHours: (n: string) => `${n}h ago`,
  relDays: (n: string) => `${n}d ago`,
  relDate: (day: string, today: string) => {
    const [m, d] = monthDayParts(day);
    const base = `${MONTHS_EN[m - 1]!} ${d}`;
    return day.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${day.slice(0, 4)}`;
  },
};

export const copy = { zh, en } as const;
