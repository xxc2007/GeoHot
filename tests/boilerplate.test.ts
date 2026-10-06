// 页脚话术不算正文（站长 2026-10-06：他的信息里只留核心内容）。
// 线上实测：最近 400 条 body_status=ok 的正文里有 96 条（24%）以
// 「国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用…」开头。
// 这一文件钉住：抽取侧不存它、喂模型前剥掉它、中文兜底不会拿它当摘要。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoilerplateBody, stripBoilerplate } from "@aihot/backend/lib/text";
import { cleanArticleTextForLLM, finalizeCopy, type TranslateInput } from "@aihot/backend/editorial/writing";
import { readable } from "@aihot/backend/content/extract";

const FOOTER =
  "国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用 制作维护：国家气象中心预报系统开放实验室 地址：北京市中关村南大街46号 邮编：100081";
const ALERT =
  "北安市气象台2026年10月6日10时00分发布大风蓝色预警信号：预计未来24小时我市市区、二井镇、城郊乡、东胜乡、赵光镇平均风力可达6级以上，或阵风8级以上，请有关单位和个人注意做好预防工作。";

test("the footer is stripped and the alert paragraph survives", () => {
  const mixed = stripBoilerplate(`${ALERT}\n${FOOTER}`);
  assert.ok(mixed.includes("北安市气象台"), "正文留下");
  assert.ok(!/版权所有|未经授权禁止/.test(mixed), "页脚话术删掉");
  assert.equal(isBoilerplateBody(`${ALERT}\n${FOOTER}`), false, "有真正文的页面不算页脚体");
  assert.equal(isBoilerplateBody(FOOTER), true, "整段就是页脚：判为无正文");
});

test("the model never sees the footer", () => {
  const cleaned = cleanArticleTextForLLM(`${ALERT}\n\n${FOOTER}`);
  assert.ok(!/版权所有|Copyright|未经授权禁止/.test(cleaned), cleaned.slice(0, 80));
  assert.ok(cleaned.includes("大风蓝色预警信号"));
});

test("a footer-only page yields no body at all, not a footer body", () => {
  const html = `<html><head><title>中央气象台</title></head><body><div id="nav">首页 预报 预警 服务</div><div class="footer">${FOOTER}</div></body></html>`;
  assert.equal(readable(html, "https://www.nmc.cn/publish/alarm/x.html"), null, "抽不出真正文就返回 null");
});

// 2026-10-06 在生产机上实测 12 条中央气象台预警详情页：整页正文 126–308 字，`stripBoilerplate` 一个字符都不删。
// 下限 150 时其中 5 条被判「没有正文」——同一类官方预警，只因为预报那句短十几字就永久卡在 unconfirmed，
// 而没有正文就没有中文摘要，条目进不了公开池（精选、热点榜、日报都因此空着）。下限降到 120。
test("a one-paragraph official alert is a body; a bare headline still is not", () => {
  const page = (main: string) =>
    `<html><head><title>北安市气象台发布大风蓝色预警信号</title></head><body>` +
    `<div id="nav">首页 预报 预警 服务</div><div class="article">${main}</div><div class="footer">${FOOTER}</div></body></html>`;
  const alert = `${ALERT}请有关单位和个人注意做好预防工作，户外作业请暂停。`;
  const got = readable(page(alert), "https://www.nmc.cn/publish/alarm/ba.html");
  assert.ok(got, "120–150 字之间的真预警要出正文");
  assert.ok(got!.text.includes("北安市气象台") && !/版权所有/.test(got!.text), "正文留着，页脚不进来");
  assert.equal(readable(page("北安市气象台发布大风蓝色预警信号。"), "https://www.nmc.cn/publish/alarm/bb.html"), null, "只有一句标题仍然不算正文");
});

test("the Chinese fallback refuses to lead with a footer", () => {  const footerOnly = { title: "某县气象台发布大风蓝色预警信号", text: FOOTER, sourceKind: "json_list" } as TranslateInput;
  assert.equal(finalizeCopy(footerOnly, { titleZh: footerOnly.title, summaryZh: "" }).summaryZh, "", "页脚不能当摘要上屏");
  const realAlert = { title: "某县气象台发布大风蓝色预警信号", text: ALERT, sourceKind: "json_list" } as TranslateInput;
  const copy = finalizeCopy(realAlert, { titleZh: realAlert.title, summaryZh: "" });
  assert.ok(copy.summaryZh.includes("北安市气象台"), "数字很多的官方预警正文仍然过关（密度实测 0.7+，阈值 0.55）");
});
