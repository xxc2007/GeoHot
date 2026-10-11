// 日历的算术要有自己的用例：它错一格，读者点到的就不是他看到的那一天。
//
// 中文日历第一列是周一，不是美式日历的周日——这一条最容易"看起来对"，因为 2026-10-01 恰好是周四，
// 两种习惯下都会画在中间某处，只有整月点位的对应关系不同。
import assert from "node:assert/strict";
import { test } from "node:test";
import { WEEKDAYS, calendarCells, daysInMonth, dotTier, firstColumn, shiftMonth } from "../app/features/calendar/grid.ts";

test("月历从周一开始排，前后补空凑满整周", () => {
  assert.deepEqual([...WEEKDAYS], ["一", "二", "三", "四", "五", "六", "日"]);
  // 2026-10-01 是星期四 → 前面补三格（周一/二/三）。
  assert.equal(firstColumn("2026-10"), 3);
  const cells = calendarCells("2026-10");
  assert.equal(cells.length % 7, 0, "末行不许缺格，否则 CSS 网格会把最后一周拉歪");
  assert.equal(cells[3]!.date, "2026-10-01");
  assert.equal(cells[0]!.date, null);
  assert.equal(cells.filter((c) => c.date).length, 31);
  // 3 格补头 + 31 天 = 34，补到整周是 35：末尾那一格是空的，不是 31 号。
  assert.equal(cells.length, 35);
  assert.equal(cells.filter((c) => c.date).at(-1)!.date, "2026-10-31");
  assert.equal(cells.at(-1)!.date, null);
});

test("月份天数与跨年挪月都按日历算，不靠字符串加减", () => {
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29, "闰年二月");
  assert.equal(daysInMonth("2026-04"), 30);
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-03", -2), "2026-01");
  assert.equal(shiftMonth("2026-05", 0), "2026-05");
});

test("点的大小分档贴着「几条 / 上百条」这条线，0 条不给点", () => {
  assert.equal(dotTier(0), 0);
  assert.equal(dotTier(1), 1);
  assert.equal(dotTier(9), 1);
  assert.equal(dotTier(10), 2);
  assert.equal(dotTier(49), 2);
  assert.equal(dotTier(50), 3);
});
