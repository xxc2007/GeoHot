// Changelog page (`routes/changelog.tsx`). Same dictionary shape as the other page dicts: `en: typeof zh`
// keeps the two key sets in lock-step, functions carry runtime values (kind names, month counts) so word
// order can differ per locale. Chinese output is byte-identical to the pre-i18n strings.

/** 英文的月份名：侧栏按月与正文日期标题在英文里要用词，不是数字。 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const zh = {
  metaTitle: "更新日志",
  metaDescription: (name: string) => `${name} 的功能更新、优化、公告与下线记录。`,

  headline: "更新日志",
  intro: "新功能、调整与修复，都写在这里。",

  byKind: "按类型看",
  byMonth: "按月份",
  all: "全部",
  /**
   * 类型词的键来自 changelog.json（数据），颜色在页面里配（KIND_DOT）；这里只给词。
   * 键集合故意不封闭：认不出的类型在页面回落原文，与灰点回落是同一件事，
   * 所以这两张表放开成 Record，不再由 `en: typeof zh` 逐键锁死。
   */
  kindLabels: {
    更新: "更新",
    新增: "新增",
    优化: "优化",
    公告: "公告",
    修复: "修复",
  } as Record<string, string>,

  /** 侧栏月份行的两段（数字由页面传成字符串）。 */
  monthLabel: (y: string, mo: string) => `${y} 年 ${mo} 月`,
  monthCount: (n: string) => `${n} 条`,

  feedbackTitle: "有想法或遇到问题",
  feedbackBody: "想要的功能、用着不顺的地方，都可以在反馈页告诉我们。",
  feedbackCta: "去反馈",

  /** 被合并掉的旧类型带着原文进句子：它来自数据（老链接里的 kind），不属于界面词。 */
  retiredNotice: (kind: string) => `「${kind}」这一类已经并到现在的五种类型里，所以下面按全部给你看。`,

  /** 正文日期标题：日期与星期分开渲染，星期以 beijingWeekday 的中文输出为键。 */
  dateLabel: (y: string, m: string, d: string) => `${y} 年 ${m} 月 ${d} 日`,
  weekdayNames: {
    星期日: "周日",
    星期一: "周一",
    星期二: "周二",
    星期三: "周三",
    星期四: "周四",
    星期五: "周五",
    星期六: "周六",
  } as Record<string, string>,
};

const en: typeof zh = {
  metaTitle: "Changelog",
  metaDescription: (name: string) => `Feature updates, improvements, announcements and retirements at ${name}.`,

  headline: "Changelog",
  intro: "New features, changes and fixes, all written down here.",

  byKind: "By type",
  byMonth: "By month",
  all: "All",
  kindLabels: {
    更新: "Update",
    新增: "Added",
    优化: "Improved",
    公告: "Notice",
    修复: "Fix",
  } as Record<string, string>,

  monthLabel: (y: string, mo: string) => `${MONTHS[Number(mo) - 1]} ${y}`,
  monthCount: (n: string) => `${n} entries`,

  feedbackTitle: "Ideas or problems?",
  feedbackBody: "Missing a feature, or something feels off? Tell us on the feedback page.",
  feedbackCta: "Go to feedback",

  retiredNotice: (kind: string) => `The “${kind}” type has been merged into the five current types, so everything is shown below.`,

  dateLabel: (y: string, m: string, d: string) => `${MONTHS[Number(m) - 1]} ${d}, ${y}`,
  weekdayNames: {
    星期日: "Sun",
    星期一: "Mon",
    星期二: "Tue",
    星期三: "Wed",
    星期四: "Thu",
    星期五: "Fri",
    星期六: "Sat",
  } as Record<string, string>,
};

export const copy = { zh, en } as const;
