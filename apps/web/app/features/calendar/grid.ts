// 日历的算术：一个月摆成"一二三四五六日"的格子。
//
// 单独一个文件、只放纯函数，是为了能被用例跑到：`apps/web/tests/` 里没有 react-dom/server 那条路，
// 组件里的条件渲染只能靠"把判断下沉成可测函数"来钉（工单 #93 第 ② 条选的就是这条路）。
// 周日起头是美式日历，本站是中文站、读者看到的是"一 二 三 四 五 六 日"，所以第一列必须是周一。

export const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export interface CalendarCell {
  /** 这一格是哪一天（`YYYY-MM-DD`）；月外补空时为 null。 */
  date: string | null;
  /** 月内的第几天（1…31）；空格为 null。 */
  day: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 这个月的天数（含闰年二月）。 */
export function daysInMonth(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

/** 该月 1 号在"周一开头"的日历里第几列（0…6）。 */
export function firstColumn(month: string): number {
  const [year, number] = month.split("-").map(Number);
  // JS 的 getDay() 以周日为 0；中文日历以周一为第一列，所以周日要落到最后一列。
  const jsDay = new Date(Date.UTC(year, number - 1, 1)).getUTCDay();
  return (jsDay + 6) % 7;
}

/** 上一月 / 下一月的 `YYYY-MM`（跨年正确）。 */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number);
  const zero = year * 12 + (number - 1) + by;
  return `${String(Math.floor(zero / 12)).padStart(4, "0")}-${pad((zero % 12 + 12) % 12 + 1)}`;
}

/**
 * 一张月历：前面补空到周一开头，后面补空凑满整周——格子数永远是 7 的倍数，
 * 这样 CSS 网格不会因为末行缺格而把最后一周拉歪。
 */
export function calendarCells(month: string): CalendarCell[] {
  const lead = firstColumn(month);
  const days = daysInMonth(month);
  const cells: CalendarCell[] = Array.from({ length: lead }, () => ({ date: null, day: null }));
  for (let day = 1; day <= days; day += 1) cells.push({ date: `${month}-${pad(day)}`, day });
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
  return cells;
}

/** 点的大小分档：一天几条与一天上百条不该画成同一个点。0 条是"没出"的空位。 */
export function dotTier(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count < 10) return 1;
  if (count < 50) return 2;
  return 3;
}
