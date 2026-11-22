// 日报/周报/月报的版面 chrome 词表：ReportNav（页签与往期栏）、ReportPaper（报头、导语眉标、页脚）
// 与 IssueDots（报眼点阵）共用，features/report/format.ts 的日期与分组函数也按 locale 从这里取词。
// 字典形状与 shell.ts 一致：`en: typeof zh` 把两份键锁在同一集合上。报纸的标题、导语、摘要与正节名
// 是模型写的中文（i18n.ts 的约定，ChineseNotice 说明），不进字典；这里只收网站自己印的版面文字。
// 中文输出与 i18n 之前逐字相同。
import { SITE, withSubject } from "@aihot/industry/site";
import type { ReportKind } from "@aihot/contracts/site";

/** 英文月名（缩写给 chip 与格子用，全称给报头与点阵标题用）与英文星期缩写。 */
export const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_EN_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const zh = {
  /** 三种报纸的名字：页签、页脚链接与兜底标题用素名；报头的 sr-only 名与总述兜底用带行业词的名字
   *  （地理日报）。英文两套与 report-detail.ts 字典的 kindLabel 同一批词（Weekly review/Monthly
   *  roundup 是报纸全称，Daily brief 是侧栏叫法）。 */
  kind: { daily: "日报", weekly: "周报", monthly: "月报" },
  kindSubject: { daily: withSubject("日报"), weekly: withSubject("周报"), monthly: withSubject("月报") },

  /** ReportNav：页签 aria、往期栏、页脚的合订本链接与取标题失败的重试行。 */
  switchAria: "切换日报、周报、月报",
  pastIssues: "往期",
  historyAria: (kind: ReportKind) => `${zh.kind[kind]}历史`,
  boundLink: "日报合订本",
  navRetryFailed: "往期标题暂时无法加载，点此重试",
  earlier: "更早",
  viewArchive: "查看完整日报归档",
  /** 某一期没有标题时的机械兜底（期号就是日期）。 */
  entryFallback: (kind: ReportKind, key: string) => `${zh.kind[kind]} ${key}`,

  /** 往期栏与手机 chip 的分组词（archiveGroups / chipLabel / archiveMark 组合用）。 */
  yearMonth: (y: string, m: number) => `${y} 年 ${m} 月`,
  year: (y: string) => `${y} 年`,
  weekShort: (n: number) => `第${n}周`,
  dayShort: (d: number) => `${d} 日`,
  monthShort: (m: number) => `${m} 月`,
  markFrom: (d: string) => `${d} 起`,

  /** 报头一行三段：日期行、报馆铭言、出刊时刻（或未出刊）。 */
  notOut: "本期未出刊",
  edition: { daily: "每天 08:00 出刊", weekly: "每周一出刊", monthly: "每月 1 日出刊" },
  motto: { daily: `${SITE.subject} · 每日要闻`, weekly: `${SITE.subject} · 每周综述`, monthly: `${SITE.subject} · 每月盘点` },
  /** 报眼：期号行与「约 N 分钟读完」。 */
  issueNo: (n: number) => `第 ${n} 期`,
  minutesRead: (n: number) => `约 ${n} 分钟读完`,

  /** 报头的日期块（dateMark / dateLine 组合用）。 */
  dailyTop: (y: string, m: number) => `${y} 年 ${m} 月`,
  weekTop: (y: string, w: number) => `${y} 年第 ${w} 周`,
  yearTop: (y: string) => `${y} 年`,
  monthBottom: (m: number) => `${m} 月`,

  /** 指标带的单位（metricItems 按 key 取词）。 */
  metricUnit: {
    totalEvents: "件大事",
    totalStories: "件大事",
    sourcesCount: "个来源",
    firstPartyEvents: "件一手发布",
    modelsReleased: "项技术与数据发布",
    selectedCount: "条精选",
    reportsCovered: "期日报",
  } as Record<string, string>,

  /** 故事块里网站自己写的几个词与句子；标题、摘要与Unavailable 后面的解释句式。 */
  firstHand: "一手",
  original: "原文",
  originalAria: (source: string, title: string) => `阅读${source}原文：${title}（新标签页）`,
  /** CitationTitle 的外链 aria（这一条不带来源名，与 Original 那条是有意的两种说法）。 */
  originalPlainAria: (title: string) => `阅读原文：${title}（新标签页）`,
  originalNotHttp: "原文地址不是 http(s) 地址，只作文字显示",
  unavailable: {
    sourceRestricted: " · 原报道暂不具备站内全文展示条件。",
    workflowPending: " · 正文、译文或配图尚在核验。",
    other: " · 该报道当前不可公开阅读。",
  },
  pictureAlt: (title: string) => `《${title}》的配图`,
  captionPre: "图 · ",

  /** 头版与版面页：眉标（Kicker）与读屏名。 */
  frontPageAria: "头版",
  kickerLead: (kind: ReportKind): string => (kind === "daily" ? "头条" : "本期导读"),
  /** 「看点」眉标：键是 periodWord 的四个取值（本期/今日/本周/本月）。 */
  highlightsKicker: { "本期": "本期看点", "今日": "今日看点", "本周": "本周看点", "本月": "本月看点" },
  pagesKicker: "本期版面",
  itemsCount: (n: number) => `${n} 件`,
  flashesKicker: "快讯",
  flashesCount: (n: number) => `${n} 条`,
  sectionBrief: "本版导读",

  /** 导语缺席时的那行实话（leadAbsentNote）。 */
  leadAbsent: {
    daily: "这一天的导语还没写出来：下面的事件按版面直排。",
    other: "这一期还没有总述：下面的条目按分节直排。",
  },
  /** 没有导语与导读时标题的机械兜底（headline）。 */
  headline: (kind: ReportKind, month: number, count: number) =>
    kind === "daily" ? `这一天的 ${count} 件${withSubject("大事")}`
      : kind === "weekly" ? `本周的 ${count} 件${withSubject("大事")}`
        : `${month} 月的 ${count} 件${withSubject("大事")}`,

  /** 前后期导航：读屏名与格子里的「上一期 · 9月25日」（neighbourLabel 组合用）。 */
  neighboursAria: (kind: ReportKind): string => (kind === "daily" ? "前后日报" : "前后各期"),
  neighbourPrev: "上一期",
  neighbourNext: "下一期",
  neighbourPrevDay: "前一日",
  neighbourNextDay: "后一日",
  titleFallback: (kind: ReportKind, key: string) => `${zh.kindSubject[kind]} · ${key}`,

  /** 往期一格（周报月报页脚上方）。 */
  historyKicker: (kind: ReportKind) => `往期${zh.kindSubject[kind]}`,
  historyFallback: (kind: ReportKind, key: string) => `${SITE.name} ${zh.kind[kind]} · ${key}`,

  /** 翻不开的一期与页脚。 */
  emptyWithdrawn: "这一期当时选中的条目已全部下架，现在没有可读的内容了。",
  emptyNoContent: "本期没有入选内容。",
  endMark: "（本期完）",
  endNotOut: "（本期未出刊）",
  colophon: (kind: ReportKind) => `${SITE.name} ${zh.kind[kind]}由编辑系统按编辑部写定的标准从公开来源筛选编排`,
  colophonReadable: "，每条均附原文",
  firstIssue: (kind: ReportKind) => `这是${zh.kind[kind]}的第一期`,

  /** 报眼点阵（periodGrid）：标题、合计、格点表头与格名。 */
  gridTitle: (m: number) => `${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"][m - 1]}月`,
  gridNote: (n: number) => `本月 ${n} 期`,
  gridNoteYear: (n: number, y: string) => `全年 ${n} 期`,
  gridHeads: ["一", "二", "三", "四", "五", "六", "日"] as readonly string[],
  gridCellDay: (m: number, d: number) => `${m}月${d}日`,
  gridCellWeek: (n: number, a: string, b: string) => `第 ${n} 周（${a}—${b}）`,
  gridCellMonth: (m: number) => `${m} 月`,
  cellNotOut: "未出刊",
};

const en: typeof zh = {
  kind: { daily: "Daily brief", weekly: "Weekly brief", monthly: "Monthly brief" },
  // 报纸全称（进 sr-only 名、兜底标题）：与 report-detail.ts 字典的 kindLabel 同一批词。
  kindSubject: { daily: "Daily brief", weekly: "Weekly review", monthly: "Monthly roundup" },

  switchAria: "Switch between the daily, weekly and monthly briefs",
  pastIssues: "Past issues",
  historyAria: (kind) => `${en.kind[kind]} archive`,
  boundLink: "Full archive",
  navRetryFailed: "Past-issue titles failed to load — tap to retry",
  earlier: "Earlier",
  viewArchive: "View the full daily archive",
  entryFallback: (kind, key) => `${en.kind[kind]} ${key}`,

  yearMonth: (y, m) => `${MONTHS_EN_FULL[m - 1]} ${y}`,
  year: (y) => `${y}`,
  weekShort: (n) => `week ${n}`,
  dayShort: (d) => `${d}`,
  monthShort: (m) => MONTHS_EN[m - 1]!,
  markFrom: (d) => `from ${d}`,

  notOut: "No edition",
  edition: { daily: "Published daily at 08:00", weekly: "Published on Mondays", monthly: "Published on the 1st of the month" },
  motto: { daily: "Geography · Daily highlights", weekly: "Geography · Weekly review", monthly: "Geography · Monthly roundup" },
  issueNo: (n) => `Issue ${n}`,
  minutesRead: (n) => `${n} min read`,

  dailyTop: (y, m) => `${MONTHS_EN_FULL[m - 1]} ${y}`,
  weekTop: (y, w) => `Week ${w}, ${y}`,
  yearTop: (y) => `${y}`,
  monthBottom: (m) => MONTHS_EN_FULL[m - 1]!,

  metricUnit: {
    totalEvents: "events",
    totalStories: "stories",
    sourcesCount: "sources",
    firstPartyEvents: "first-party releases",
    modelsReleased: "model & data releases",
    selectedCount: "selected",
    reportsCovered: "briefs",
  },

  firstHand: "First-party",
  original: "Original",
  originalAria: (source, title) => `Read the original at ${source}: ${title} (opens a new tab)`,
  originalPlainAria: (title) => `Read the original: ${title} (opens a new tab)`,
  originalNotHttp: "The original URL is not http(s) — shown as plain text",
  unavailable: {
    sourceRestricted: " · The original report is not available for full display on this site.",
    workflowPending: " · Body, translation or images are still being verified.",
    other: " · This report is not publicly readable right now.",
  },
  pictureAlt: (title) => `Image for “${title}”`,
  captionPre: "Image · ",

  frontPageAria: "Front page",
  kickerLead: (kind) => (kind === "daily" ? "Top story" : "In this issue"),
  highlightsKicker: { "本期": "In this issue", "今日": "Today's highlights", "本周": "This week's highlights", "本月": "This month's highlights" },
  pagesKicker: "This issue's pages",
  itemsCount: (n) => `${n} items`,
  flashesKicker: "Briefs",
  flashesCount: (n) => `${n} items`,
  sectionBrief: "Section brief",

  leadAbsent: {
    daily: "The day's lead paragraph is not written yet — the stories below run straight down the page.",
    other: "This issue has no overview yet — the items below run straight down, section by section.",
  },
  headline: (kind, month, count) =>
    kind === "daily" ? `The day's ${count} geography events`
      : kind === "weekly" ? `The week's ${count} geography events`
        : `${count} geography events in ${MONTHS_EN_FULL[month - 1]}`,

  neighboursAria: (kind) => (kind === "daily" ? "Previous and next daily briefs" : "Previous and next issues"),
  neighbourPrev: "Previous issue",
  neighbourNext: "Next issue",
  neighbourPrevDay: "Previous day",
  neighbourNextDay: "Next day",
  titleFallback: (kind, key) => `${en.kindSubject[kind]} · ${key}`,

  historyKicker: () => "Past issues",
  historyFallback: (kind, key) => `${SITE.name} ${en.kind[kind]} · ${key}`,

  emptyWithdrawn: "Every item selected for this issue has since been withdrawn — nothing in it is readable now.",
  emptyNoContent: "Nothing was selected for this issue.",
  endMark: "(End of this issue)",
  endNotOut: "(No edition)",
  colophon: (kind) => `The ${SITE.name} ${en.kind[kind]} is selected and arranged from public sources by an editing system that follows the standards written into it`,
  colophonReadable: ", each item with a link to its original",
  firstIssue: (kind) => `This is the first issue of the ${en.kind[kind]}`,

  gridTitle: (m) => MONTHS_EN_FULL[m - 1]!,
  gridNote: (n) => `${n} issues this month`,
  gridNoteYear: (n, y) => `${n} issues in ${y}`,
  gridHeads: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as readonly string[],
  gridCellDay: (m, d) => `${MONTHS_EN[m - 1]} ${d}`,
  gridCellWeek: (n, a, b) => `Week ${n} (${a}–${b})`,
  gridCellMonth: (m) => MONTHS_EN_FULL[m - 1]!,
  cellNotOut: "not published",
};

export const copy = { zh, en } as const;
