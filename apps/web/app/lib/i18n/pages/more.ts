// "More" page (`routes/more.tsx`). Same dictionary shape as the other page dicts: `en: typeof zh`
// keeps the two key sets in lock-step. Row labels are referenced by key from the page's GROUPS table.
import { SITE } from "@aihot/industry/site";

const zh = {
  title: "更多",
  groups: {
    content: "内容",
    prefs: "偏好",
    about: "关于",
  },
  rows: {
    topics: "主题索引",
    leaderboard: "模型榜",
    codexReset: "Tibo重置监控",
    agent: "Agent 接入",
    starred: "收藏",
    aboutSite: `关于 ${SITE.name}`,
    changelog: "更新日志",
    feedback: "意见反馈",
    github: "GitHub 开源",
  },
  /** 偏好组里的两行控件名。 */
  appearance: "外观",
  language: "语言",
  footerTerms: "使用规则",
  footerPrivacy: "隐私说明",
  /** 更新日志红点的读屏补语（与 shell.ts 同一句）。 */
  dotSuffix: "，有新的更新",
};

const en: typeof zh = {
  title: "More",
  groups: {
    content: "Content",
    prefs: "Preferences",
    about: "About",
  },
  rows: {
    topics: "Topic index",
    leaderboard: "Leaderboard",
    codexReset: "Tibo reset monitor",
    agent: "Agent access",
    starred: "Saved",
    aboutSite: `About ${SITE.name}`,
    changelog: "Changelog",
    feedback: "Feedback",
    github: "Source on GitHub",
  },
  appearance: "Appearance",
  language: "Language",
  footerTerms: "Terms",
  footerPrivacy: "Privacy",
  dotSuffix: ", new updates",
};

export const copy = { zh, en } as const;
