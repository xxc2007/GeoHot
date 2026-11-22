// 日报归档页（routes/daily-archive.tsx）。字典形状与其他页面字典一致：`en: typeof zh` 把两套键锁在
// 一起，函数承接运行时的月份键与空档数据。中文输出与 i18n 之前的字符串逐字相同；各期的标题与
// 条目数来自 API，不进字典，英文页照旧是中文（页面顶部由 ChineseNotice 说明一句）。
import { SITE, withSubject } from "@aihot/industry/site";
import { dayLabel, type MissingRun } from "../../../features/report/format";

/** 月份键（YYYY-MM）→ 英文月份名：归档的分组标题用。 */
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** contracts/time.ts beijingWeekday 的中文星期 → 英文缩写（归档行日期下面的小字）。 */
const WEEKDAY_EN: Record<string, string> = {
  星期日: "Sun",
  星期一: "Mon",
  星期二: "Tue",
  星期三: "Wed",
  星期四: "Thu",
  星期五: "Fri",
  星期六: "Sat",
};

const zh = {
  metaTitle: `${withSubject("日报")} · 历史存档`,
  metaDescription: `${SITE.name} 的${withSubject("日报")}历史存档，按日期归档。`,

  /** 报头上方一行小字的后半段（前面的站点名由页面拼）。 */
  subject: withSubject("日报"),
  /** 期数（数字由页面用 `<span class="num">` 包好）。 */
  countPre: "共 ",
  countPost: " 期",
  /** 版头那张「合订本」字样的 svg 读屏念不到，可访问名在这里。 */
  boundTitle: `${withSubject("日报")}合订本`,

  /** 空档说明：加粗的「未出刊」后面直接接冒号起句的那段。这个状态词也用在归档行里。 */
  notPublished: "未出刊",
  notPublishedBody: "：那一天没有可读的一期——窗口内没有条目达到入选标准，或那一期引用的条目已全部下架。空刊不占期号，所以「第几期」会跳过它。",

  emptyTitle: `还没有${withSubject("日报")}存档`,
  emptyBody: "出刊之后，每一天的一期会按月份归到这里。",

  /** 分组标题（月份键 YYYY-MM）：中文与 format.ts archiveGroups 给 daily 的 label 逐字相同。 */
  monthLabel: (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`,
  /** 星期小字：入参是 beijingWeekday 的输出（星期X）。 */
  weekday: (w: string) => w.replace("星期", "周"),
  /** 空档的跨天说明："10月4日—6日 · 共 3 天"；单日读作 "10月5日 · 共 1 天"。 */
  runLabel: (run: MissingRun) =>
    `${dayLabel(run.from)}${run.days > 1 ? `—${Number(run.to.slice(8, 10))}日` : ""} · 共 ${run.days} 天`,
  /** 一期没有标题时的机械兜底（期号就是日期）。 */
  issueFallback: (key: string) => `${withSubject("日报")} ${key}`,
  /** 条目数（数字由页面用 `<span class="num">` 包好）。 */
  countUnit: " 件大事",
};

const en: typeof zh = {
  metaTitle: "Daily brief · Archive",
  metaDescription: `${SITE.name}'s daily brief archive, filed by date.`,

  subject: "Daily brief",
  countPre: "",
  countPost: " issues",
  boundTitle: "Daily brief archive",

  notPublished: "Not published",
  notPublishedBody:
    ": no readable edition came out that day — nothing met the bar within the window, or every item that edition cited has since been withdrawn. Blank days take no issue number, so the numbering skips them.",

  emptyTitle: "No daily brief archive yet",
  emptyBody: "Once editions start coming out, each day's issue will be filed here by month.",

  monthLabel: (month) => `${MONTH_EN[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
  weekday: (w) => WEEKDAY_EN[w] ?? w,
  // 空档不跨月（missingRuns 的约定），月份取 run.from 就够："Oct 4–6 · 3 days"，单日 "Oct 5 · 1 day"。
  runLabel: (run) =>
    run.days > 1
      ? `${MONTH_EN[Number(run.from.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(run.from.slice(8, 10))}–${Number(run.to.slice(8, 10))} · ${run.days} days`
      : `${MONTH_EN[Number(run.from.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(run.from.slice(8, 10))} · 1 day`,
  issueFallback: (key) => `Daily brief ${key}`,
  countUnit: " events",
};

export const copy = { zh, en } as const;
