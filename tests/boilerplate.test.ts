// 页脚话术不算正文（站长 2026-10-06：他的信息里只留核心内容）。
// 线上实测：最近 400 条 body_status=ok 的正文里有 96 条（24%）以
// 「国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用…」开头。
// 这一文件钉住：抽取侧不存它、喂模型前剥掉它、中文兜底不会拿它当摘要。
// 第三十三轮又加了一族：不是页脚话术，而是**页面外壳**——发稿时间与来源行、字号控件、编辑署名。
// 它们混在正文元素里，读者看到的 HTML 也带着，所以文本和 HTML 两层都要过同一份规则。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoilerplateBody, stripBoilerplate } from "@aihot/backend/lib/text";
import { cleanArticleTextForLLM, finalizeCopy, type TranslateInput } from "@aihot/backend/editorial/writing";
import { readable } from "@aihot/backend/content/extract";
import { sanitizeBody, stripChromeHtml } from "@aihot/backend/content/sanitize";

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
  assert.ok(got!.text.length >= 120 && got!.text.length < 150, `要落在旧下限会杀掉的那一段：实测 ${got!.text.length} 字`);
  assert.ok(got!.text.includes("北安市气象台") && !/版权所有/.test(got!.text), "正文留着，页脚不进来");
  assert.equal(readable(page("北安市气象台发布大风蓝色预警信号。"), "https://www.nmc.cn/publish/alarm/bb.html"), null, "只有一句标题仍然不算正文");
});

test("the Chinese fallback refuses to lead with a footer", () => {
  const footerOnly = { title: "某县气象台发布大风蓝色预警信号", text: FOOTER, sourceKind: "json_list" } as TranslateInput;
  assert.equal(finalizeCopy(footerOnly, { titleZh: footerOnly.title, summaryZh: "" }).summaryZh, "", "页脚不能当摘要上屏");
  const realAlert = { title: "某县气象台发布大风蓝色预警信号", text: ALERT, sourceKind: "json_list" } as TranslateInput;
  const copy = finalizeCopy(realAlert, { titleZh: realAlert.title, summaryZh: "" });
  assert.ok(copy.summaryZh.includes("北安市气象台"), "数字很多的官方预警正文仍然过关（密度实测 0.7+，阈值 0.55）");
});

// 下面三条钉住第三十三轮的页面外壳。夹具是抄来的，不是编的：
// · CN_TEXT 是线上 `body_text` 的形状（`stripTags` 把标签折成空格）；
// · CN_RAW 是 https://www.chinanews.com.cn/sh/2026/10-06/10708416.shtml 抓下来的原文（2026-10-06 实测 200）；
// · CN_HTML 是这条新闻在生产库里存的 `body_html` 开头三段。
// 实测范围：cn-chinanews-scroll 有正文的 458 条里 195 条带这套外壳。
const CN_TEXT =
  "2026年10月06日 14:02　来源： 中国新闻网 大字体 小字体 　　中新网杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。" +
  "记者10月6日从浙江海事部门获悉，截至10月5日，浙江水上客运总量最大的城市舟山已累计发送旅客超100万人次。(完) 【编辑:刘欢】";

const CN_RAW =
  '<div class="content_left_time">2026年10月06日 14:02　来源：<a href=\'/\' class=\'source\'>中国新闻网</a>' +
  '<div class="change_font_size right"><div class="bigger_font_size left"><span class="icon2 icon2_bigger"></span>大字体</div>' +
  '<div class="small_font_size right"><span class="icon2 icon2_smaller"></span>小字体</div></div></div>' +
  '<p>　　<a href="https://www.chinanews.com.cn/">中新网</a>杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。</p>' +
  '<p>　　记者10月6日从浙江海事部门获悉，截至10月5日，舟山已累计发送旅客超100万人次。</p>' +
  '<p>　　为应对假期大客流考验，舟山海事局在国庆假期全程启动提级监管。(完)</p>' +
  '<div class="adEditor"><div class="left_name right"> <span>【编辑:刘欢】 </span></div></div>';

const CN_HTML =
  "<p>\n                        2026年10月06日 14:02　来源：<a href=\"https://www.chinanews.com.cn/\">中国新闻网</a></p>" +
  "<p><span></span>大字体\n                            </p><p><span></span>小字体\n                            </p>" +
  "<p>　　<a href=\"https://www.chinanews.com.cn/\">中新网</a>杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。</p>" +
  "<p>　　记者10月6日从浙江海事部门获悉，截至10月5日，舟山已累计发送旅客超100万人次。</p>" +
  "<p>　　为应对假期大客流考验，舟山海事局在国庆假期全程启动提级监管。(完)</p><p><span>【编辑:刘欢】 </span></p>";

const CN_URL = "https://www.chinanews.com.cn/sh/2026/10-06/10708416.shtml";
const CHROME = /大字体|小字体|【编辑|\(完\)|2026年10月06日|中国新闻网|来源：/;
const CLEAN_TEXT =
  "中新网杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。记者10月6日从浙江海事部门获悉，截至10月5日，浙江水上客运总量最大的城市舟山已累计发送旅客超100万人次。";

test("the chrome folded into the stored text is stripped, the sentence survives", () => {
  assert.equal(stripBoilerplate(CN_TEXT), CLEAN_TEXT);
  assert.equal(isBoilerplateBody(CN_TEXT), false, "带外壳的真稿子仍然算正文");
  assert.equal(stripBoilerplate(ALERT), ALERT, "官方预警那句正文，外壳规则一个字符都不该碰");
});

test("the chrome is stripped from the HTML a reader is served", () => {
  const fromPage = stripChromeHtml(sanitizeBody(CN_RAW, CN_URL));
  assert.ok(!CHROME.test(fromPage), fromPage);
  assert.ok(fromPage.includes("浙江水上出行需求集中释放"), "真正文一个字不损");
  assert.ok(fromPage.includes('<a href="https://www.chinanews.com.cn/">中新网</a>'), "正文里的链接留着");
  assert.match(fromPage, /^<p>/, "还是段落，不是一坨文本");

  // 存量洗库走的是同一条路：库里存的 HTML 直接清洗，不再整块丢掉全文。
  const fromStore = stripChromeHtml(CN_HTML);
  assert.ok(!CHROME.test(fromStore), fromStore);
  assert.ok(fromStore.includes("舟山海事局在国庆假期全程启动提级监管。"), "末段还在，只是不再以「(完)」收尾");
  assert.equal((fromStore.match(/<p>/g) ?? []).length, 3, "三段正文还是三段，外壳那三段没了");
});
