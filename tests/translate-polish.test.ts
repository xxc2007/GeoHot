// 译文落地前的最后一层：中文句子里照抄的英文单位与直角引号。纯函数，不碰库、不碰模型。
// 依据是 2026-10-16 在库存译文上量到的两族形状："LROC 图像中…" Watters 说。/ 24 tonnes / 708 hectares。
import assert from "node:assert/strict";
import { test } from "node:test";
import { polishZh, zhText } from "@aihot/backend/editorial/translate";

test("英文单位换成中文读法，数值与小数位一个都不动", () => {
  assert.equal(zhText("一批重 24 tonnes 的货件"), "一批重 24 吨 的货件");
  assert.equal(zhText("交出 708 hectares 林地"), "交出 708 公顷 林地");
  assert.equal(zhText("约 66,800 km2 范围"), "约 66,800 km² 范围");
  assert.equal(zhText("水深 1.5 metres，重 3 tons，容 12 litres"), "水深 1.5 米，重 3 吨，容 12 升");
  assert.equal(zhText("通量 0.033 % 每十年"), "通量 0.033 % 每十年", "百分比与 decade 不在这一层该动的范围");
  assert.equal(zhText("Mw 7.1 地震"), "Mw 7.1 地震", "震级写法不许动");
});

test("引号只在一对一对时换成中文引号，单个的一律不猜", () => {
  assert.equal(zhText("他说：“现在……”"), "他说：“现在……”");
  assert.equal(zhText('"数量远超我的想象，" Watters 说。"至今仍在进行。"'), "“数量远超我的想象，” Watters 说。“至今仍在进行。”");
  assert.equal(zhText("2025's 峰值 100 英里"), "2025's 峰值 100 英里", "撇号不是引号");
  assert.equal(zhText('这里有一个落单的 " 号'), "这里有一个落单的 \" 号", "奇数个引号不改，改了就是猜");
});

test("不含汉字的文本节点一个字都不改：未翻全时留下的英文块不许被这层冒充成译文", () => {
  const en = "<p>The price is 24 tonnes and 708 hectares.</p>";
  assert.equal(polishZh(en), en);
});

test("只改文本，不碰标签与属性", () => {
  const got = polishZh('<p>使用 <a href="https://example.org/24-tonnes">24 tonnes 报告</a> 与 <code>hectares</code> 作示意</p>');
  assert.ok(got.includes('href="https://example.org/24-tonnes"'), got, "地址被改过就不是排版问题，是坏链接");
  assert.ok(got.includes("24 吨 报告"), got);
  assert.ok(got.includes("<code>hectares</code>"), got, "代码里的原文不许被排版层翻译");
});

test("图片与占位符原样保留，且这一层幂等", () => {
  const html = "<p>如图 ⟦0⟧ 所示，共 5 tons。</p>";
  const once = polishZh(html);
  assert.ok(once.includes("⟦0⟧"), once);
  assert.ok(once.includes("5 吨"), once);
  assert.equal(polishZh(once), once, "跑第二遍不该再变");
});
