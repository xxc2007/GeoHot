import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { inferLanguage } from "../packages/backend/src/content/language.ts";

test("中文正文判成 zh", () => {
  const body = "中国科学院地球化学研究所今日发布消息，研究团队在青藏高原发现了新的深部流体活动证据，相关成果已发表于国际期刊。";
  assert.equal(inferLanguage("青藏高原深部流体新证据", body), "zh");
});

test("英文正文判成 en", () => {
  const body =
    "Researchers have documented a new pattern of deep fluid activity beneath the Tibetan Plateau, according to a study published this week in a peer-reviewed journal.";
  assert.equal(inferLanguage("New evidence for deep fluids", body), "en");
});

test("标题就是唯一线索时也能判", () => {
  assert.equal(inferLanguage("自然资源部发布全国国土空间规划纲要", ""), "zh");
  assert.equal(inferLanguage("NOAA releases its annual climate report for 2025", ""), "en");
});

test("样本太短或非中英文字母为主时保持 null", () => {
  assert.equal(inferLanguage("", ""), null);
  assert.equal(inferLanguage("Ok", "short"), null);
  assert.equal(inferLanguage("تقرير جديد", "نشرت المنظمة تقريرا جديدا عن حالة المناخ في المنطقة"), null);
});

test("中英混排但中文过半仍算 zh", () => {
  const body = "气候变化 Climate change 正在改变全球水循环，新的观测显示极端降水频率上升，研究者呼吁加强监测网络建设。";
  assert.equal(inferLanguage("气候与极端降水", body), "zh");
});

test("抽取流程只在语言为空时兜底写入（形状守卫）", () => {
  const source = readFileSync("packages/backend/src/content/extract.ts", "utf8");
  assert.match(source, /const language = row\.language \?\? inferLanguage\(row\.title, got\.text\);/);
  assert.match(source, /language = coalesce\(language, \$\{language\}\)/);
});
