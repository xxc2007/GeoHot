// 主题索引页（`routes/topics.tsx`）。字典形状与其它页面字典一致：`en: typeof zh` 保证两边键集合
// 锁步，函数携带运行时的数字与分组名串，词序可按语言各自安排。中文输出与 industry/site.ts 的
// TOPICS_PAGE 逐字相同（页面此前直接渲染那份文案，现在收进字典）。
import { SITE } from "@aihot/industry/site";

const zh = {
  metaTitle: "主题",
  metaDescription:
    "按区域与机构、自然与人文领域、内容与题材聚合的地理主题页：青藏高原、环太平洋火山地震带、东部沿海城市群，中国地震台网、USGS、中国气象局、NOAA、NASA、哥白尼计划等发布主体。",
  heading: `按主题看${SITE.subject}`,
  /**
   * 引导语拆成前后两段：中间那段是页面用 `<span class="num">` 包好的主题数——主题随行业包增减，
   * 由页面自己数（这句曾写死 45，加一个主题就过期）；分组名串由页面按 `groupJoiner` 拼好传入。
   */
  leadPre: (groups: string) => `按${groups}浏览 `,
  leadPost: (groups: string) => " 个主题，持续汇集近期焦点与精选。",
  /** 分组名串的连接符（分组名来自词表、经接口发来，属动态内容，保持中文）。 */
  groupJoiner: "、",

  /** 卡片链接的读屏补语与底部那句行动引导（数字由页面传入，箭头留在 JSX 里）。 */
  cardAria: (name: string) => `查看${name}相关精选文章`,
  cardCta: (total: string) => `查看 ${total} 条精选`,

  /** 英文页的一行说明（zh 页永不渲染，此值只是文档）：这一页只有主题卡，没有条目行。 */
  chineseNotice: "界面已英文化：分组名、主题词与释义仍是词表里的中文。",
};

const en: typeof zh = {
  metaTitle: "Topics",
  metaDescription:
    "Geography topics grouped by region and institution, natural and human fields, and content genre: the Tibetan Plateau, the Pacific Ring of Fire, eastern coastal city clusters, and publishers such as CENC, USGS, CMA, NOAA, NASA and Copernicus.",
  heading: "Geography by topic",
  leadPre: (groups: string) => `Browse the `,
  leadPost: (groups: string) => ` topics across ${groups} — a continuously updated collection of recent highlights and curated picks.`,
  groupJoiner: ", ",

  cardAria: (name: string) => `View curated articles for ${name}`,
  cardCta: (total: string) => `See ${total} curated picks`,

  /** This index page shows topic cards only — no item rows, so the line describes just the wordlist content. */
  chineseNotice: "Some topic names, group names and descriptions have no English version yet and are shown in Chinese.",
};

export const copy = { zh, en } as const;
