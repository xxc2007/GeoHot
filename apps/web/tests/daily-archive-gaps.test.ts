// 归档为什么跳过日期：读取层把空刊藏起来（没人能读一张白页），于是 `/daily/archive` 从 10-02、10-03
// 直接跳到 10-07。站长两次把这段空白读成"同步坏了"。这两条把空白本身变成页面上的事实——
// `missingRuns` 只标两期之间的日子（最新一期之后可能是今天的稿样，最早一期之前是还没创刊），
// `neighbourLabel` 只有真的是前一天才说「前一日」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { missingRuns, neighbourLabel } from "../app/features/report/format.ts";

const idx = (...keys: string[]) => keys.map((key) => ({ key, count: 1 }));

test("空档按连续天数成段，新在前", () => {
  assert.deepEqual(missingRuns(idx("2026-10-07", "2026-10-03", "2026-10-02")), [
    { from: "2026-10-04", to: "2026-10-06", days: 3, month: "2026-10" },
  ]);
});

test("连着出刊就没有空档；单单一期也无话可说", () => {
  assert.deepEqual(missingRuns(idx("2026-10-07", "2026-10-06", "2026-10-05")), []);
  assert.deepEqual(missingRuns(idx("2026-10-07")), []);
  assert.deepEqual(missingRuns([]), []);
});

test("空档不跨月：月末与月初各成一段", () => {
  assert.deepEqual(missingRuns(idx("2026-11-02", "2026-10-30")), [
    { from: "2026-11-01", to: "2026-11-01", days: 1, month: "2026-11" },
    { from: "2026-10-31", to: "2026-10-31", days: 1, month: "2026-10" },
  ]);
});

test("最新一期之后与最早一期之前的日子不标未出刊", () => {
  // 10-08 那期可能还在窗口里；10-01 之前这份报纸还没创刊。
  assert.deepEqual(missingRuns(idx("2026-10-07", "2026-10-05")), [{ from: "2026-10-06", to: "2026-10-06", days: 1, month: "2026-10" }]);
});

test("前后日报：真的是前一天才说「前一日」", () => {
  assert.equal(neighbourLabel("daily", "2026-10-03", "2026-10-02", "prev"), "前一日 · 10月2日");
  assert.equal(neighbourLabel("daily", "2026-10-03", "2026-10-04", "next"), "后一日 · 10月4日");
  // 归档里 10-07 的前一个可读期次是 10-03：跳四天的链接不能自称前一天。
  assert.equal(neighbourLabel("daily", "2026-10-07", "2026-10-03", "prev"), "上一期 · 10月3日");
  assert.equal(neighbourLabel("daily", "2026-10-02", "2026-10-07", "next"), "下一期 · 10月7日");
});

test("周报月报的邻居仍按期次称呼", () => {
  assert.equal(neighbourLabel("weekly", "2026-W40", "2026-W39", "prev"), "上一期 · 第 39 周");
  assert.equal(neighbourLabel("monthly", "2026-10", "2026-09", "prev"), "上一期 · 9 月");
});

// 报眼月历的「本月 N 期」：数的是索引里真有的期次，不是格子的状态。
test("空刊那一期的月历不把自已数进去", async () => {
  const { periodGrid } = await import("../app/features/report/format.ts");
  const index = idx("2026-10-08", "2026-10-07", "2026-10-03", "2026-10-02");
  // 指名点开 10-04（白页）时，它自己是 current 但不在索引里：数状态会得到 5，
  // 而 /daily/archive、/about、/api/site/stats 都说 4 —— 一个事实两个答案。
  assert.equal(periodGrid("daily", "2026-10-04", index).note, "本月 4 期");
  assert.equal(periodGrid("daily", "2026-10-08", index).note, "本月 4 期", "正常一期也要数同一个数");
  // 同一期的点格提示：报眼已经写着「本期未出刊」，格子上却只报日期，等于同一页两个答案。
  const cells = periodGrid("daily", "2026-10-04", index).cells;
  assert.match(cells.find((c) => c.key === "2026-10-04")!.label, /未出刊$/, "正在读的空刊那一天也说「未出刊」");
  assert.equal(cells.find((c) => c.key === "2026-10-04")!.state, "current", "它仍然是读者在看的那一期");
  assert.doesNotMatch(cells.find((c) => c.key === "2026-10-03")!.label, /未出刊/, "索引里有的那一天不该被说成没出刊");
});
