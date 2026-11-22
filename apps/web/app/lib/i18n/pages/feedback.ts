// 反馈页（`routes/feedback.tsx`）的界面文案。与其他页面字典同一形态：`en: typeof zh` 保证两套键
// 完全一致；带插值的拆成前后两段（.ts 字典写不了 JSX，编号和隐私说明链接由页面包在中间）。
// 中文输出与 i18n 之前的字符串逐字相同。查询结果里的状态词来自接口，不在本字典里。
import { SITE } from "@aihot/industry/site";

const zh = {
  metaTitle: "反馈",
  metaDescription: `告诉 ${SITE.name} 哪里可以做得更好：内容、功能、接入或来源方的更正与下架请求。`,

  /** 右栏两张提示卡。 */
  tipsTitle: "写清楚这几点，处理更快",
  tips: [
    "出问题的页面或文章链接",
    "你看到了什么，原本想做什么",
    "有截图更好，记得先遮盖敏感信息",
  ],
  sourcesTitle: "来源方",
  sourcesBody: "如果你是来源方，希望更正、下架或调整展示方式，写明对应的文章链接和你的诉求即可。",

  /** 前端校验与提交失败的提示行。 */
  shotTypeError: "截图需要是 PNG、JPEG 或 WebP。",
  shotSizeError: "截图原图不超过 5 MB。",
  emptyContentError: "请写下反馈内容。",
  sendFailed: "提交失败，请稍后再试。",
  networkFailed: "网络不太顺，草稿已保存在本机，稍后再提交。",

  /** 成功页：编号夹在 doneBodyPre/Post 之间，由页面用 `<span class="mono">` 包好。 */
  doneTitle: "收到了，谢谢你",
  doneBodyPre: "反馈编号 ",
  doneBodyPost: "，需要回复时我们会引用这个编号。",
  /** 成功页的状态胶囊：这里的「已收到」是页面写死的（刚提交只可能是这个状态），不是接口值。 */
  doneStatus: "当前状态：已收到",
  doneHint: "记下编号；之后可用「编号 + 提交时留的邮箱」在本页下方查询处理进度。",
  backHome: "回到精选",

  /** 表单主体。 */
  headline: "说说你的想法",
  manageFeedback: "管理反馈",
  lead: "发现 bug、想要的功能、看不顺眼的地方，都可以告诉我，我都会看到。",
  contentLabel: "想说点什么？",
  contentPlaceholder: "例如：我在搜索“黄河三角洲”时没找到想要的内容，我原本想找最新的河道与湿地报道……",
  emailLabel: "邮箱",
  optional: "（选填）",
  emailPlaceholder: "留下邮箱，我可以回信联系你",
  shotLabel: "截图",
  shotPreviewAlt: "截图预览",
  removeShot: "移除截图",
  shotButton: "添加一张问题截图",
  shotHint: "粘贴或拖到这里也可以 · 请先遮盖敏感信息；PNG、JPEG 或 WebP，原图不超过 5 MB",
  /** 页脚说明拆成三段：隐私说明是一个链接，夹在 privacyPre 与 privacyPost 中间。 */
  privacyPre: "请勿提交密钥、身份证件或与问题无关的敏感信息。提交即表示你知悉反馈内容、选填邮箱、页面信息和截图将按",
  privacyLink: "隐私说明",
  privacyPost: "处理。",
  send: "发送反馈",

  /** 底部「查询处理状态」折叠卡。 */
  lookupTitle: "查询处理状态",
  lookupHint: "用反馈编号和提交时留的邮箱查看处理进度",
  lookupIdLabel: "反馈编号",
  lookupIdPlaceholder: "例如 12",
  lookupEmailNote: "（提交时留了才填）",
  lookupSubmit: "查询",
  /** 结果胶囊的前缀；冒号后的状态词来自接口（中文），保持原样。 */
  statusPrefix: "当前状态：",
  lookupMissing: "没有查到对应的反馈：请确认编号无误；提交时留了邮箱的反馈需要填同一个邮箱才能查询。",
  lookupError: "查询没有成功：请填写反馈编号，稍后再试。",
};

const en: typeof zh = {
  metaTitle: "Feedback",
  metaDescription: `Tell ${SITE.name} what to do better: content, features, access, or corrections and takedown requests from sources.`,

  tipsTitle: "These details speed things up",
  tips: [
    "A link to the page or article that went wrong",
    "What you saw, and what you were trying to do",
    "A screenshot helps — cover any sensitive information first",
  ],
  sourcesTitle: "For sources",
  sourcesBody: "If you are a source and want a correction, a takedown, or a different way your content is shown, include the article link and what you are asking for.",

  shotTypeError: "The screenshot must be a PNG, JPEG or WebP file.",
  shotSizeError: "Screenshots are limited to 5 MB.",
  emptyContentError: "Please write your feedback.",
  sendFailed: "Couldn't submit — please try again shortly.",
  networkFailed: "The network hiccuped. Your draft is saved on this device — try again later.",

  doneTitle: "Got it — thank you",
  doneBodyPre: "Feedback ID ",
  doneBodyPost: " — we'll cite it if a reply is needed.",
  doneStatus: "Status: received",
  doneHint: "Note the ID: you can check progress below on this page with the ID and the email you left when submitting.",
  backHome: "Back to Selected",

  headline: "Share your thoughts",
  manageFeedback: "Manage feedback",
  lead: "Bugs, features you'd like, anything that looks off — tell me; I read every message.",
  contentLabel: "What's on your mind?",
  contentPlaceholder: `e.g. I searched for "Yellow River Delta" but didn't find what I wanted — I was after the latest coverage of the river channel and wetlands…`,
  emailLabel: "Email",
  optional: "(optional)",
  emailPlaceholder: "Leave an email so I can reply to you",
  shotLabel: "Screenshot",
  shotPreviewAlt: "Screenshot preview",
  removeShot: "Remove screenshot",
  shotButton: "Add a screenshot of the problem",
  shotHint: "Paste or drag one here instead · Cover sensitive information first; PNG, JPEG or WebP, up to 5 MB",
  privacyPre: "Don't submit API keys, ID documents, or sensitive information unrelated to the issue. Submitting means you accept that the feedback, the optional email, page information and the screenshot are handled under the ",
  privacyLink: "privacy notice",
  privacyPost: ".",
  send: "Send feedback",

  lookupTitle: "Check the status",
  lookupHint: "Look up progress with the feedback ID and the email you left when submitting",
  lookupIdLabel: "Feedback ID",
  lookupIdPlaceholder: "e.g. 12",
  lookupEmailNote: "(only if you left one when submitting)",
  lookupSubmit: "Look up",
  statusPrefix: "Status: ",
  lookupMissing: "No matching feedback: double-check the ID; feedback submitted with an email can only be looked up with that same email.",
  lookupError: "The lookup didn't go through: fill in the feedback ID and try again shortly.",
};

export const copy = { zh, en } as const;
