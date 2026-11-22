// 搜索繁忙页（routes/search-busy.tsx）。与其他页面字典同一形状：`en: typeof zh` 让两份键集合无法
// 漂移——缺键或多键都会挂掉类型检查。这一页没有 API 动态内容，全部是界面文案；中文输出与 i18n
// 之前的字符串逐字相同（组件原先住在 routes/all.tsx，英文化时随本路由落回 routes/search-busy.tsx）。
const zh = {
  /** 浏览器标签页标题（路由里经 titled() 补上站名后缀）。 */
  metaTitle: "搜索繁忙",
  title: "搜索有点忙",
  body: "现在搜索的人比较多，请稍等几秒再试。列表浏览不受影响。",
  /** 两个按钮：去 /all 列表，回首页精选。 */
  browseAll: "浏览全部动态",
  backSelected: "回到精选",
};

const en: typeof zh = {
  metaTitle: "Search is busy",
  title: "Search is busy",
  body: "Search is seeing heavy traffic right now — please wait a few seconds and try again. Browsing the list is unaffected.",
  browseAll: "Browse all updates",
  backSelected: "Back to Selected",
};

export const copy = { zh, en } as const;
