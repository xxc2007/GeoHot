// 全部动态页（`routes/all.tsx`，含同文件导出的搜索忙碌页 `SearchBusy`）。字典形状与其他页一致：
// `en: typeof zh` 把两份键锁在同一集合上；函数段承接运行时的数字、日期，拆前后段让页面用
// `<span class="num">` 包住数字、两种语言各自成句。中文输出与 i18n 之前的字符串逐字相同。
import { SITE, withSubject } from "@aihot/industry/site";

const zh = {
  /** 标签页与 <h1>：搜索/标签筛选拼自己的标题，其余落到默认标题。 */
  title: `全部${withSubject("动态")}`,
  searchTitle: (q: string) => `搜索"${q}"`,
  tagTitle: (tag: string) => `#${tag}`,
  metaDescription: `${SITE.name} 收录的全部${withSubject("动态")}，可按类别与标签筛选，支持中英文搜索。`,

  /** 手机标题右侧的当日计数（数字由页面用 `<span class="num">` 包好）。 */
  todayPre: "今日 ",
  todayPost: " 条",

  /** 搜索结果行的排序开关与计数行（两个数字都由页面用 `<span class="num">` 包好）。 */
  searchSortLabel: "搜索排序",
  sortTime: "最新（标题与摘要）",
  sortRelevance: "全文相关",
  foundPre: "找到 ",
  foundMid: " 条 · 更新于 ",

  /** 日期筛选那一行（日期由页面按语言格式化后传入；"·" 后面接"看全部日期"链接）。 */
  viewingDayPre: "正在只看 ",
  viewingDayPost: " 那一天 ·",
  viewAllDates: "看全部日期",
  /** 拆好的年月日的界面写法，中文不带前导零。 */
  dayLabel: (y: string, m: string, d: string) => `${y} 年 ${m} 月 ${d} 日`,

  /** 列表区给读屏的隐藏小节标题（卡片是 <h3>，上面缺一级标题）。 */
  listHeadingSearch: "搜索结果",
  listHeadingAll: "全部动态",

  emptyTitle: "没有找到相关内容",
  emptyTryRelevance: "试试“全文相关”，连正文一起搜",
  emptySearch: "换个说法，或者去掉筛选再试。",
  emptyDay: "这一屏的筛选下，那一天没有可列出的条目——换个日子，或者去掉筛选再看看。",
  emptyDefault: "这个筛选下暂时没有内容。",

  /** <noscript> 里的分页上限说明：搜索页不画日历，有无日历各说一句。 */
  pageCapWithCalendar: "最多提供 50 页；更早的日子请用上面这张日历挑一天，或者用搜索、主题页。",
  pageCapWithoutCalendar: "最多提供 50 页；更早的内容请去掉搜索词后用日期入口挑一天，或者用主题页。",

  /** 同文件导出的搜索忙碌页。 */
  busyTitle: "搜索有点忙",
  busyBody: "现在搜索的人比较多，请稍等几秒再试。列表浏览不受影响。",
  busyBrowseAll: "浏览全部动态",
  busyBackSelected: "回到精选",

  /**
   * 英文页的一行说明（zh 页永不渲染，此值只是文档）：行卡片（FeedItem）在英文页优先信源原题，
   * 没有原题的条目回退到中文标题——而中文信源没有原题时标题本就是信源原话，所以两种回退下
   * 「标题按信源原语种显示」都成立；AI 摘要仍是模型写的中文。
   */
  chineseNotice: "界面已英文化：条目标题按信源原语种显示，AI 摘要仍为中文。",
};

/** 英文月份名：`dayLabel` 把词表里的月份数字换成词。 */
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const en: typeof zh = {
  title: "All updates",
  searchTitle: (q: string) => `Search "${q}"`,
  tagTitle: (tag: string) => `#${tag}`,
  metaDescription: `Every geography update ${SITE.name} has collected, filterable by category and tag; search works in Chinese and English.`,

  todayPre: "",
  todayPost: " items today",

  searchSortLabel: "Search results order",
  sortTime: "Latest (title & summary)",
  sortRelevance: "Best match",
  foundPre: "Found ",
  foundMid: " results · updated ",

  viewingDayPre: "Showing only ",
  viewingDayPost: " ·",
  viewAllDates: "See all dates",
  dayLabel: (y: string, m: string, d: string) => `${EN_MONTHS[Number(m) - 1]} ${d}, ${y}`,

  listHeadingSearch: "Search results",
  listHeadingAll: "All updates",

  emptyTitle: "Nothing found",
  emptyTryRelevance: "Try “Best match” to search the full text too",
  emptySearch: "Rephrase the query, or clear the filters and try again.",
  emptyDay: "With these filters, nothing was published that day — pick another date, or clear the filters.",
  emptyDefault: "Nothing here under these filters yet.",

  pageCapWithCalendar: "Only the first 50 pages are available; for older days pick a date from the calendar above, or use search and topic pages.",
  pageCapWithoutCalendar: "Only the first 50 pages are available; remove the search term to pick an older day from the calendar, or use topic pages.",

  busyTitle: "Search is busy",
  busyBody: "Search is getting a lot of traffic right now — wait a few seconds and try again. Browsing the list is unaffected.",
  busyBrowseAll: "Browse all updates",
  busyBackSelected: "Back to Selected",

  /** Rows without an original title are Chinese sources whose published title already is the source headline — the sentence holds for the fallback too. */
  chineseNotice: "Titles appear in their original language. AI summaries are in Chinese.",
};

export const copy = { zh, en } as const;
