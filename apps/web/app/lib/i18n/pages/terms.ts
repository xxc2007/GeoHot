// 使用规则页（routes/terms.tsx）。与其他页字典同一形状：`en: typeof zh` 锁住两份键集；页脚说明是
// 带占位的模板，版本与生效日期由页面从所选文档（中文版或 .en.md）的 meta 表里取好传入。
// 中文输出与 i18n 之前的字符串逐字相同。页面正文是静态文档，由 industry/pages/terms.en.md 提供
// 英文版，不经过这本字典。
const zh = {
  metaTitle: "使用规则",
  metaDescription: "本站网站、RSS、公开 API 与 MCP 的使用规则。",
  footerPrivacy: "隐私说明",
  footerAgent: "Agent 接入页",
  /** 页脚说明行：`使用规则 2.0.40 · 2026-10-01…`。 */
  footerNote: (version: string, date: string) => `使用规则 ${version} · ${date}`,
};

const en: typeof zh = {
  metaTitle: "Terms of Use",
  metaDescription: "Rules for using this site's website, RSS, public API and MCP.",
  footerPrivacy: "Privacy notice",
  footerAgent: "Agent access",
  footerNote: (version, date) => `Terms of Use ${version} · ${date}`,
};

export const copy = { zh, en } as const;
