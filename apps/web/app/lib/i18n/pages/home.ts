// Home page (`routes/home.tsx`). Dictionary shape: `en` is typed as `typeof zh`, so the two key sets
// cannot drift — a key present in zh but missing (or extra) in en fails the build. Values that need
// runtime numbers or styled spans are functions; the page passes the dynamic part in and word order
// stays per-locale. Chinese output here is byte-identical to the pre-i18n strings.
import { SITE, withSubject } from "@aihot/industry/site";

const zh = {
  /** 无筛选时的 h1 与「#/标签」外的标题。 */
  title: "精选",
  /** 筛选标签的后缀：`自然灾害 · 精选`。 */
  filterSuffix: "精选",
  metaDescription: (label: string) => `${SITE.name} 的${label}：按这一筛选的精选与时间线。`,
  liveTitle: "最新收录",
  liveHint: "按收录时间排列，部分条目未达精选标准",
  /** 收录池那几行左侧的时间格：条目没有可靠时间时的一格占位。 */
  noTime: "未注明",
  viewAll: (n: string) => `查看全部 ${n} 条${withSubject("动态")} →`,
  /**
   * 英文页的一行说明（zh 页永不渲染，此值只是文档）：条目标题按信源原语种显示（FeedItem 与
   * 「最新收录」兜底行都优先 originalTitle），而热点榜那条不随本次扩数据模型，事件标题与 AI
   * 摘要仍是中文——那句说明只说真话。
   */
  chineseNotice: "界面已英文化：条目标题按信源原语种显示；热点榜的事件标题与 AI 摘要仍为中文。",

  /** 热点条（HotTopics）：标题、「截至」行、完整榜单链接、空态与趋势读屏词。热度数随 lib/format 走。 */
  hotTitle: "当前热点",
  hotAsOf: (t: string) => `截至 ${t}`,
  hotFullBoard: "完整榜单",
  hotEmpty: "过去 48 小时还没有两家以上信源同时讨论的事件。",
  hotEmptyLink: `看今天的全部${withSubject("动态")} →`,
  trendUp: "热度上升",
  trendDown: "热度回落",
  trendFlat: "热度持平",
  trendNew: "新",
  heatTitle: "热度指数",
  heatPost: " 热度",

  /** 手机首页（MobileHome）：两段切换、图标入口的读屏名、日期栏与收录池的各个状态。 */
  mobileSwitchAria: "列表",
  mobileSelected: "精选",
  mobileAll: "全部",
  mobileDailyAria: "日报",
  mobileSearchAria: "搜索",
  mobileTodayPre: "今天 · ",
  mobileTodayAria: "今天的条目",
  mobileCount: (n: number) => `${n} 条`,
  /** 手机「全部」里更早日期那一段的读屏名。 */
  mobileDayAria: (day: string) => `${day} 的条目`,
  poolLoadingAria: "正在载入收录池",
  poolErrorAria: (why: string) => `收录池这一会儿读不到（${why}）`,
  poolMiss: "这次没取到",
  poolUnreachable: "收录池这一会儿读不到，",
  poolRetry: "再试一次",
  poolGoAll: "去全部列表看看 →",
  poolEmpty: "这一筛选下还没有收录内容。",
  poolLoadingMore: "正在接着取…",
  poolChunkFailed: (why: string) => `这一屏没取到（${why}）`,
  poolTimeout: "这次取超时了，再滑一下试试",
  poolFailed: "加载失败",
  poolCap: "最多提供 50 页；更早的日子请用上面的日历挑一天。",
  poolEnd: "已经到底了。",
  poolLoadMore: "加载更多",
};

const en: typeof zh = {
  title: "Selected",
  filterSuffix: " selected",
  metaDescription: (label: string) => `GEOHOT selected for ${label}: the curated feed and timeline for this filter.`,
  liveTitle: "Latest additions",
  liveHint: "Ordered by ingestion time; some entries are below the curated bar",
  noTime: "no time",
  viewAll: (n: string) => `View all ${n} updates →`,
  /** The trending strip above keeps Chinese story titles (its data model carries no original title), so the line names it honestly. */
  chineseNotice: "Some titles and summaries have no English version yet and are shown in Chinese.",

  hotTitle: "Trending now",
  hotAsOf: (t) => `as of ${t}`,
  hotFullBoard: "Full ranking",
  hotEmpty: "In the past 48 hours, no event has been discussed by two or more independent sources yet.",
  hotEmptyLink: "See all of today's updates →",
  trendUp: "Heat rising",
  trendDown: "Heat easing",
  trendFlat: "Heat steady",
  trendNew: "NEW",
  heatTitle: "Heat score",
  heatPost: " heat",

  mobileSwitchAria: "List",
  mobileSelected: "Selected",
  mobileAll: "All",
  mobileDailyAria: "Daily brief",
  mobileSearchAria: "Search",
  mobileTodayPre: "Today · ",
  mobileTodayAria: "Today's items",
  mobileCount: (n) => `${n} ${n === 1 ? "item" : "items"}`,
  mobileDayAria: (day) => `${day} items`,
  poolLoadingAria: "Loading the collection pool",
  poolErrorAria: (why) => `The collection pool cannot be read right now (${why})`,
  poolMiss: "nothing came back",
  poolUnreachable: "The collection pool cannot be read right now.",
  poolRetry: "Try again",
  poolGoAll: "Browse the full list →",
  poolEmpty: "Nothing collected under these filters yet.",
  poolLoadingMore: "Loading more…",
  poolChunkFailed: (why) => `This batch failed to load (${why})`,
  poolTimeout: "This batch timed out — scroll again to retry",
  poolFailed: "Loading failed",
  poolCap: "Only the first 50 pages are available; use the calendar above to pick an older day.",
  poolEnd: "You have reached the end.",
  poolLoadMore: "Load more",
};

export const copy = { zh, en } as const;
