// Names, dates and grouping for daily, weekly and monthly reports.
import { withSubject } from "@aihot/industry/site";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import type { ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { beijingWeekday, addDays } from "@aihot/contracts/time";
import { localeAppPath, type Locale } from "../../lib/i18n.ts";
import { copy, MONTHS_EN, MONTHS_EN_FULL, WEEKDAYS_EN } from "../../lib/i18n/report.ts";

/** 版面词表按页面语言取（lib/i18n/report.ts）；locale 缺省 zh，中文输出与 i18n 之前逐字相同。 */
const words = (locale: Locale) => copy[locale];

export const KINDS: ReportKind[] = ["daily", "weekly", "monthly"];
export const KIND_PATH: Record<ReportKind, string> = { daily: "/daily", weekly: "/weekly", monthly: "/monthly" };
/** 中文素名只服务 absentCopy（错误页四句，中文版仍从这里拼行业词）；页签与版面请用 report.ts 词表。 */
export const KIND_LABEL: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };

/** Which report tab a location belongs to, whatever prefix the site is deployed under.
 *  The caller hands us the raw request path, so under a sub-path deployment it is `/geohot/weekly`,
 *  and a bare `startsWith("/weekly")` silently fell through to the daily paper. Matching a whole path
 *  segment keeps this correct without depending on a build-time base path being present in the server
 *  bundle — a first attempt using `appPath()` still resolved to the daily paper in production. */
export function kindFromPath(pathname: string): ReportKind {
  // React Router client transitions request `/weekly.data` from the same loader.
  const segments = pathname.replace(/\.data$/, "").split("/").filter(Boolean);
  if (segments.includes("weekly")) return "weekly";
  if (segments.includes("monthly")) return "monthly";
  return "daily";
}

/** 某一期报纸的站内地址。带 locale 时加语言前缀：/en 页的页签、往期与点阵链接若不带前缀，
 *  读者一点就落回中文页（2026-11-22 第 2 轮验收：/en/daily 点头条落入 /items）。 */
export function reportPath(kind: ReportKind, key: string, locale?: Locale): string {
  const path = `${KIND_PATH[kind]}/${key}`;
  return locale ? localeAppPath(path, locale) : path;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Monday and Sunday (YYYY-MM-DD) of an ISO week key such as 2026-W38. */
export function isoWeekRange(key: string): [string, string] {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
  return [ymd(monday), ymd(new Date(monday.getTime() + 6 * 86400000))];
}

/** First and last day of a month key such as 2026-08. */
export function monthRange(key: string): [string, string] {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return [`${key}-01`, ymd(new Date(Date.UTC(y, m, 0)))];
}

/** "这一天的 4 件地理大事" / "本周的 12 件地理大事" / "8 月的 20 件地理大事"；英文同位置换词。 */
export function headline(kind: ReportKind, key: string, count: number, locale: Locale = "zh"): string {
  return words(locale).headline(kind, Number(key.slice(5, 7)), count);
}

/** "09.16" for a story inside a week or month. */
export function shortDay(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600000);
  return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** Month-day label of a daily key: "9月26日" / "Sep 26". */
export function dayLabel(key: string, locale: Locale = "zh"): string {
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return locale === "en" ? `${MONTHS_EN[m - 1]} ${d}` : `${m}月${d}日`;
}

/**
 * The section's name in the page head. The vocabulary pack's `section` is only two or three characters
 * (学科 / 技术 / 实践) because several categories share one section; a paper's page head has to say which
 * categories it holds, so the full name is built from them (自然地理＋人文地理＋区域地理 → 自然・人文・区域
 * 地理). The pack itself is not edited here — for a longer section name, ask whoever owns the vocabulary.
 * Upstream sets 模型发布/更新、行业动态、论文研究、技巧与观点 in this slot, all of them full names.
 */
function sharedSuffix(words: string[]): string {
  let suffix = "";
  for (let i = 1; i <= Math.min(...words.map((w) => w.length - 1)); i++) {
    const tail = words[0]!.slice(-i);
    if (!words.every((w) => w.endsWith(tail))) break;
    suffix = tail;
  }
  return suffix;
}
const SECTION_HEADINGS: Record<string, string> = Object.fromEntries(
  [...new Set(CATEGORIES.map((c) => c.section))].map((section) => {
    const labels = CATEGORIES.filter((c) => c.section === section).map((c) => c.label);
    const suffix = labels.length > 1 ? sharedSuffix(labels) : "";
    return [section, suffix ? `${labels.map((l) => l.slice(0, l.length - suffix.length)).join("・")}${suffix}` : labels.join("・")];
  }),
);
/** A section's page head; a weekly or monthly theme heading is the editor's own words and stays as it is. */
const SECTION_HEADINGS_EN: Record<string, string> = {
  "学科": "Earth & human geography",
  "技术": "Geospatial technology",
  // 成刊时没有分类的条目落在这一节（reports/compose.ts 的 DEFAULT_SECTION）。它是网站印的
  // 版面词，不是编辑自写的主题标题——漏了这一行，英文日报的分节标题就混着一个「未归类」。
  "未归类": "Uncategorised",
};
export function sectionHeading(label: string, locale: Locale = "zh"): string {
  // 英文页：版面分节名是网站自己印的 chrome，随语言取词；编辑自写的主题标题原样保留。
  if (locale === "en") return SECTION_HEADINGS_EN[label] ?? label;
  return SECTION_HEADINGS[label] ?? label;
}

/**
 * When an issue's copy is due: a daily for day D gathers [D-1 08:00, D 08:00) and closes at D 08:00, a
 * weekly or monthly at 08:00 on the day after the period it covers. A compose run earlier than this
 * leaves an issue keyed a day ahead of the reader's clock, whose window is still open.
 */
export function dueAt(kind: ReportKind, key: string): number {
  if (kind === "daily") return Date.parse(`${key}T08:00:00+08:00`);
  const last = kind === "weekly" ? isoWeekRange(key)[1] : monthRange(key)[1];
  return Date.parse(`${last}T08:00:00+08:00`) + 86_400_000;
}
/** Whether the issue's window has closed: a published edition, as opposed to a proof of one. */
export function isDue(kind: ReportKind, key: string, now: number): boolean {
  return dueAt(kind, key) <= now;
}

const COUNT_LINE = /^本期共?\s*(\d+)\s*条([^：:。；\d]{0,12})[：:]/;/**
 * The lead's opening count has to be one the paper can back. The stub lead (and any model echoing the
 * brief it was handed) writes 本期共 N 条入选动态： and then names fewer than N, so the front page printed
 * a number its own sentence contradicted. `total` is what this issue actually carries on the page: the
 * sentence is rewritten to agree with it, and the count is dropped when no agreement can be reached.
 */
export function leadCountLine(text: string, total: number): string {
  const m = COUNT_LINE.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  const named = rest.split(/[。；;]/).filter((s) => s.trim() !== "").length;
  const noun = m[2] ?? "";
  if (named === total && Number(m[1]) === total) return text;
  if (named === 0) return rest.trim(); // 冒号后什么都没有：宁可不出这段导语，也不留一句数不上来的计数
  if (named < total) return `本期共 ${total} 条${noun}，择要 ${named} 条：${rest}`;
  return `本期${noun}：${rest}`;
}

/**
 * 「本期导读」这道眉标下面没有导读时要说一声。2026-10-17 实测 weekly 2026-W12/W16/W21/W30 与 monthly
 * 2026-04 就是这样：眉标照印、标题走机械兜底（headline()），总述那一块整块不渲染，读者看不出是"没写"
 * 还是"这里本来就没有"。措辞跟条目页那句同型（这一条还没有中文稿：……）——只报当前状态和读者现在
 * 能看到什么，不承诺"稍后就有"：这几期重排两次，拿到的是同一份不可用的答复。
 * 措辞按 kind 分叉：库里另有 9 期日报既没有 leadParagraph 也没有 overview，而日报那一块眉标是「头条」、
 * 印的是「导语」，不能对读者说"这一期还没有总述"。
 */
export function leadAbsentNote(kind: ReportKind, locale: Locale = "zh"): string {
  return kind === "daily" ? words(locale).leadAbsent.daily : words(locale).leadAbsent.other;
}


export interface ArchiveGroup {
  id: string;
  label: string;
  entries: Array<ReportNavigationEntry & { short: string }>;
}

/**
 * The archive column: days grouped by month, weeks by their Monday's month with a stable ISO week label,
 * months by year. Newest first, as the index comes.
 */
export function archiveGroups(kind: ReportKind, index: ReportNavigationEntry[], locale: Locale = "zh"): ArchiveGroup[] {
  const w = words(locale);
  const groups: ArchiveGroup[] = [];
  const push = (id: string, label: string, e: ReportNavigationEntry & { short: string }) => {
    const g = groups[groups.length - 1];
    if (g && g.id === id) g.entries.push(e);
    else groups.push({ id, label, entries: [e] });
  };
  if (kind === "weekly") {
    for (const e of index) {
      const m = isoWeekRange(e.key)[0].slice(0, 7);
      push(m, w.yearMonth(m.slice(0, 4), Number(m.slice(5))), { ...e, short: w.weekShort(Number(e.key.slice(-2))) });
    }
    return groups;
  }
  for (const e of index) {
    if (kind === "daily") push(e.key.slice(0, 7), w.yearMonth(e.key.slice(0, 4), Number(e.key.slice(5, 7))), { ...e, short: w.dayShort(Number(e.key.slice(8, 10))) });
    else push(e.key.slice(0, 4), w.year(e.key.slice(0, 4)), { ...e, short: w.monthShort(Number(e.key.slice(5, 7))) });
  }
  return groups;
}

/** A stretch of consecutive days the archive holds no readable edition for, inside one month. */
export interface MissingRun {
  from: string;
  to: string;
  days: number;
  /** Month key (`YYYY-MM`) this run is filed under; runs never straddle a month. */
  month: string;
}

const packRun = (days: string[]): MissingRun => ({ from: days[0]!, to: days[days.length - 1]!, days: days.length, month: days[0]!.slice(0, 7) });

/**
 * The days between two printed issues that have no issue. The read layer drops a blank edition (nobody
 * can read an empty paper), which leaves a date-keyed archive printing 2 日、3 日、7 日 and every reader
 * working out for themselves whether the sync broke — an absence in a daily is a fact about the paper,
 * so it goes on the page. Only the span between the oldest and the newest printed issue is marked: a day
 * after the newest one may still be today's proof, and the days before the first one are the paper not
 * having started yet.
 */
export function missingRuns(index: ReportNavigationEntry[]): MissingRun[] {
  const keys = index.map((e) => e.key).sort((a, b) => a.localeCompare(b));
  const runs: MissingRun[] = [];
  for (let i = 1; i < keys.length; i++) {
    let run: string[] = [];
    // ISO date strings compare correctly as text, so this stops at the next printed issue.
    for (let day = addDays(keys[i - 1]!, 1); day < keys[i]!; day = addDays(day, 1)) {
      if (run.length && day.slice(0, 7) !== run[0]!.slice(0, 7)) {
        runs.push(packRun(run));
        run = [];
      }
      run.push(day);
    }
    if (run.length) runs.push(packRun(run));
  }
  return runs.reverse();
}
export function archiveMark(kind: ReportKind, key: string, locale: Locale = "zh"): { big: string; small: string | null } {
  if (kind === "daily") {
    // 报头星期：中文「周六」，英文「Sat」（lib/i18n/report.ts 的 WEEKDAYS_EN，同一份词）。
    const small = locale === "en" ? WEEKDAYS_EN[new Date(`${key}T00:00:00Z`).getUTCDay()]! : beijingWeekday(key).replace("星期", "周");
    return { big: key.slice(8, 10), small };
  }
  if (kind === "weekly") {
    const start = isoWeekRange(key)[0];
    return { big: key.slice(6), small: words(locale).markFrom(`${Number(start.slice(5, 7))}.${Number(start.slice(8, 10))}`) };
  }
  return { big: key.slice(5, 7), small: null };
}

/**
 * Short chip label for the phone switcher: "今天", "9月26日", "9月第2周", "8 月".
 * 今天 is only ever the day's closed edition: an issue whose window is still open carries tomorrow's key
 * and must not borrow today's name. `now` is the reader's clock; without it (the archive page, which has
 * no clock of its own) the date alone decides, and a key after today never reads 今天 either way.
 */
export function chipLabel(kind: ReportKind, key: string, index: ReportNavigationEntry[], today: string, now?: number, locale: Locale = "zh"): string {
  const w = words(locale);
  if (kind === "daily") {
    if (key === today && (now === undefined || isDue(kind, key, now))) return locale === "en" ? "Today" : "今天";
    return dayLabel(key, locale);
  }
  if (kind === "monthly") return w.monthShort(Number(key.slice(5, 7)));
  const group = archiveGroups("weekly", index).find((g) => g.entries.some((e) => e.key === key));
  if (!group) return key;
  const month = Number(group.id.slice(5));
  const week = Number(key.slice(-2));
  // 中文连读「9月第2周」；英文「Sep week 2」。周号取自期键，组只用来确认它属于这一格。
  return locale === "en" ? `${MONTHS_EN[month - 1]} ${w.weekShort(week)}` : `${month}月${w.weekShort(week)}`;
}

/**
 * "第 N 期": the number the read layer stamped on the issue when it was published (`reports.issue_no`,
 * migration 0048). Stamping at publication — rather than counting back from the pages' index window —
 * is what lets the number go missing for honest reasons only: a blank issue never consumed one, and an
 * issue that is not in `index` at all (older than the newest-400 window) gets no number here. Neither
 * case ever renumbers the rest of the series.
 */
export function issueNumber(index: ReportNavigationEntry[], key: string): number | null {
  return index.find((e) => e.key === key)?.no ?? null;
}

/** The masthead's date block: a large figure and two small lines beside it（星期随 locale：周六 / Sat）. */
export function dateMark(kind: ReportKind, key: string, locale: Locale = "zh"): { figure: string; top: string; bottom: string } {
  const w = words(locale);
  if (kind === "daily") {
    return {
      figure: key.slice(8, 10),
      top: w.dailyTop(key.slice(0, 4), Number(key.slice(5, 7))),
      bottom: locale === "en" ? WEEKDAYS_EN[new Date(`${key}T00:00:00Z`).getUTCDay()]! : beijingWeekday(key),
    };
  }
  if (kind === "weekly") {
    const [a, b] = isoWeekRange(key);
    return { figure: key.slice(6), top: w.weekTop(key.slice(0, 4), Number(key.slice(6))), bottom: `${a.slice(5).replace("-", ".")} — ${b.slice(5).replace("-", ".")}` };
  }
  return { figure: key.slice(5, 7), top: w.yearTop(key.slice(0, 4)), bottom: w.monthBottom(Number(key.slice(5, 7))) };
}

/** The shape of each kind's issue key. Tighter than "four digits, a dash, two digits": month 13 and week 54
 *  are the same length but can never have a newspaper, so they belong with the other unreadable keys. */
export const REPORT_KEY_SHAPE: Record<ReportKind, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/,
  monthly: /^\d{4}-(?:0[1-9]|1[0-2])$/,
};

/**
 * Why a well-formed key has no edition to show: its window has closed and nothing was ever composed
 * (`no_edition`), or the window is still open (`not_yet`). A key like 2026-02-30 has no `dueAt` at all — that
 * is not "not yet", it is a day that will never come, so it is the first case.
 */
export function reportAbsentReason(kind: ReportKind, key: string, now: number): AbsentReason {
  if (!REPORT_KEY_SHAPE[kind].test(key)) return "bad_key";
  return Number.isFinite(dueAt(kind, key)) && !isDue(kind, key, now) ? "not_yet" : "no_edition";
}

/** When each kind comes out (F10), for the masthead：词在 lib/i18n/report.ts 的 edition，随 locale 取。 */

/** Why a report page has no newspaper to show. */
export type AbsentReason = "bad_key" | "no_edition" | "not_yet" | "unreadable";

/**
 * What to say when a report URL has no edition behind it — four sentences for four different facts, kept in
 * one place because one sentence for all four is a lie about at least three of them. The generic site-wide
 * 404 says 「内容已不再公开」, which claims this paper once published the page and took it back; that is true
 * of a retracted item and false of a day nothing was printed, of a window that has not closed, and of a
 * mistyped issue key. No publication times are quoted here on purpose: those live in the worker's cron and in
 * `EDITION`, and a third copy of a clock is how wording starts to disagree.
 */
export function absentCopy(kind: ReportKind, key: string, reason: AbsentReason, locale: Locale = "zh"): { title: string; body: string } {
  // 这几句话与「最近一期」「报告详情」的错误页说的是同一件事，报纸的名字要拼上行业词（地理日报），
  // 不能一边写「暂时读不到地理日报」一边写「暂时读不到这一期日报」。英文四句逐句对应。
  if (locale === "en") {
    const label = words("en").kindSubject[kind].toLowerCase();
    if (reason === "not_yet") {
      return { title: `“${key}” is not due out yet`, body: `The period this issue would cover has not ended, so no such edition of the ${label} exists here yet. The latest published edition is linked below.` };
    }
    if (reason === "no_edition") {
      return { title: `No edition for ${key}`, body: `This site published no ${label} for ${key} — not one taken down afterwards; the archive never had this issue. Try another date, or start from the latest edition.` };
    }
    if (reason === "bad_key") {
      return { title: "This issue key is not one we recognize", body: "Daily issue keys look like 2026-10-09, weekly keys like 2026-W40 and monthly keys like 2026-09. The segment in this address matches none of them — pick an issue from the archive page." };
    }
    return { title: `This edition of the ${label} cannot be read right now`, body: "The service did not return the data this page needs, so we cannot yet tell whether this issue was published. Try again in a few seconds." };
  }
  const label = withSubject(KIND_LABEL[kind]);
  if (reason === "not_yet") {
    return { title: `「${key}」还没到出刊时间`, body: `这一期要收录的那段时间还没有走完，所以本站没有${label}的这一版。已经出的那一期在这里。` };
  }
  if (reason === "no_edition") {
    return { title: `没有「${key}」这一期`, body: `${key} 这一段本站没有出过${label}——不是出过之后撤下，是存档里从来没有过这一期。换一天看看，或者从最近一期读起。` };
  }
  if (reason === "bad_key") {
    return { title: "这个期号本站认不出来", body: "日报的期号是 2026-10-09 这样，周报是 2026-W40，月报是 2026-09。地址里的这一段不属于任何一种，请从归档页挑一期。" };
  }
  return { title: `暂时读不到这一期${label}`, body: "服务没有给出这一页要用的数据，所以现在还不能说这一期出刊了没有。稍等几秒再试一次。" };
}

/** The masthead's figures, in the order a reader wants them; a zero release count is left out. 单位随 locale 取词。 */
const METRICS = ["totalEvents", "totalStories", "sourcesCount", "firstPartyEvents", "modelsReleased", "selectedCount", "reportsCovered"] as const;
export function metricItems(metrics: Record<string, number>, locale: Locale = "zh"): Array<{ value: number; unit: string }> {
  const units = words(locale).metricUnit;
  return METRICS.filter((k) => typeof metrics[k] === "number" && (k !== "modelsReleased" || metrics[k]! > 0)).map((k) => ({ value: metrics[k]!, unit: units[k]! }));
}

/** "前一日 · 9月25日" / "上一期 · 9月25日", "上一期 · 第 37 周", "下一期 · 7 月"；英文同位置换词. */
export function neighbourLabel(kind: ReportKind, current: string, key: string, direction: "prev" | "next", locale: Locale = "zh"): string {
  const w = words(locale);
  const which = direction === "prev" ? w.neighbourPrev : w.neighbourNext;
  if (kind === "monthly") return `${which} · ${w.monthBottom(Number(key.slice(5, 7)))}`;
  if (kind === "weekly") return locale === "en" ? `${which} · Week ${Number(key.slice(6))}` : `${which} · 第 ${Number(key.slice(6))} 周`;
  // 「前一日」是日期承诺，不是序号承诺：中间有空刊时邻居并不是前一天，写着「前一日」跳四天是指错路标。
  const adjacent = key === addDays(current, direction === "prev" ? -1 : 1);
  return `${adjacent ? (direction === "prev" ? w.neighbourPrevDay : w.neighbourNextDay) : which} · ${dayLabel(key, locale)}`;
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
/** Page numbers as a Chinese paper prints them: 1 → 一, 12 → 十二, 20 → 二十. */
export function cnNumber(n: number): string {
  if (n <= 10) return CN[n]!;
  if (n < 20) return `十${CN[n - 10]}`;
  return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ""}`;
}

/** The line above the nameplate: "2026 年 9 月 26 日 · 星期六" / "September 26, 2026 · Sat", "2026 年第 38 周 ·
 *  09.14 — 09.20", "2026 年 8 月" / "August 2026". */
export function dateLine(kind: ReportKind, key: string, locale: Locale = "zh"): string {
  if (locale === "en") {
    if (kind === "daily") return `${MONTHS_EN_FULL[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}, ${key.slice(0, 4)} · ${WEEKDAYS_EN[new Date(`${key}T00:00:00Z`).getUTCDay()]!}`;
    if (kind === "weekly") return `${dateMark(kind, key, locale).top} · ${dateMark(kind, key, locale).bottom}`;
    return `${MONTHS_EN_FULL[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  }
  const m = dateMark(kind, key);
  if (kind === "daily") return `${m.top} ${Number(key.slice(8, 10))} 日 · ${m.bottom}`;
  return kind === "weekly" ? `${m.top} · ${m.bottom}` : `${m.top} ${m.bottom}`;
}

/** What each kind is, under its nameplate：词在 lib/i18n/report.ts 的 motto，随 locale 取。 */

export interface PeriodCell {
  key: string | null;
  /** Hover text: "9月26日 · 第 158 期". */
  label: string;
  state: "current" | "issue" | "none" | "pad";
}

/** ISO week number of a date (YYYY-MM-DD). */
function isoWeek(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * 86400000);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1;
}

/**
 * The dot grid beside the date in the masthead: the days of this issue's month (dailies, Monday first),
 * the weeks of its year (weeklies) or the months of its year (monthlies), each marked as this issue,
 * an issue that exists, or none.
 */
export function periodGrid(kind: ReportKind, key: string, index: ReportNavigationEntry[], locale: Locale = "zh"): { title: string; note: string; columns: number; heads: string[] | null; cells: PeriodCell[] } {
  const w = words(locale);
  const exists = new Set(index.map((e) => e.key));
  const cell = (k: string, name: string): PeriodCell => {
    const state: PeriodCell["state"] = k === key ? "current" : exists.has(k) ? "issue" : "none";
    const n = issueNumber(index, k);
    // 未出刊 is for a day with no issue. A day that has one but cannot be numbered (see issueNumber) says
    // its date and nothing else — an unnumbered issue is not an issue that did not come out.
    // 正在读的这一期也要走同一句话：它不在 index 里就是空刊，报眼已经写着「本期未出刊」，
    // 点格子的提示不能反过来只报一个日期，好像这一天真有一份报纸。
    const blank = state === "current" && !exists.has(k);
    return { key: k, label: state === "none" || blank ? `${name} · ${w.cellNotOut}` : n ? `${name} · ${w.issueNo(n)}` : name, state };
  };
  // Counted from the index, not from the cell's state: the cell for the issue being read is "current"
  // whether or not it is a newspaper, so counting states would let a blank issue's own 报眼 claim one
  // edition more than /daily/archive, /about and /api/site/stats all say.
  const count = (cells: PeriodCell[]) => cells.filter((c) => c.key && exists.has(c.key)).length;
  const year = key.slice(0, 4);
  if (kind === "daily") {
    const m = Number(key.slice(5, 7));
    const days = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(Number(year), m - 1, 1)).getUTCDay() + 6) % 7;
    const cells: PeriodCell[] = [
      ...Array.from({ length: lead }, (): PeriodCell => ({ key: null, label: "", state: "pad" })),
      ...Array.from({ length: days }, (_, i) => cell(`${key.slice(0, 7)}-${pad(i + 1)}`, w.gridCellDay(m, i + 1))),
    ];
    return { title: locale === "en" ? w.gridTitle(m) : `${cnNumber(m)}月`, note: w.gridNote(count(cells)), columns: 7, heads: [...w.gridHeads], cells };
  }
  if (kind === "weekly") {
    const weeks = isoWeek(`${year}-12-28`);
    const cells = Array.from({ length: weeks }, (_, i) => {
      const k = `${year}-W${pad(i + 1)}`;
      const [a, b] = isoWeekRange(k);
      return cell(k, w.gridCellWeek(i + 1, a.slice(5).replace("-", "."), b.slice(5).replace("-", ".")));
    });
    return { title: w.yearTop(year), note: w.gridNoteYear(count(cells), year), columns: 13, heads: null, cells };
  }
  const cells = Array.from({ length: 12 }, (_, i) => cell(`${year}-${pad(i + 1)}`, w.gridCellMonth(i + 1)));
  return { title: w.yearTop(year), note: w.gridNoteYear(count(cells), year), columns: 6, heads: null, cells };
}
