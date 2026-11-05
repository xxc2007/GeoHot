// 「读完一整行只有标签」的那种行，读者不该在列表里看到它，点进去却 404。
// 两个判据必须同一张：JS 的 isLabelOnlyCopy（detail / og / pool）与 SQL 的 LABEL_ONLY_COPY_PATTERN
// （列表、RSS、搜索、站点地图的 chineseCopyCondition）。这里把两张判据钉在一起。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_ONLY_COPY_PATTERN, isLabelOnlyCopy } from "@aihot/contracts/copy";
import { isPoolEligible } from "@aihot/backend/publication/rules";

const sql = new RegExp(LABEL_ONLY_COPY_PATTERN);
const SAMPLE = [
  "summary_zh:",
  "title_zh: ",
  "**body_zh**：  ",
  "summary_zh：\t",
  "title_zh: 南极洲末端微生物隐藏生物多样性",
  "本期摘要：南极冰盖下的湖泊",
  "",
];

test("标签行：JS 与 SQL 两张判据对同一批样例行给出同一答案", () => {
  for (const line of SAMPLE) {
    assert.equal(isLabelOnlyCopy(line), sql.test(line.trim()), `两张判据在 ${JSON.stringify(line)} 上不一致`);
  }
  // 只有"整行只有标签"才算；带内容的标签不是空稿。
  assert.equal(isLabelOnlyCopy("summary_zh: 南极冰盖下的湖泊"), false);
  assert.equal(isLabelOnlyCopy("**body_zh**：  "), true);
  assert.equal(isLabelOnlyCopy("本期摘要：南极冰盖下的湖泊"), false);
});

test("入池判据：标题或摘要是标签行的条目不进 /all（与详情页 404 同一张门）", () => {
  const base = { participationMode: "editorial", relevance: "pass" };
  assert.equal(isPoolEligible({ ...base, title: "南极洲末端微生物隐藏生物多样性", summary: "南极冰盖下的湖泊里有..." }), true);
  assert.equal(isPoolEligible({ ...base, title: "title_zh:", summary: "南极冰盖下的湖泊里有..." }), false);
  assert.equal(isPoolEligible({ ...base, title: "南极洲末端微生物隐藏生物多样性", summary: "summary_zh:" }), false);
  // 没有摘要的条目本来就不入池（hasSummary 是既有判据），这里只确认标签行不会挤进来。
  assert.equal(isPoolEligible({ ...base, title: "南极洲末端微生物隐藏生物多样性", summary: null }), false);
});