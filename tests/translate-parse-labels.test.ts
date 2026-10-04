// parseTranslateOutput 的边界：带标签但没有值的回答不是内容。
// 2026-10-03 实测（线上那个 stub 对没有人工稿件的中文材料正是这样回答的）：`title_zh: ` 这种空标签行
// 在没有其它内容时被兜底分支当成了标题，于是 analyses.title_zh 存下字符串「title_zh:」。
// 两处后果：114 行带着这个标记；而 analyze.ts 本来会在 title_zh 为空时回落到「来源自己的中文标题」，
// 那条回落因此永远没机会执行——这些条目进不了任何列表。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranslateOutput } from "@aihot/backend/editorial/writing";

test("空标签行不是内容：全部字段为空时返回空，而不是把标签当标题", () => {
  for (const text of ["title_zh: \nsummary_zh: ", "title_zh:\nsummary_zh:", "title_zh: \nsummary_zh: \nbody_zh: "]) {
    const p = parseTranslateOutput(text);
    assert.equal(p.titleZh, "", `「${JSON.stringify(text)}」不该产出标题（实际 ${JSON.stringify(p.titleZh)}）`);
    assert.equal(p.summaryZh, "");
    assert.equal(p.bodyZh, "");
  }
});

test("有标签也有值时照常解析", () => {
  const p = parseTranslateOutput("title_zh: 地震速报\nsummary_zh: 测定 5.2 级。");
  assert.equal(p.titleZh, "地震速报");
  assert.equal(p.summaryZh, "测定 5.2 级。");
});

test("没有标签的旧格式仍然按「首行标题、其余摘要」兜底", () => {
  const p = parseTranslateOutput("震中位于芦山县\n测定 5.8 级，深度 12 千米。\n多地有震感。");
  assert.equal(p.titleZh, "震中位于芦山县");
  assert.equal(p.summaryZh, "测定 5.8 级，深度 12 千米。\n多地有震感。");
});

test("标签后紧跟真实内容时，标签行不参与兜底拼接", () => {
  const p = parseTranslateOutput("title_zh:\n广西多地暴雨");
  assert.equal(p.titleZh, "广西多地暴雨", "空标签行不该被当成标题");
});

test("空摘要标签下的正文不会把标签带进摘要，也不会重复一遍", () => {
  // 独立审计（AUDIT-r8 m3）实测的形状：标题有值、摘要标签空着、正文在下一行。
  // 修之前得到 "summary_zh:\n正文摘要。\n正文摘要。"——标签泄进读者可见的摘要里还多出一份。
  const p = parseTranslateOutput("title_zh: 中文标题\nsummary_zh:\n正文摘要。");
  assert.equal(p.titleZh, "中文标题");
  assert.equal(p.summaryZh, "正文摘要。");
  assert.equal(p.bodyZh, "");
});
