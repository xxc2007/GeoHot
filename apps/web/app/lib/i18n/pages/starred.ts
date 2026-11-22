// 收藏页（`routes/starred.tsx`）。字典形状与其他页面一致：`en: typeof zh` 把两份键集合锁在一起。
// 列表里的标题、摘要、信源名与时间来自本机收藏的数据，保持中文；英文页在动态内容上方放一行
// 说明（ChineseNotice，调用处不按语言分支）。中文输出与 i18n 之前的字符串逐字相同。
import { SITE } from "@aihot/industry/site";

const zh = {
  metaTitle: "我的收藏",
  metaDescription: `保存在这台设备上的 ${SITE.name} 收藏。`,

  title: "收藏",
  lead: `本机收藏的 ${SITE.name} 内容，适合稍后阅读和回看。`,
  importFile: "导入文件",
  exportLabel: "导出",
  /** 存储说明那一行，以及导入结果条右边的关闭按钮。 */
  storageNotice: "收藏只保存在当前浏览器；清除浏览器数据或换设备后不会同步。",
  closeAria: "关闭",

  emptyBody: "还没有收藏内容。点开任意一条内容，在详情页点击收藏即可添加。",
  emptyCta: "去看精选 →",

  /** 每行元信息的前缀（时间由页面用 `<span class="num">` 包好）与移除按钮的名字。 */
  savedAtPrefix: "收藏于 ",
  removeStar: "取消收藏",
  unavailableNote: "这条内容已不再公开，收藏会保留直到你手动移除。",
  summaryOnlyNote: "应来源方要求，这条内容现在只提供摘要。",

  /** 导入结果报告：各段按序拼好，joiner 是段与段之间的连接符。 */
  reportJoiner: "，",
  importDone: (report: string) => `导入完成：${report}`,
  importFailed: "导入失败",
  report: {
    starredAdded: (n: string) => `新增收藏 ${n} 条`,
    readAdded: (n: string) => `已读记录 ${n} 条`,
    skipped: (n: string) => `超出上限或格式不对而跳过 ${n} 条`,
    themeApplied: "已沿用导入的主题",
    readFailed: "已读记录没能保存（浏览器存储已满或不可用）",
  },
};

const en: typeof zh = {
  metaTitle: "Saved",
  metaDescription: `Your ${SITE.name} saved items, kept on this device.`,

  title: "Saved",
  lead: `${SITE.name} content saved on this device, for reading later and looking back.`,
  importFile: "Import file",
  exportLabel: "Export",
  storageNotice: "Saved items live only in this browser; clearing browser data or switching devices does not carry them over.",
  closeAria: "Close",

  emptyBody: "Nothing saved yet. Open any item, then tap Save on its detail page to add it here.",
  emptyCta: "See the selected →",

  savedAtPrefix: "Saved ",
  removeStar: "Remove from saved",
  unavailableNote: "This item is no longer publicly available; it stays saved until you remove it.",
  summaryOnlyNote: "At the source's request, this item now offers a summary only.",

  reportJoiner: "; ",
  importDone: (report: string) => `Imported: ${report}`,
  importFailed: "Import failed",
  report: {
    starredAdded: (n: string) => `${n} saved items added`,
    readAdded: (n: string) => `${n} read entries added`,
    skipped: (n: string) => `${n} skipped (over the limit or invalid)`,
    themeApplied: "Kept the imported theme",
    readFailed: "Read entries could not be saved (browser storage is full or unavailable)",
  },
};

export const copy = { zh, en } as const;
