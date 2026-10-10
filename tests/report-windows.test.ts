// 期次窗口的唯一定义。这里的红曾是读者可见的：`scripts/backfill-papers.ts` 自己算月末时写成
// Date.UTC(y, m + 1, 1) 而 m 已经是 1 起的月份号，于是补刊计划只排 01/03/05/07，
// 每个被排到的月份又横跨两个月。现在计划与 composePeriod 共用 monthlyWindow 这一个函数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { monthlyWindow } from "@aihot/backend/reports/compose";
import { addDays, beijingMidnight } from "@aihot/contracts/time";

const LAST_DAY: Record<string, string> = {
  "2026-01": "2026-01-31", "2026-02": "2026-02-28", "2026-03": "2026-03-31", "2026-04": "2026-04-30",
  "2026-05": "2026-05-31", "2026-06": "2026-06-30", "2026-07": "2026-07-31", "2026-08": "2026-08-31",
  "2026-09": "2026-09-30", "2026-10": "2026-10-31", "2026-11": "2026-11-30", "2026-12": "2026-12-31",
};

test("a monthly edition covers exactly its own calendar month, Beijing", () => {
  for (const [ym, last] of Object.entries(LAST_DAY)) {
    const w = monthlyWindow(ym);
    assert.equal(w.start, `${ym}-01`, `${ym} starts on the first`);
    assert.equal(w.end, last, `${ym} ends on ${last}`);
    // 这条就是 composePeriod 自己算的收尾时刻：计划器与出刊必须用同一个窗口。
    assert.deepEqual(w.closes, beijingMidnight(addDays(last, 1)), `${ym} closes at midnight after ${last}`);
  }
});

test("December closes on 1 January of the next year, and February knows a leap year", () => {
  assert.equal(monthlyWindow("2026-12").closes.toISOString(), "2026-12-31T16:00:00.000Z");
  assert.equal(monthlyWindow("2026-12").end, "2026-12-31");
  assert.equal(monthlyWindow("2028-02").end, "2028-02-29", "闰年 2 月是 29 天");
  assert.equal(monthlyWindow("2027-02").end, "2027-02-28");
});

test("a bad key is refused rather than silently becoming some other month", () => {
  for (const bad of ["2026-1", "2026-13", "2026-00", "20261", "2026"]) {
    assert.throws(() => monthlyWindow(bad), /bad month label/, `${bad} must not pass`);
  }
});
