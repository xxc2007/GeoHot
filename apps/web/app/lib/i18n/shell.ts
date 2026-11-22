// Chrome strings shared by the shell components (sidebar, phone tab bar, language switch) and the
// root shell itself (skip link, root error page). Same dictionary shape as the page dicts: the
// English object is typed as `typeof zh`, so a key added to zh without an English value fails the
// build instead of shipping a Chinese string on `/en`.
import { SITE } from "@aihot/industry/site";

const zh = {
  /** 侧栏左上角 logo 链接的读屏名。 */
  homeAria: `${SITE.name} 首页`,
  mainNav: "主导航",
  bottomNav: "底部导航",
  github: "GitHub 开源",
  /** 更新日志红点的读屏补语（红点是装饰，新闻必须由文字说给听）。 */
  dotSuffix: "，有新的更新",
  /** 语言切换按钮的读屏名（nc15 的写法：报当前语言，切换行为由菜单项自述）。 */
  langAria: "切换语言，当前为简体中文",

  /** 外观三分开关（ThemeSwitch）：组名与三个选项，侧栏与更多页共用同一份。 */
  appearanceAria: "外观",
  themeDark: "深色",
  themeSystem: "跟随系统",
  themeLight: "浅色",

  /**
   * 脚本关闭时唯一的提示行（root.tsx SiteShell，按页面语言二选一）：说明哪些东西还能读、
   * 哪些控件依赖客户端脚本。root.tsx 负责把它包进带样式的 `<p>`。
   */
  noscriptNotice:
    "当前浏览器未启用 JavaScript：正文、日报、事件页与全部链接照常可读，但卡片上的「另有 N 家信源报道」「展开 N 条进展」这类按需加载的列表、筛选控件与走势图无法使用。",

  /** 跳过导航直达正文的隐藏链接（root.tsx SiteShell）。 */
  skipToMain: "跳到正文",

  /**
   * RSS alternate 的 title（root.tsx Layout 渲染进 <head>）。feed 本身是中文源（/feed.xml 不分语言），
   * 标题只是随页面语言说人话——/en 页的 <head> 里不再残留中文（2026-11-22 第 2 轮验收）。
   */
  rssAlternateTitle: `${SITE.name} — 精选`,

  /** 回到顶部悬浮按钮的读屏名（Chrome.tsx BackToTop）。 */
  backToTop: "回到顶部",

  /**
   * 页面列自身的错误兜底（Chrome.tsx BoundaryFallback）：与根路由错误页（error 组）不同——
   * 那一张接管整个文档，这一张只换掉正文列，侧栏与页签还在。
   */
  boundary: {
    title: "这一页没能显示出来",
    body: "网站导航与其余内容照常工作。可以重试这一页，或者去精选看看。",
    retrying: "正在重试…",
    retry: "重试这一页",
    backSelected: "回到精选",
  },

  /**
   * 根路由错误页（root.tsx 的 meta 与 ErrorBoundary）。三种情形各一套标题与正文：404、网络中断
   * （isNetworkRouteError）与其余一切。按钮的链接目标不在这里——「回到精选/浏览全部动态」指向哪个
   * 前缀由页面按 locale 用 localePath() 决定。
   */
  error: {
    metaNotFound: "页面不存在",
    metaUnavailable: "暂时无法加载",
    notFoundTitle: "这里没有内容",
    notFoundBody: "你访问的页面不存在，或内容已不再公开。",
    connectionTitle: "连接暂时中断",
    connectionBody: "未能连接到页面服务，请检查网络后重新加载。已经加载过的内容不受影响。",
    unavailableTitle: "暂时无法加载",
    unavailableBody: "服务暂时繁忙，请稍后再试。已经加载过的内容不受影响。",
    reload: "重新加载当前页",
    backHome: "回到精选",
    browseAll: "浏览全部动态",
  },
};

const en: typeof zh = {
  homeAria: `${SITE.name} home`,
  mainNav: "Primary navigation",
  bottomNav: "Bottom navigation",
  github: "Source on GitHub",
  dotSuffix: ", new updates",
  langAria: "Switch language, currently English",

  appearanceAria: "Appearance",
  themeDark: "Dark",
  themeSystem: "System",
  themeLight: "Light",

  noscriptNotice:
    "JavaScript is off in this browser: articles, the daily issue, item pages and every link read as usual, but the lists that load on demand — “N more sources covering this”, “N updates” on cards — plus the filter controls and the trend charts do not work.",

  skipToMain: "Skip to content",

  rssAlternateTitle: `${SITE.name} — Selected`,

  backToTop: "Back to top",

  boundary: {
    title: "This page failed to render",
    body: "Site navigation and the rest of the content still work. Retry this page, or go back to Selected.",
    retrying: "Retrying…",
    retry: "Retry this page",
    backSelected: "Back to Selected",
  },

  error: {
    metaNotFound: "Page not found",
    metaUnavailable: "Temporarily unavailable",
    notFoundTitle: "Nothing here",
    notFoundBody: "This page does not exist, or its content is no longer public.",
    connectionTitle: "Connection interrupted",
    connectionBody: "Could not reach the page service. Check your network and reload. Pages you already loaded are unaffected.",
    unavailableTitle: "Temporarily unavailable",
    unavailableBody: "The service is busy right now, please try again shortly. Pages you already loaded are unaffected.",
    reload: "Reload this page",
    backHome: "Back to Selected",
    browseAll: "Browse all updates",
  },
};

export const copy = { zh, en } as const;
