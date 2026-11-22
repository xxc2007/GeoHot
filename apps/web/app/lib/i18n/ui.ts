// 小组件共用的界面词表：精选徽标（Badge 的 SelectedBadge）、AI 评分药丸（Score）与复制按钮
// （CodeBlock 的 CopyButton）。这些组件同时被信息流卡片、条目页与 Agent 页引用，词条跟着页面语言
// 走（useLocale），不再各自硬编码中文。字典形状与 shell.ts 一致：`en: typeof zh` 把两份键锁住。
const zh = {
  /** 卡片与条目页的「精选」角标（Badge.tone="selected" 的那颗）。 */
  selectedBadge: "精选",

  /** 复制按钮的三种状态：CopyButton 的 label 入参缺省时用 idle 词，显式传入的 label 优先。 */
  copyIdle: "复制",
  copyDone: "已复制",
  copyFailed: "复制失败",

  /** AI 评分药丸（Score）：徽标文字、悬停 title 与读屏名。 */
  scoreLabel: "AI 评分",
  scoreTitle: (n: number) => `AI 评分 ${n}/100`,
  scoreAria: (n: number) => `AI 评分 ${n} 分`,
};

const en: typeof zh = {
  selectedBadge: "Selected",

  copyIdle: "Copy",
  copyDone: "Copied",
  copyFailed: "Copy failed",

  scoreLabel: "AI score",
  scoreTitle: (n: number) => `AI score ${n}/100`,
  scoreAria: (n: number) => `AI score: ${n} out of 100`,
};

export const copy = { zh, en } as const;
