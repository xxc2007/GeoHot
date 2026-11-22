// 条目页（`routes/item.tsx`，`routes/item-original.tsx` 直接复用它的组件与 meta）。与其他页面字典
// 同一个形状：`en: typeof zh` 把两套键锁在一起，函数承接运行时数字与去处名，中文输出与 i18n 之前
// 的字符串逐字相同。条目标题、摘要、正文、主题词、信源名这些来自 API 的内容不进字典：英文页把
// 信源原题抬成 H1 与 SEO 文案，落在中文的内容（中文标题回退、AI 导读、中文正文）在原位置就地注明。

/** `lib/back-place.ts` 的 PLACES 表给出的中文去处名 → 英文名；与 nav.ts 的 labelEn 是同一套词。 */
const BACK_PLACE_EN: Record<string, string> = {
  精选: "Selected",
  全部动态: "All updates",
  热点榜: "Trending",
  收藏: "Saved",
  主题: "Topics",
  主题页: "Topic page",
  事件页: "Story page",
  日报: "Daily brief",
  周报: "Weekly brief",
  月报: "Monthly brief",
  榜单: "Leaderboard",
  关于: "About",
  更新日志: "Changelog",
  更多: "More",
};

/** 「12.3」（万字）→「123k」：英文的字数用 k 计，「万」换 k 只是小数点右移一位。 */
function wanToK(wan: string): string {
  return `${Math.round(Number(wan) * 10)}k`;
}

const zh = {
  notFoundTitle: "内容不存在",

  /** 「返回」与「返回去处」：去处名由 backPlace（lib/back-place.ts）给出，这里只管拼法。 */
  back: "返回",
  backTo: (name: string) => `返回${name}`,

  /** 「更多操作」菜单。 */
  moreActions: "更多操作",
  shareLink: "分享链接",
  makePoster: "生成分享海报",
  copyLink: "复制链接",
  exportMarkdown: "导出 Markdown",

  /** 操作结果的两条 toast。 */
  toastCopied: "链接已复制",
  shareFailed: "分享没成功，请手动复制地址栏",
  copyFailed: "复制没成功，请手动复制地址栏",

  /** 顶部「原文」按钮：X 条目打开的是原推。`original` 还用在正文语言的切换片上。 */
  viewOnX: "在 X 查看原推",
  openOriginal: "打开原文",
  original: "原文",
  /** 原文地址不是 http(s) 时只按文字显示的 title 提示。 */
  originalNotHttp: "原文地址不是 http(s) 地址，只作文字显示",
  /** 媒体块里视频的可访问名，跟着平台说。 */
  videoOnX: "打开原推播放视频",
  videoOriginal: "打开原视频观看",

  /** 目录：`toc` 是手机工具栏的短词，`tocFull` 是 aria 名与侧栏标题用的全称。 */
  toc: "目录",
  tocFull: "本文目录",
  share: "分享",

  /** 正文块左上角的小标签：按有没有中文稿、看的是哪一份正文取词。 */
  bodyPlain: "正文",
  bodyOriginal: "正文 · 原文",
  bodyAiTranslation: "正文 · AI 翻译",
  bodyLangLabel: "正文语言",
  langZh: "中文",
  translationIncomplete: "译文尚不完整，完整内容请切换到原文。",
  /** 英文页的正文说明：正文本来就是中文原创（zhKind === "original"）时，如实说清这一篇没有其他
      语言的正文可切。中文页不渲染这一条，键随 `en: typeof zh` 锁进两套。 */
  bodyZhOriginalNotice: "这篇正文本来就是中文原创，本页没有其他语言的正文。",
  /** 长文只贴前段的说明：页面算好「万字」数（一位小数）传进来。 */
  truncateNotice: (total: string, shown: string) =>
    `这篇原文很长（约 ${total} 万字），站内只贴前 ${shown} 万字，后面的部分请打开原文阅读。`,

  /** 摘要块顶部的小标签：来源仅准摘要时是「摘要」，站内导读是「AI 导读」。 */
  summaryTag: "摘要",
  aiDigestTag: "AI 导读",
  /** 英文页的同两个标签，注明摘要与导读都是中文写的；中文页仍用上面两个原键，词不变。 */
  summaryZhTag: "摘要",
  aiDigestZhTag: "AI 导读",

  /** 灾害与预警类条目指回 /terms#s4 的那段话：链接夹在中间，收尾括号随语言走。 */
  riskNoticePre: "本站不是预警信息的发布机构，本页内容不构成预警依据；防灾、避险与出行决定请以官方台网与应急部门当次正式发布为准（",
  riskTermsLink: "使用规则第 3 条",
  riskNoticePost: "）。",

  reasonTitle: "推荐理由",
  aiScoreTitle: "AI 评分",
  topicsTitle: "主题",
  tagsTitle: "标签",

  /** 左侧事实栏。 */
  sourcesTitle: "来源",
  publishedLabel: "发布时间",

  summaryOnlyNotice: "这一条不提供站内全文：来源仅准摘要。标题、导读与来源信息保持可见，完整内容请阅读原文。",
  /** 没有中文稿的条目（读取层闸门外唯一还留着的页）要如实说明的哪一句。 */
  noZhDraftNotice: "这一条还没有中文稿：以下标题与提要是原文。本站的列表、精选与日报只收有中文稿的条目，所以它不在那里面。",

  /** 文末来源行的前缀（冒号随语言走）。 */
  sourceLabel: "来源：",
  relatedTitle: "相关事件",

  /** 面包屑（JSON-LD）里两级站内落点的名字，与 nav.ts 的用词一致。 */
  crumbSelected: "精选",
  crumbAll: "全部动态",

  /** ChunkBoundary（懒加载块挂掉）的标签，接在组件自己的「没能加载」提示前面。 */
  posterBoundary: "分享海报",
};

const en: typeof zh = {
  notFoundTitle: "Not found",

  back: "Back",
  /** backPlace 的去处名是中文，英文页换成上面的表；认不出的名字宁可只说 Back，也不把中文带进来。 */
  backTo: (name: string) => {
    const place = BACK_PLACE_EN[name];
    return place ? `Back to ${place}` : "Back";
  },

  moreActions: "More actions",
  shareLink: "Share link",
  makePoster: "Create share poster",
  copyLink: "Copy link",
  exportMarkdown: "Export Markdown",

  toastCopied: "Link copied",
  shareFailed: "Couldn't share — copy the URL from the address bar",
  copyFailed: "Couldn't copy — copy the URL from the address bar",

  viewOnX: "View post on X",
  openOriginal: "Open original",
  original: "Original",
  originalNotHttp: "The original URL is not http(s) — shown as plain text",
  videoOnX: "Play video from the original post on X",
  videoOriginal: "Open the original video to watch",

  toc: "Contents",
  tocFull: "Table of contents",
  share: "Share",

  bodyPlain: "Body",
  bodyOriginal: "Body · original",
  bodyAiTranslation: "Body · AI translation",
  bodyLangLabel: "Body language",
  langZh: "Chinese",
  translationIncomplete: "The translation is incomplete — switch to the original for the full text.",
  bodyZhOriginalNotice: "This article was originally written in Chinese — the body below is that original text, and no translated body is available for it.",
  truncateNotice: (total: string, shown: string) =>
    `This source article is very long (about ${wanToK(total)} characters) — only the first ${wanToK(shown)} are included here; open the original to read the rest.`,

  summaryTag: "Summary",
  aiDigestTag: "AI digest",
  summaryZhTag: "Summary, in Chinese",
  aiDigestZhTag: "AI digest, in Chinese",

  riskNoticePre: "This site is not an official warning authority, and nothing on this page constitutes a warning; for preparedness, evacuation and travel decisions, follow the current official releases of official monitoring networks and emergency agencies (",
  riskTermsLink: "Terms, Section 3",
  riskNoticePost: ").",

  reasonTitle: "Why we picked this",
  aiScoreTitle: "AI score",
  topicsTitle: "Topics",
  tagsTitle: "Tags",

  sourcesTitle: "Sources",
  publishedLabel: "Published",

  summaryOnlyNotice: "This item has no full text on this site: the source allows a summary only. The title, digest and source details stay visible — read the original for the full content.",
  noZhDraftNotice: "This item has no Chinese draft yet, so the title and summary below are in the original language. Lists, picks and daily briefs on this site only include items with a Chinese draft, which is why it is missing there.",

  sourceLabel: "Source: ",
  relatedTitle: "Related events",

  crumbSelected: "Selected",
  crumbAll: "All updates",

  posterBoundary: "Share poster",
};

export const copy = { zh, en } as const;
