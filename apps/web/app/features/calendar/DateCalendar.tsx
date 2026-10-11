// 日期入口：一张月历，点某一天就进那一天。
//
// 为什么要有它：`/all` 只能翻到最近 2,000 条（50 页 × 40，`POOL_MAX_PAGES`），而站上可列的条目早已是
// 好几千条（2026-10-11 实测 7,867 条，10 月一个月占 6,356）——一月到九月的内容搜索与条目 URL 都到得了，
// 唯独没有"从日期进去"的路。日历把一天变成入口之后，一天最多几百条，永远在那条上限之内。
// 站长 2026-10-11 给的形状就是这张卡：左边沿用日报报眼那套（期号 + 半调点阵的大日期 + 星期），右边是月历点阵。
//
// 点的大小是**信息不是装饰**：一天几条和一天上百条不该画成同一个点（`dotTier`）。
// 没有内容的日子不给链接——不画一个点了不会动的东西（与空白期次不进任何出口是同一条规矩）。
import { Link } from "react-router";
import { beijingWeekday } from "../../lib/format";
import { Halftone } from "../report/Halftone";
import { WEEKDAYS, calendarCells, dotTier, shiftMonth } from "./grid";

export interface CalendarDay {
  date: string;
  /** 那一天可列出的条目数。0 表示那一天没有内容（这样的日子不画成链接）。 */
  items: number;
  /** 那一天出的日报期号；没出报为 null。 */
  issue: number | null;
}

// 断点用 `lg:` 而不是 `@[760px]:`：容器查询只对**祖先**声明了 `container-type` 的元素生效，而这张卡挂在
// `/all` 的正文流里，那里没有 `@container`（全站只有 `ReportPaper` 和日报档案页自己声明）。写成容器查询
// 会得到一张"桌面端永远是手机版"的卡——1440 实测两栏叠成一栏、选中圈被拉成 214×44 的胶囊。
const MONTH_CN = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
/** 三档点径 + 第 0 档（空位）由调用方单独画。 */
const DOT_SIZE = ["", "h-1.5 w-1.5", "h-2 w-2", "h-2.5 w-2.5"];
const CELL = "grid h-11 place-items-center lg:h-9";
/** 命中框固定 44×44：只包一个字形会被压成 6px 宽（390 实测），拉满格子又会让选中圈变成扁胶囊。 */
const NAV_CELL = "grid h-11 w-11 place-items-center lg:h-9 lg:w-9";

/**
 * 月历卡。`dayHref(date)` 决定点某一天去哪里（`/all?date=` 或 `/daily/<date>`），
 * `monthHref(month)` 决定 ‹ › 与「回到本月」去哪里。`unit` 只影响右上那句计数（本月 N 期 / N 条）。
 */
export function DateCalendar({ month, days, selected, today, dayHref, monthHref, unit, className = "" }: {
  month: string;
  days: CalendarDay[];
  selected: string | null;
  today: string;
  dayHref: (date: string) => string;
  monthHref: (month: string) => string;
  unit: "期" | "条";
  className?: string;
}) {
  const byDate = new Map(days.filter((d) => d.items > 0 || d.issue !== null).map((d) => [d.date, d]));
  const [year, number] = month.split("-").map(Number);
  const thisMonth = today.slice(0, 7);
  const focus = selected ?? (month === thisMonth ? today : null);
  const focusDay = focus ? byDate.get(focus) : undefined;
  // 「本月 N 期」数的是出过报的天数，「本月 N 条」数的是条目总数——同一张卡两种单位，别混着报。
  const total = unit === "期" ? days.reduce((n, d) => n + (d.issue !== null ? 1 : 0), 0) : days.reduce((n, d) => n + d.items, 0);
  const nav = (to: string, label: string, glyph: string, disabled: boolean) => (disabled
    // 未来的月份不给箭头：点进去是一张全空的月历，那是"坏了"的样子，不是"还没有"的样子。
    ? <span aria-hidden="true" className={`${NAV_CELL} text-[16px] text-ink-4/40`}>{glyph}</span>
    : <Link to={monthHref(to)} aria-label={label} title={label}
        className={`${NAV_CELL} rounded-full text-[16px] leading-none text-ink-3 transition-colors hover:bg-bg-sunk hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}>
        {glyph}
      </Link>);

  return (
    <nav aria-label="按日期浏览" className={`well flex max-w-[720px] flex-col items-stretch rounded-panel p-3 lg:flex-row lg:p-0 ${className}`}>
      <div className="flex shrink-0 flex-col items-center justify-center gap-1 border-b border-line pb-3 text-center lg:w-[152px] lg:border-b-0 lg:px-3 lg:py-4">
        {focusDay?.issue
          ? <span className="text-label tracking-[0.2em] text-ink-4">第 {focusDay.issue} 期</span>
          : <span className="text-label tracking-[0.2em] text-ink-4">{focus ? `${Number(focus.slice(8, 10))} 日` : "本月"}</span>}
        {focus && (
          <Halftone seed={`calendar-${focus}`} className="num whitespace-nowrap text-[40px] font-black leading-[0.95] tracking-[-0.04em] text-ink lg:text-[54px]">
            {String(Number(focus.slice(8, 10)))}
          </Halftone>
        )}
        <p className="text-[11.5px] text-ink-2">{year} 年 {number} 月{focus ? ` · ${beijingWeekday(focus)}` : ""}</p>
        {focusDay?.items ? <p className="text-[11.5px] text-ink-4">当天 <span className="num">{focusDay.items}</span> 条</p> : null}
        <div className="mt-1 flex items-center gap-0.5">
          {nav(shiftMonth(month, -1), "上一个月", "‹", false)}
          {nav(shiftMonth(month, 1), "下一个月", "›", month >= thisMonth)}
          {month !== thisMonth && (
            <Link to={monthHref(thisMonth)} className="ml-1 grid h-11 min-w-9 place-items-center rounded-full px-2 text-[11.5px] text-ink-3 transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:h-9">
              回到本月
            </Link>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 pt-3 lg:border-l lg:border-line lg:px-4 lg:py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-semibold tracking-[0.2em] text-ink">{MONTH_CN[number - 1]}</span>
          <span className="text-[11.5px] text-ink-4">本月 <span className="num">{total}</span> {unit}</span>
        </div>
        <ul className="mt-1 grid grid-cols-7 text-center text-[10.5px] text-ink-4">
          {WEEKDAYS.map((w) => <li key={w} aria-hidden="true">{w}</li>)}
        </ul>
        <ul className="mt-0.5 grid grid-cols-7">
          {calendarCells(month).map((cell, i) => {
            if (!cell.date) return <li key={`blank-${i}`} aria-hidden="true" className={CELL} />;
            const mark = byDate.get(cell.date);
            const isToday = cell.date === today;
            const isSelected = cell.date === selected;
            // aria-current 只认 page/step/location/date/time——"today" 不是合法值（类型检查会拒）。
            // 日历里"今天"和"正在看的那一天"都用 date：前者是日历的当前日，后者靠文字说清楚。
            const label = `${number} 月 ${cell.day} 日 · ${mark ? `${mark.items ? `${mark.items} 条` : "没有可列条目"}${mark.issue ? ` · 第 ${mark.issue} 期` : ""}` : "没有内容"}${isSelected ? "（正在看这一天）" : isToday ? "（今天）" : ""}`;
            if (!mark) {
              // 空位画一颗更淡的小点：整张月历的"哪天没东西"要看得出来，但它不是链接。
              return (
                <li key={cell.date} className={CELL}>
                  <span className="grid h-11 w-11 place-items-center lg:h-9 lg:w-9" title={label}>
                    <span className="h-1 w-1 rounded-full bg-line-strong" />
                    <span className="sr-only">{label}</span>
                  </span>
                </li>
              );
            }
            const lit = isSelected || isToday;
            return (
              <li key={cell.date} className={CELL}>
                <Link to={dayHref(cell.date)} title={label} aria-label={label}
                  aria-current={isToday || isSelected ? "date" : undefined}
                  className={`group relative grid h-11 w-11 place-items-center rounded-full transition-colors hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:h-9 lg:w-9 ${isSelected ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""}`}>
                  {/* 出了报却一条可列内容都没有的日子（空白期次）也要看得见：给它最小一档，否则它是个隐形的链接。 */}
                  <span aria-hidden="true" className={`rounded-full transition-all ${DOT_SIZE[dotTier(mark.items || (mark.issue ? 1 : 0))]} ${lit ? "bg-accent" : "bg-ink"} group-hover:scale-[2.6] group-focus-visible:scale-[2.6]`} />
                  {/* 数字平时不占版面（站长那张图就是只有点），悬停/聚焦时点亮成一枚带日期的圆片。 */}
                  <span className="pointer-events-none absolute inset-0 grid scale-0 place-items-center rounded-full bg-accent text-[10.5px] font-semibold text-paper transition-transform group-hover:scale-100 group-focus-visible:scale-100">
                    {cell.day}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
