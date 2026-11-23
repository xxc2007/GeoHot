// 条目页与卡片上的共享小部件词表：图片查看器（Lightbox）、分享海报（PosterSheet）、目录抽屉
// （TocSheet）、懒加载块兜底（ChunkBoundary）、媒体缩略图/星标（features/feed/parts）、大图画廊
// （MediaGallery）、引用帖（QuotedPost）与事件后续（StoryFollowups）。它们都会在 /en 页面上渲染，
// 词条跟着页面语言走（useLocale），字典形状与 shell.ts 一致：`en: typeof zh` 把两份键锁住。
// 中文输出与 i18n 之前逐字相同。
const zh = {
  /** 图片查看器。`n`/`total` 是当前序号与总数。 */
  lightbox: {
    dialogAria: (n: number, total: number) => `图片查看器 ${n} / ${total}`,
    zoomGroup: "图片缩放",
    zoomOut: "缩小图片",
    zoomIn: "放大图片",
    fitWindow: "适应窗口",
    fit: "适应",
    actualSize: "原始尺寸",
    close: "关闭",
    prev: "上一张",
    next: "下一张",
  },

  /** 分享海报。`title` 是条目标题（内容本身，不翻）。 */
  poster: {
    dialogAria: "分享海报",
    title: "分享海报",
    close: "关闭",
    failed: "海报生成失败，请稍后再试。",
    imageAlt: (title: string) => `${title} · 分享海报`,
    saveHint: "长按图片可保存或发送给朋友",
    save: "保存图片",
    share: "分享",
    shareFailed: "分享没有成功，可以先「保存图片」再发给朋友。",
  },

  /** 目录抽屉。`n` 是节数。 */
  toc: {
    dialogAria: "本文目录",
    title: "本文目录",
    close: "关闭",
    closeAria: "关闭目录",
    footer: (n: number) => `共 ${n} 节 · 点一条跳到正文对应位置`,
  },

  /** 懒加载块（海报/目录）下载失败时的兜底。`label` 是块名（字典里已有译名）。 */
  chunk: {
    failed: (label: string) => `${label}没能加载，请刷新页面重试。`,
    dismiss: "关闭",
  },

  /** 卡片上的媒体缩略图与星标按钮。alt 是图片说明（内容本身）。 */
  card: {
    viewImage: (alt: string | null) => `查看图片${alt ? `：${alt}` : ""}`,
    star: "收藏",
    unstar: "取消收藏",
  },

  /** 条目页大图画廊。`index`/`total` 只在多图时出现；alt 是图片说明（内容本身）。 */
  gallery: {
    /** 来源没有给说明时，如实说这是第几张，而不是假装没什么可说。 */
    fallbackAlt: (index: number, total: number) => `配图${total > 1 ? ` ${index}/${total}` : ""}（来源未提供说明）`,
    enlarge: (alt: string) => `查看大图：${alt}`,
  },

  /** 引用帖。 */
  quoted: {
    quote: "引用",
    original: "原文",
    viewOnX: "在 X 查看被引用的帖子",
    /** 英文页缺英文引用译文时的一句说明；中文页不渲染，只为两套键锁步。 */
    zhOnly: "被引用的帖子目前只有中文原文。",
    /** fallback 模式下英文页拿到的是中文译文：逐条标明，不把它当英文。 */
    zhTranslation: "引用译文为中文",
  },

  /** 事件后续块。 */
  followups: {
    noscript: "查看事件全部后续",
    viewAll: "查看事件全部",
    failed: "事件后续暂时无法加载，点此重试",
    heading: "事件后续",
    sameEvent: "同事件",
  },
};

const en: typeof zh = {
  lightbox: {
    dialogAria: (n, total) => `Image viewer ${n} / ${total}`,
    zoomGroup: "Image zoom",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    fitWindow: "Fit to window",
    fit: "Fit",
    actualSize: "Actual size",
    close: "Close",
    prev: "Previous image",
    next: "Next image",
  },

  poster: {
    dialogAria: "Share poster",
    title: "Share poster",
    close: "Close",
    failed: "The poster could not be generated. Please try again in a moment.",
    imageAlt: (title) => `${title} · share poster`,
    saveHint: "Press and hold the image to save it or send it to a friend",
    save: "Save image",
    share: "Share",
    shareFailed: "Sharing did not go through — save the image and send it to a friend instead.",
  },

  toc: {
    dialogAria: "Contents of this article",
    title: "Contents of this article",
    close: "Close",
    closeAria: "Close contents",
    footer: (n) => `${n} sections · tap one to jump to it in the text`,
  },

  chunk: {
    failed: (label) => `${label} failed to load. Reload the page to try again.`,
    dismiss: "Dismiss",
  },

  card: {
    viewImage: (alt) => `View image${alt ? `: ${alt}` : ""}`,
    star: "Save",
    unstar: "Remove from saved",
  },

  gallery: {
    fallbackAlt: (index, total) => `Image${total > 1 ? ` ${index}/${total}` : ""} (no description from the source)`,
    enlarge: (alt) => `View larger image: ${alt}`,
  },

  quoted: {
    quote: "Quoted",
    original: "Original",
    viewOnX: "View the quoted post on X",
    zhOnly: "The quoted post is in Chinese only.",
    zhTranslation: "Quoted translation in Chinese",
  },

  followups: {
    noscript: "See all follow-ups on this story",
    viewAll: "See the full story",
    failed: "Follow-ups could not be loaded — tap to retry",
    heading: "Story follow-ups",
    sameEvent: "Same event",
  },
};

export const copy = { zh, en } as const;
