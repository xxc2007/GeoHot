// 筛选行、搜索框与月历共用的界面词表：被首页与全部动态页的两个共享组件消费
// （features/feed/Filters.tsx 的 CategoryTabs / SearchField / SearchIconLink、
// features/calendar/DateCalendar.tsx，FeedItem 的类别角标也算同一格词表）。
// 字典形状与 shell.ts 一致：`en: typeof zh` 把两份键锁在同一集合上，词表里加了键而英文没给值会过不了构建。
// 类别的中文说法直接取 `@aihot/contracts/taxonomy` 的词表（筛选 chips、卡片角标、RSS 订阅同源）；
// 英文页的七个类别各有一个固定说法，key 与词表一一对应。
import { CATEGORY_LABELS, CHANNEL_LABELS } from "@aihot/contracts/taxonomy";
import { beijingWeekday } from "../format";

/** 中文月名：月历的月份行用（与旧实现 MONTH_CN 同一批词）。 */
const ZH_MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"] as const;
/** 英文页的月份名与星期名：月历的月份行、格点表头与格子读屏名共用。 */
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** 周一起头的表头缩写（与中文格点同一列序：一 二 三 四 五 六 日）。 */
const EN_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** ISO 星期一→周日与数组下标对齐：getUTCDay() 以周日为 0，换算一次。 */
const weekdayIndex = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

const zh = {
  /** 筛选行的读屏名与「全部」那一颗（它是行里唯一的中性 chip）。 */
  filterAria: "筛选",
  allChip: "全部",
  category: CATEGORY_LABELS,
  /** 首页 meta 标题里 `?channel=news` 这类旧链接的频道说法（chips 行早已不显示频道）。 */
  channel: CHANNEL_LABELS,

  /** 搜索框：读屏占位、输入框占位、清空按钮、提交按钮，以及手机首页那个纯图标入口。 */
  searchHint: "搜索标题、摘要与正文",
  searchPlaceholder: "搜索标题、摘要…",
  searchClear: "清空",
  searchSubmit: "搜索",
  searchIconAria: "搜索",

  /** 月历卡（DateCalendar）。 */
  calendarAria: "按日期浏览",
  /** 焦点日出报时的期号行；没出报时是「N 日」或「本月」——大字在下面，这里只是小字注脚。 */
  issue: (n: number) => `第 ${n} 期`,
  dayFoot: (d: number) => `${d} 日`,
  monthFoot: "本月",
  /** 焦点日右侧的「N 条」。 */
  focusDayCountPre: "当天 ",
  focusDayCountPost: (_n: number) => " 条",
  /** 月份行（年份按字符串传入，星期名已按语言算好，null 表示没有焦点日）。 */
  monthLine: (y: string, m: number, weekday: string | null) => `${y} 年 ${m} 月${weekday ? ` · ${weekday}` : ""}`,
  weekdayName: (date: string) => beijingWeekday(date),
  /** 上一月/下一月箭头与「回到本月」的读屏名与 title。 */
  prevMonth: "上一个月",
  nextMonth: "下一个月",
  thisMonth: "回到本月",
  /** 格点表头（周一起头的七列）与月名。 */
  weekdayHead: ["一", "二", "三", "四", "五", "六", "日"] as readonly string[],
  monthName: (m: number): string => ZH_MONTHS[m - 1],
  /** 月历右上角的当月合计。 */
  monthCountPre: "本月 ",
  monthCountPost: (_n: number) => " 条",
  /** 每一格的读屏名/title：日期、条数、期号与状态后缀按语言组句。 */
  cellDate: (m: number, d: number) => `${m} 月 ${d} 日`,
  cellCount: (n: number) => `${n} 条`,
  cellNoListable: "没有可列条目",
  cellNoContent: "没有内容",
  cellViewing: "（正在看这一天）",
  cellToday: "（今天）",

  /** 时间线的日期栏（DayHeader，首页/全部/主题/收藏共用）与列表尾（FeedEnd）。日期写法本身在
   *  lib/format.ts 的 monthDay/weekdayName，这里只出「今天」与展开/收起/条数这些界面词。 */
  todayWord: "今天",
  expandDay: (date: string) => `展开${date}`,
  collapseDay: (date: string) => `收起${date}`,
  /** 日期栏的条数：数字由页面用 `<span class="num">` 包好，词表只出后缀。 */
  dayCountPost: (_n: number) => " 条",
  timelineEmptyTitle: "这个筛选下还没有精选内容",
  timelineEmptyBody: "换个类别看看，或者去全部动态里找找。",
  feedLoading: "正在加载",
  feedRetry: "加载失败，点此重试",
  feedContinue: "继续加载",
  feedEnd: (n: number) => `已经到底了 · 共 ${n} 条`,
  /** 触底续读（InfiniteDayList / InfiniteTopicList）的加载与失败词。 */
  feedLoadingMore: "正在接着取…",
  feedChunkFailed: (reason: string) => `这一屏没取到（${reason}）`,
  feedTimeout: "这次取超时了，再滑一下试试",
  feedLoadFailed: "加载失败",
  feedRetryAction: "再试一次",
  feedListEnd: "已经到底了。",
  feedPageCap: "最多提供 50 页；更早的日子请用上面的日历挑一天，或者用搜索、主题页。",
  feedTopicPageCap: "最多提供 50 页；更早的内容请用主题页顶部的说明或搜索。",
  feedAutoMore: (pages: number) => `继续往下看更早的（还有 ${pages} 页）`,
  feedLoadMore: "加载更多",

  /** 没有发布时间的条目那一段（DayList）与数字分页（Pagination，全部/主题页共用）。 */
  undatedAria: "无发布日期",
  undatedTitle: "无发布日期",
  undatedBody: "来源没有给出发布时间，按本站找到它的先后排列",
  pageAria: "分页",
  pagePrev: "上一页",
  pageNext: "下一页",

  /** 卡片上「推荐理由：」这一格（FeedItem；理由本身是模型写的中文，不进词表）。 */
  reasonLabel: "推荐理由：",

  /** 卡片上的折叠块（ReadingGroup）：信源列表、进展列表、最新进展与它们的加载状态。 */
  group: {
    additionalSources: (n: number) => `另有 ${n} 家信源报道`,
    reportsCount: (n: number) => `${n} 篇报道`,
    openDevelopments: (n: number) => `展开 ${n} 条进展`,
    viewStory: "查看完整事件",
    latestDevelopment: "最新进展",
    openOriginalAria: "打开原文",
    loadFailed: "暂时无法加载，点此重试",
    loadMore: "加载更多",
    empty: "这里暂时没有更多内容。",
  },
};

const en: typeof zh = {
  filterAria: "Filters",
  allChip: "All",
  category: {
    physical: "Physical geography",
    human: "Human geography",
    regional: "Regional geography",
    geopolitics: "Political geography",
    histgeo: "Historical geography",
    frontier: "Frontier research",
    geotech: "GIS",
  },
  channel: {
    all: "All",
    news: "News",
    x: "X",
  },

  searchHint: "Search titles, summaries and full text",
  searchPlaceholder: "Search titles and summaries…",
  searchClear: "Clear",
  searchSubmit: "Search",
  searchIconAria: "Search",

  calendarAria: "Browse by date",
  issue: (n: number) => `Issue ${n}`,
  dayFoot: (d: number) => `${d}`,
  monthFoot: "This month",
  focusDayCountPre: "",
  focusDayCountPost: (n: number) => (n === 1 ? " item that day" : " items that day"),
  monthLine: (y: string, m: number, weekday: string | null) => `${EN_MONTHS[m - 1]} ${y}${weekday ? ` · ${weekday}` : ""}`,
  weekdayName: (date: string) => EN_WEEKDAYS[weekdayIndex(date)],
  prevMonth: "Previous month",
  nextMonth: "Next month",
  thisMonth: "Back to this month",
  weekdayHead: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as readonly string[],
  monthName: (m: number): string => EN_MONTHS[m - 1],
  monthCountPre: "",
  monthCountPost: (n: number) => (n === 1 ? " item this month" : " items this month"),
  cellDate: (m: number, d: number) => `${EN_MONTHS[m - 1]} ${d}`,
  cellCount: (n: number) => `${n} ${n === 1 ? "item" : "items"}`,
  cellNoListable: "no listable items",
  cellNoContent: "nothing published",
  cellViewing: " (viewing this day)",
  cellToday: " (today)",

  todayWord: "Today",
  expandDay: (date) => `Expand ${date}`,
  collapseDay: (date) => `Collapse ${date}`,
  dayCountPost: (n: number) => (n === 1 ? " item" : " items"),
  timelineEmptyTitle: "Nothing selected under these filters yet",
  timelineEmptyBody: "Try another category, or look in All updates.",
  feedLoading: "Loading",
  feedRetry: "Loading failed — tap to retry",
  feedContinue: "Continue loading",
  feedEnd: (n) => `End of the list · ${n} ${n === 1 ? "item" : "items"} in total`,
  feedLoadingMore: "Loading more…",
  feedChunkFailed: (reason) => `This screen failed to load (${reason})`,
  feedTimeout: "The request timed out — swipe again to retry",
  feedLoadFailed: "Loading failed",
  feedRetryAction: "Try again",
  feedListEnd: "End of the list.",
  feedPageCap: "At most 50 pages; for earlier days pick a date in the calendar, or use search or a topic page.",
  feedTopicPageCap: "At most 50 pages; for earlier items use the note at the top of the topic page or search.",
  feedAutoMore: (pages) => `Continue to earlier items (${pages} pages left)`,
  feedLoadMore: "Load more",

  undatedAria: "No publish date",
  undatedTitle: "No publish date",
  undatedBody: "The source gave no publish time; ordered by when this site found it",
  pageAria: "Pagination",
  pagePrev: "Previous",
  pageNext: "Next",

  reasonLabel: "Why we picked this: ",

  group: {
    additionalSources: (n) => `${n} more sources covering this`,
    reportsCount: (n) => `${n} reports`,
    openDevelopments: (n) => `Show ${n} updates`,
    viewStory: "Read the full story",
    latestDevelopment: "Latest update",
    openOriginalAria: "Open the original",
    loadFailed: "Could not load — tap to retry",
    loadMore: "Load more",
    empty: "Nothing more here yet.",
  },
};

export const copy = { zh, en } as const;
