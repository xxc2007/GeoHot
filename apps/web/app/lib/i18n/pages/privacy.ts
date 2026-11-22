// Privacy page (`routes/privacy.tsx`). Same dictionary shape as the other page dicts: `en: typeof zh`
// keeps the two key sets in lock-step. The document body is the static copy (industry/pages/
// privacy.md / privacy.en.md), so this dict only carries the chrome: meta lines and the legal footer.
const zh = {
  metaTitle: "隐私说明",
  metaDescription: "本站如何处理浏览器本地数据、反馈资料与访问日志。",
  /** 页脚注记的前缀；版本与生效日期取自文档 meta 表，值随文档语言走。 */
  footerNote: "隐私说明",
  footerTerms: "使用规则",
  footerFeedback: "反馈页",
};

const en: typeof zh = {
  metaTitle: "Privacy notice",
  metaDescription: "How this site handles browser-local data, feedback and access logs.",
  footerNote: "Privacy notice",
  footerTerms: "Terms",
  footerFeedback: "Feedback",
};

export const copy = { zh, en } as const;
