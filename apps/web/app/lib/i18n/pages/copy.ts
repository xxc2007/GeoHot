// 法务页共用版式（features/copy/CopyPage.tsx，terms 与 privacy 两页同一个组件）的侧栏词表。
// 文档正文与 meta 值来自 markdown（terms.en.md/privacy.en.md，值已是英文，键仍是中文数据键），
// 这里只翻版面上的栏目名与四个事实键的显示名；中文输出与 i18n 之前逐字相同。
const zh = {
  /** 左栏（手机上是正文上方）的事实栏标题与右栏的目录。 */
  infoTitle: "文档信息",
  tocTitle: "目录",
  tocAria: "目录",
  /** doc.meta 的四个中文数据键 → 显示名（中文页键名即显示名）。 */
  fact: {
    "版本": "版本",
    "生效日期": "生效日期",
    "运营主体": "运营主体",
    "备案号": "备案号",
  } as Record<string, string>,
};

const en: typeof zh = {
  infoTitle: "About this document",
  tocTitle: "Contents",
  tocAria: "Table of contents",
  fact: {
    "版本": "Version",
    "生效日期": "Effective date",
    "运营主体": "Operator",
    "备案号": "Filing no.",
  },
};

export const copy = { zh, en } as const;
