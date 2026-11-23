// Hot list page (`routes/hot.tsx`). Same dictionary shape as the other page dicts: `en: typeof zh`
// keeps the two key sets in lock-step, functions carry runtime numbers and ReactNode spans so word
// order can differ per locale. Chinese output is byte-identical to the pre-i18n strings.
import { withSubject } from "@aihot/industry/site";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { monthDayTime } from "../../format";

/** English month names for the updated-at line（同 story.ts 的做法，月份词只跟语言走）. */
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const zh = {
  metaTitle: withSubject("热点榜"),
  metaWithEntries: (count: string, hours: string) =>
    `过去 ${hours} 小时讨论最多的 ${count} 个${withSubject("事件")}：热度指数、趋势与组成热度的公开来源。`,
  metaEmpty: (hours: string) => `过去 ${hours} 小时的${withSubject("热点榜")}：还没有足够多来源共同讨论的事件。`,

  kicker: "实时热度",
  headline: withSubject("热点榜"),
  /**
   * 副标题拆成前后两段：中间那段是页面用 `<span class="num">` 包好的数字，字典只出文字（.ts 字典
   * 不能写 JSX）。中文两段拼起来与 i18n 之前的字符串逐字相同。
   */
  leadFilledPre: (hours: string) => `过去 ${hours} 小时，讨论最多的 `,
  leadFilledPost: (hours: string) => ` 个${withSubject("事件")}`,
  leadEmpty: (hours: string) => `过去 ${hours} 小时还没有讨论够热的${withSubject("事件")}`,
  /** 更新时间行的前后两段（时间由页面用 `<span class="num">` 包好）。 */
  updatedPre: "",
  updatedPost: " 更新 · 按讨论热度排序",
  /** 夹在前后两段之间的时间词：中文仍是 format.ts 的 monthDayTime（出处只有一处），英文换月份名。 */
  updatedAt: (iso: string) => monthDayTime(iso),

  emptyTitle: "暂时没有热点",
  emptyBody: "还没有足够多来源共同讨论的事件。",
  seeAll: `看今天的全部${withSubject("动态")}`,
  latestBrief: `去最新一期${withSubject("日报")}`,

  /** 徽标：键来自数据（surge/new/rising），色在页面里配，这里只给词。 */
  badges: {
    surge: { label: "爆", hint: "讨论快速增加" },
    new: { label: "新", hint: "首报 6 小时内" },
    rising: { label: "发酵中", hint: "讨论仍在增加" },
  },

  heatPanel: {
    title: "24 小时热度",
    peak: "峰值",
    current: "当前",
    hoursAgo: (n: string) => `${n} 小时前`,
    startLabel: "24 小时前",
    now: "现在",
  },

  latestProgress: "最新进展",
  heatIndex: "热度指数",

  voices: {
    /** 名字串的连接符。 */
    nameJoiner: "、",
    /** 名字展示不下全部信源时的后缀（名字串由页面单独渲染）：`…等 4 个来源`。 */
    sourcesAmong: (total: string) => ` 等 ${total} 个来源`,
    /** 名字全展示了：`… 报道`。 */
    sourcesReported: " 报道",
    /** 一个名字都没展示：`4 个来源`。 */
    sourcesPlain: (total: string) => `${total} 个来源`,
  },
  /** 数字后面直接拼的单位（数字由页面用 `<span class="num">` 包好）。 */
  sourceUnit: " 个来源",
  participantUnit: " 位参与者",
  rankAria: (n: string) => `热度排名第 ${n} 位`,
  /** 头像堆与名单弹层的读屏名、分组词与「另有 N 位」；名字本身来自数据。 */
  faces: {
    aria: (total: string) => `${total} 位参与者，查看名单`,
    dialogAria: "参与讨论的来源",
    editorial: "精选组",
    signal: "氛围组",
    more: (n: string) => `另有 ${n} 位未列出`,
    nameJoiner: "、",
  },
  /** 趋势徽标：标题与可见词。 */
  delta: {
    unknownTitle: "部分信源的采集暂时落后，先不和 6 小时前比较",
    unknown: "暂不比较",
    newLabel: "新上榜",
    flatTitle: "较 6 小时前",
    flat: "持平",
    upTitle: "较 6 小时前",
    downTitle: "较 6 小时前",
  },

  topThree: "热度前三",
  moreHot: "其余热点",
  continueLabel: "继续看",
  legend: "参与者 · 24 小时走势 · 热度指数",

  howTitle: "热度是怎么算的？",
  howShow: "了解榜单",
  howHide: "收起",
  how1: "热度来自参与同一事件的独立账号与机构，重复采集只算一次，并按 24 小时半衰期衰减。它衡量讨论活跃程度，不是报道质量评分。",
  how2: "榜单统计过去 48 小时。趋势只比较持续覆盖的同一组信源；它反映我们的监测范围，不代表全网人数。缺少可比历史时，不展示趋势线。",
  how3: "信源名单只展示可公开阅读的报道来源；讨论参与者还包括只计入热度的账号与机构。同一机构的多个渠道可能合并计数，因此参与者不一定多于信源数。点击事件可查看各方报道与观点。",

  /** 英文页的一行说明（zh 页永不渲染，此值只是文档）：热点条（HotEntryView）不带信源原题，事件标题与 AI 摘要仍是中文。 */
  chineseNotice: "界面已英文化：事件标题与 AI 摘要仍为中文。",
};

const en: typeof zh = {
  metaTitle: "Trending",
  metaWithEntries: (count: string, hours: string) =>
    `The ${count} events most discussed in the past ${hours} hours: heat index, trend and the public sources behind the heat.`,
  metaEmpty: (hours: string) => `Trending in the past ${hours} hours: not enough independent sources are covering the same events yet.`,

  kicker: "Live heat",
  headline: "Trending",
  leadFilledPre: (hours: string) => `The `,
  leadFilledPost: (hours: string) => ` events most discussed in the past ${hours} hours`,
  leadEmpty: (hours: string) => `In the past ${hours} hours, no event has drawn enough discussion yet`,
  updatedPre: "Updated ",
  updatedPost: " · ranked by discussion heat",
  updatedAt: (iso: string) => {
    const [, m, d] = beijingDate(iso).split("-").map(Number) as [number, number, number];
    return `${MONTHS_EN[m - 1]!} ${d}, ${beijingTime(iso)}`;
  },

  emptyTitle: "No trending events right now",
  emptyBody: "Not enough independent sources are covering the same event yet.",
  seeAll: "See all of today's updates",
  latestBrief: "Read the latest daily brief",

  badges: {
    surge: { label: "Surge", hint: "Discussion is climbing fast" },
    new: { label: "New", hint: "First reported within 6 hours" },
    rising: { label: "Building", hint: "Discussion still growing" },
  },

  heatPanel: {
    title: "24-hour heat",
    peak: "Peak",
    current: "now",
    hoursAgo: (n: string) => `${n}h ago`,
    startLabel: "24h ago",
    now: "now",
  },

  latestProgress: "Latest development",
  heatIndex: "Heat index",

  voices: {
    nameJoiner: ", ",
    sourcesAmong: (total: string) => ` among ${total} sources`,
    sourcesReported: " reported",
    sourcesPlain: (total: string) => `${total} sources`,
  },
  sourceUnit: " sources",
  participantUnit: " participants",
  rankAria: (n: string) => `Ranked No. ${n} by heat`,
  faces: {
    aria: (total: string) => `${total} participants — view the list`,
    dialogAria: "Sources in the discussion",
    editorial: "Editorial picks",
    signal: "Ambient sources",
    more: (n: string) => `${n} more participants not listed`,
    nameJoiner: ", ",
  },
  delta: {
    unknownTitle: "Some sources are behind on collection; no comparison against 6 hours ago yet",
    unknown: "Not compared",
    newLabel: "New",
    flatTitle: "vs. 6 hours ago",
    flat: "Flat",
    upTitle: "vs. 6 hours ago",
    downTitle: "vs. 6 hours ago",
  },

  topThree: "Top three",
  moreHot: "More trending",
  continueLabel: "Continue:",
  legend: "Participants · 24-hour trend · Heat index",

  howTitle: "How is heat computed?",
  howShow: "About this list",
  howHide: "Collapse",
  how1: "Heat counts the independent accounts and outlets covering the same event — duplicate collection counts once, and it decays with a 24-hour half-life. It measures how active the discussion is, not the quality of reporting.",
  how2: "The board covers the past 48 hours. Trends compare the same set of sources across sustained coverage; they reflect our monitoring scope, not the whole web. Without comparable history, no trend line is drawn.",
  how3: "The source list shows publicly readable reporting only; discussion participants also include accounts and outlets counted for heat alone. Several channels of one outlet may be merged, so participants can be fewer than sources. Open an event to read every side's reports and viewpoints.",

  chineseNotice: "Some story titles and summaries have no English version yet and appear in Chinese.",
};

export const copy = { zh, en } as const;
