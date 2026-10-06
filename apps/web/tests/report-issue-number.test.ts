// 报眼「第 N 期」读的是读取层盖在期上的号（`reports.issue_no`，迁移 0048），不是版面里的位次。
// 2026-10-07 之前这里是 `index.length - at` 的下标倒推：超过最新 400 期的窗口后号会先停再退，
// 代码只好在窗口满时整个隐去——一份办到第四百期就突然没有期号的报纸（见 docs/known-issues.md）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueNumber, periodGrid } from "../app/features/report/format.ts";

const INDEX = [
  { key: "2026-10-03", no: 2 },
  { key: "2026-10-02", no: 1 },
];

test("号来自盖在期上的字段，不来自位次", () => {
  assert.equal(issueNumber(INDEX, "2026-10-03"), 2);
  assert.equal(issueNumber(INDEX, "2026-10-02"), 1);
});

test("索引里有、但没有号的期，答案是「没有号」而不是猜一个", () => {
  assert.equal(issueNumber([{ key: "2026-10-02" }, { key: "2026-10-03", no: 2 }], "2026-10-02"), null);
});

test("不在索引窗口里的期同样没有号", () => {
  assert.equal(issueNumber(INDEX, "2020-01-01"), null);
});

test("月历格：有号的印号，无号只印日期，没有期的才是未出刊", () => {
  const grid = periodGrid("daily", "2026-10-03", INDEX);
  const cell = (k: string) => grid.cells.find((c) => c.key === k)!;
  assert.equal(cell("2026-10-03").label, "10月3日 · 第 2 期");
  assert.equal(cell("2026-10-02").label, "10月2日 · 第 1 期");
  assert.equal(cell("2026-10-04").label, "10月4日 · 未出刊");
  assert.equal(cell("2026-10-04").state, "none");
});

test("有期而无号：印日期与事实状态，不说未出刊", () => {
  const grid = periodGrid("daily", "2026-10-05", [
    { key: "2026-10-05", no: null },
    { key: "2026-10-04", no: 3 },
  ]);
  const cell = (k: string) => grid.cells.find((c) => c.key === k)!;
  assert.equal(cell("2026-10-05").label, "10月5日");
  assert.equal(cell("2026-10-05").state, "current");
  assert.equal(cell("2026-10-04").label, "10月4日 · 第 3 期");
});
