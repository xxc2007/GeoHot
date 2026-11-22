// Topic page (`routes/topic.tsx`). Same dictionary shape as the other page dicts: `en: typeof zh`
// keeps the two key sets in lock-step, functions carry runtime numbers so word order can differ per
// locale. Chinese output is byte-identical to the pre-i18n strings. The topic name, definition and
// related-topic chips come from the api and stay Chinese; the English page says so in one line
// (`chineseNotice`, rendered on English pages only).

const zh = {
  /** loader 没拿到主题时的标题（这一支永远 noindex）。 */
  notFoundTitle: "主题不存在",
  /** 多页时的标题后缀：`甲主题 · 第 2 页`。 */
  metaPageSuffix: (page: string) => ` · 第 ${page} 页`,
  /** 面包屑里的索引层名字。 */
  breadcrumbTopics: "主题",

  /** 页头右上角去主题索引的入口。 */
  allTopics: "全部主题",
  /** 总数后面的单位（数字由页面用 `<span class="num">` 包好）：`132条精选`。 */
  selectedUnit: "条精选",
  relatedLabel: "相关主题",
  latestHeading: "最新精选",
  /** 范围行拆成三段（两处数字由页面用 `<span class="num">` 包好）：`第 1–20 条 · 共 132 条`。 */
  rangePre: "第 ",
  rangeMid: " 条 · 共 ",
  rangePost: " 条",

  /** 翻页越界的空态（读取层对越界页回 404，这条分支只是防御）。 */
  emptyPageTitle: (page: string) => `第 ${page} 页没有内容`,
  emptyPageAction: "回到第 1 页",
  emptyPageBody: (total: string, pages: string) => `这个主题共有 ${total} 条精选，分 ${pages} 页。`,
  /** 第一页就为空的空态：这一页的「精选」是全部存量，没有时间窗口，不能说「最近 30 天」。 */
  emptyTitle: "这个主题还没有入选的精选",
  emptyAction: "去全部动态里找找",
  emptyBody: "主题页只列入选精选的条目；其它信源原文仍在「全部动态」里，按分类筛就能收到同一批。",

  /**
   * 英文页的一行说明（zh 页永不渲染，此值只是文档）：主题名与定义是词表里的中文；行卡片在
   * 英文页优先信源原题（无原题回退的中文标题也是信源原话），AI 摘要仍为中文。
   */
  chineseNotice: "界面已英文化：主题名与定义为词表中文，条目标题按信源原语种显示，AI 摘要仍为中文。",
};

const en: typeof zh = {
  notFoundTitle: "Topic not found",
  metaPageSuffix: (page: string) => ` · Page ${page}`,
  breadcrumbTopics: "Topics",

  allTopics: "All topics",
  selectedUnit: " selected",
  relatedLabel: "Related topics",
  latestHeading: "Latest selected",
  rangePre: "Showing ",
  rangeMid: " of ",
  rangePost: "",

  emptyPageTitle: (page: string) => `Page ${page} has no items`,
  emptyPageAction: "Back to page 1",
  emptyPageBody: (total: string, pages: string) => `This topic has ${total} selected items across ${pages} pages.`,
  emptyTitle: "No selected items in this topic yet",
  emptyAction: "Browse all updates",
  emptyBody: `Topic pages list selected items only; the remaining source posts stay in “All updates” — filter by category and the same batch shows up.`,

  chineseNotice: "Topic names and definitions stay in Chinese. Item titles appear in their original language; AI summaries are in Chinese.",
};

export const copy = { zh, en } as const;
