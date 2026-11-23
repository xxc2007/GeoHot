// 关于页（routes/about.tsx）。与其他页字典同一个形状：`en: typeof zh` 把两套键锁在一起，函数与
// `{sources}` 占位符承接运行时数字，中文输出与 i18n 之前的字符串逐字相同。这一页的版式与数字
// 都来自 ABOUT（industry/site.ts）和站内实时统计，是定制版式而非文档页——所以站点级文案不走
// industry/pages/*.en.md（about 本来就没有 .md），英文翻译放在这本字典里，路由按 locale 取。
// 中文一侧的 about* 各键是 site.ts 的原样引用（字典不存第二份中文，site.ts 改了这里自动跟上）；
// 若日后 site.ts 出现 ABOUT_EN，把这几处引用挪过去即可。
import { ABOUT, SITE, SITE_EN, withSubject } from "@aihot/industry/site";

// ABOUT/SITE 都是 as const，字面量类型会被 `en: typeof zh` 卡住：先放宽成 string/元组再放进 zh。
const zhAboutKicker: string = ABOUT.kicker;
const zhAboutHeadline: [string, string] = ABOUT.headline;
const zhAboutLead: string = ABOUT.lead;
const zhAboutSteps: { collect: string; store: string; select: string; publish: string } = ABOUT.steps;
const zhAboutGreeting: string[] = ABOUT.maker?.greeting ?? [];
const zhAboutCopyright: string = ABOUT.copyright;
const zhFooterNote: string = SITE.footerNote;

const zh = {
  metaTitle: "关于",
  metaDescription: `关于 ${SITE.name}：${SITE.description}`,

  /** 站点级文案（zh 一侧是 site.ts 的原样引用）。lead 里的 {sources} 由页面换成实时信源数。 */
  aboutKicker: zhAboutKicker,
  aboutHeadline: zhAboutHeadline,
  aboutLead: zhAboutLead,
  aboutSteps: zhAboutSteps,
  aboutGreeting: zhAboutGreeting,
  aboutCopyright: zhAboutCopyright,
  /** 版权段的收尾：版权文案 + 「反馈页」链接 + 这一句（英文版只剩一个句点）。 */
  copyrightContactPost: "联系我们。",
  /** lead 里的实时信源数读不到时的兜底词。 */
  leadSourcesFallback: "上百",

  /** 数字 ≥ 1 万时的单位：中文「3.6 万」，英文沿用 item.ts 字典的「万→k」换算出「36k」。 */
  wanUnit: "万",

  /** 信源种类的名字（顺序在页面的 KIND_ORDER 里）。 */
  kindLabels: {
    x_search: "X",
    rss: "RSS",
    web_list: "网页",
    mp_account: "公众号",
    json_list: "接口",
  },

  stageCollect: "采集",
  stageStore: "收录",
  stageSelect: "精选",
  stagePublish: "成刊",
  /** 数字后面直接拼的单位（数字由 Figure 组件包好）。 */
  unitSources: "个信源",
  unitItems: "条动态",
  unitSelected: "条精选",
  unitDailies: "期日报",
  /** 收录/精选两栏的 24 小时小注（数字由页面传进来）。 */
  dayCollected: (n: string) => `过去 24 小时收进 ${n} 条`,
  daySelected: (n: string) => `过去 24 小时 ${n} 条进了精选`,
  subscribeNote: "也可以用 RSS、API、MCP 订阅",

  makerKicker: "做这个站的人",
  makerHi: "嗨，我是 ",
  avatarAlt: (name: string) => `${name}的头像`,
  /** 「改了什么都写在更新日志里…」拆成五段：链接前 / 链接名 / 两链接之间 / 链接名 / 结尾。 */
  madeChangesPre: "它一直在改，改了什么都写在",
  changelogLink: "更新日志",
  madeChangesMid: "里；有想法、遇到问题，去",
  feedbackLink: "反馈页",
  madeChangesPost: "告诉我。",

  /** 信源河上/下带出的最新一条精选的名字。 */
  latestSelected: "最近精选",

  /** 英文页作者署名；中文页仍用 ABOUT.maker.name（熊鑫晨）。 */
  makerNameEn: "Xinchen Xiong",

  /** 信源河（SignalRiver）画布上的悬停词：版式固定，说法随页面语言。 */
  river: {
    daily: withSubject("日报"),
    edition: "每天 08:00 出刊",
    sourceFallback: "信源",
    singleSource: "一个信源",
    heatOnly: (kind: string) => `${kind} · 只计入热度`,
    sameEvent: "同一件事",
    bundle: (n: number) => `${n} 个来源的报道合成一条`,
    selected: "进了精选",
    selectedWhy: "有信息量，分数也够",
    notSelected: "没进精选",
    notSelectedWhy: "信息不够、重复或只是营销",
    kinds: {
      x_search: "X 账号",
      rss: "RSS",
      web_list: "网页",
      mp_account: "公众号",
      json_list: "接口",
    } as Record<string, string>,
  },

  ctaSelected: "看今天的精选",
  ctaBrief: `读最新${withSubject("日报")}`,

  /** 视觉隐藏的两句：这一节的名字、信源河给读屏的示意图描述。 */
  howHeading: `${SITE.name} 怎么工作`,
  riverAria: `示意图：每条线是一个信源；线汇成一束束，代表同一件事的多篇报道；经过精选的闸门，只有少数几束通过，汇入每天的${withSubject("日报")}。`,

  statsFailed: "这四格的统计数字这次没有读到，稍后刷新就有了；上面的流程说明与它们无关。",

  footerNote: zhFooterNote,
  footerNavAria: "规则与隐私",
  footerTerms: "使用规则",
  footerPrivacy: "隐私说明",
};

const en: typeof zh = {
  metaTitle: "About",
  metaDescription: SITE_EN.description,

  aboutKicker: `About ${SITE.name}`,
  aboutHeadline: ["News about this land arrives every day —", "only a few are grounded and worth writing up."],
  aboutLead: `${SITE.name} watches {sources} geography sources for you: fetch, merge, score, select — spatial salience decides what makes it into each day's daily brief, which goes out at 8:00 every morning. Free, no sign-up.`,
  aboutSteps: {
    collect:
      "Earthquakes, typhoons and floods as reported by station networks and satellite agencies; population and boundary figures from the statistics and administrative-division departments; research from geography journals; long reads by people doing regional studies and fieldwork. The fastest sources are checked every 30 minutes, most of them every one to four hours.",
    store: "Everything fetched is kept; reports of the same quake or the same dataset from several outlets are merged into one event, and accounts that only count toward heat are included too. Heat asks how many independent sources are writing about the same thing — a 48-hour window, halving every 24 hours — and the trending board is computed from it.",
    select:
      "First, is this geography, and does it carry real information? Past that gate, two independent spatial-salience scores (0–100) are assigned; only when their sum clears the threshold does an item get in — a larger affected area, several independent reports, and backing from data, maps or imagery rank higher. Both the criteria and the rules that keep things out (travel advertorials, study-tour recruiting, scenic-area press releases) are written down by the editors.",
    publish:
      "Each day's daily brief goes out at 08:00, the weekly on Mondays, the monthly on the 1st; items are ranked by heat and every entry keeps its original link, so you can go back and check. To receive them first, subscribe via RSS, API or MCP.",
  },
  aboutGreeting: [
    "Every day this site takes one pass over the geography-related movement: which station has released data, which river's course has a new account, which plan has landed on which tract of land.",
    "To be written up, an item has to say where it happened, how large the impact is and who reported it first — ideally with figures and maps. The original link stays under every entry; for important numbers, go back to the source and look.",
  ],
  aboutCopyright: `${SITE.name} is an aggregation of digests and a reading index; the copyright of the originals belongs to the station networks, agencies, journals and media that published them. If you are a source and want a correction, a takedown or a change in how something is shown, reach us through the`,
  copyrightContactPost: ".",
  leadSourcesFallback: "over a hundred",

  wanUnit: "k",

  kindLabels: {
    x_search: "X",
    rss: "RSS",
    web_list: "Web pages",
    mp_account: "WeChat accounts",
    json_list: "APIs",
  },

  stageCollect: "Collect",
  stageStore: "Ingest",
  stageSelect: "Select",
  stagePublish: "Publish",
  unitSources: " sources",
  unitItems: " updates",
  unitSelected: " selected",
  unitDailies: " daily briefs",
  dayCollected: (n) => `${n} collected in the past 24 hours`,
  daySelected: (n) => `${n} selected in the past 24 hours`,
  subscribeNote: "You can also subscribe via RSS, API or MCP",

  makerKicker: "The person behind this site",
  makerHi: "Hi, I'm ",
  avatarAlt: (name) => `Avatar of ${name}`,
  madeChangesPre: "It keeps changing — what changed is written in the",
  changelogLink: "Changelog",
  madeChangesMid: "; for ideas or problems, the",
  feedbackLink: "feedback page",
  madeChangesPost: " is where to tell me.",

  latestSelected: "Latest selected",
  makerNameEn: "Xinchen Xiong",
  river: {
    daily: "Daily brief",
    edition: "Published daily at 08:00",
    sourceFallback: "Source",
    singleSource: "A single source",
    heatOnly: (kind) => `${kind} · heat only`,
    sameEvent: "The same event",
    bundle: (n) => `${n} sources' reports merged into one`,
    selected: "Selected",
    selectedWhy: "Informative, and the score cleared the bar",
    notSelected: "Not selected",
    notSelectedWhy: "Not enough information, duplicate, or marketing",
    kinds: {
      x_search: "X account",
      rss: "RSS",
      web_list: "Web pages",
      mp_account: "WeChat accounts",
      json_list: "APIs",
    },
  },

  ctaSelected: "See today's picks",
  ctaBrief: "Read the latest daily brief",

  howHeading: `How ${SITE.name} works`,
  riverAria:
    "Diagram: each line is one source; lines gather into bundles — several reports of the same event; past the selection gate only a few bundles pass, flowing into each day's daily brief.",

  statsFailed:
    "The figures for these four stages didn't load this time — refresh a little later and they'll be here; the pipeline notes above don't depend on them.",

  footerNote: "Built on an open-source aggregation framework",
  footerNavAria: "Rules and privacy",
  footerTerms: "Terms",
  footerPrivacy: "Privacy",
};

export const copy = { zh, en } as const;
