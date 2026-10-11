// 页脚话术不算正文（站长 2026-10-06：他的信息里只留核心内容）。
// 线上实测：最近 400 条 body_status=ok 的正文里有 96 条（24%）以
// 「国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用…」开头。
// 这一文件钉住：抽取侧不存它、喂模型前剥掉它、中文兜底不会拿它当摘要。
// 第三十三轮又加了一族：不是页脚话术，而是**页面外壳**——发稿时间与来源行、字号控件、编辑署名。
// 它们混在正文元素里，读者看到的 HTML 也带着，所以文本和 HTML 两层都要过同一份规则。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoilerplateBody, stripBoilerplate, stripTruncatedShellTail } from "@aihot/backend/lib/text";
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

// 下面几条钉住第三十三轮的页面外壳。夹具是抄来的，不是编的：
// · CN_TEXT 是线上 `body_text` 的形状（`stripTags` 把标签折成空格）；
// · CN_RAW 是 https://www.chinanews.com.cn/sh/2026/10-06/10708416.shtml 抓下来的原文（2026-10-06 实测 200）；
// · CN_HTML 是这条新闻在生产库里存的 `body_html`（外壳三段 + 三段正文 + 结尾署名）。
// 实测范围：cn-chinanews-scroll 有正文的 458 条里 195 条带这套外壳。
const CN_TEXT =
  "2026年10月06日 14:02　来源： 中国新闻网 大字体 小字体 　　中新网杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。" +
  "记者10月6日从浙江海事部门获悉，截至10月5日，舟山已累计发送旅客超100万人次。(完) 【编辑:刘欢】";

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
  "中新网杭州10月6日电(记者 王逸飞)今年国庆假期，浙江水上出行需求集中释放，水上客运持续保持高位运行。记者10月6日从浙江海事部门获悉，截至10月5日，舟山已累计发送旅客超100万人次。";

test("the chrome rules stop at the sentence boundary — three shapes that must survive", () => {
  // 独立评审拿真句子证出来的三处：边界判断一丢，灾害数据与稿子里的话就会被当成控件删掉。
  const quake = "2026年10月06日 14:02 来源：中国地震台网中心测定，云南德宏州盈江县发生5.1级地震。";
  assert.equal(stripBoilerplate(quake), quake, "时刻与机构名是灾害数据：来源：后面紧跟「测定，」就不是外壳");
  const editor = "对话商务印书馆的一位责任编辑：您如何判断一本书值不值得做？";
  assert.equal(stripBoilerplate(editor), editor, "「责任编辑：」在句子里是职位，不是署名行");
  const typography = "网页设计里常把大字体 小字体混排，是为了建立层级。";
  assert.equal(stripBoilerplate(typography), typography, "谈字号的句子不是字号按钮");
  // 真署名与真按钮仍然要删得掉（署名独占一段、按钮两侧是空格）。
  assert.equal(stripBoilerplate("一处遗址完成回填保护。 责任编辑：王一兰"), "一处遗址完成回填保护。");
  // 真按钮两侧是空格分隔的独立词元，照样删得掉；嵌在句子里的「大字体」不动。
  assert.equal(stripBoilerplate("中国新闻网 大字体 小字体 中新网杭州电"), "中国新闻网 中新网杭州电");
});

test("inline spacing around links survives the HTML wash", () => {
  const html = "<p>Researchers at <a href=\"https://www.nasa.gov/\">NASA</a> said the ice shelf calved on Monday, according to a report published this week.</p>";
  const got = stripChromeHtml(html);
  assert.ok(got.includes("Researchers at <a"), got);
  assert.ok(got.includes("NASA</a> said"), got);
  // 时间行与图并排时不能连图一起删（和 normalizeBlocks 同一道判断）。
  const withImage = stripChromeHtml(
    "<p>2026年10月06日 14:02　来源：<a href=\"https://www.chinanews.com.cn/\">中国新闻网</a><img src=\"https://i.chinanews.com.cn/a.jpg\" alt=\"图\"></p><p>正文正文正文在这一段里。</p>",
  );
  assert.ok(withImage.includes("<img"), "挂着图的那段不整段删");
  assert.ok(withImage.includes("正文正文正文"), "正文留着");
});

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

// 2026-10-11 又抓到一族：前端模板没渲染出来的**页面骨架**。线上 web-dlyj-toc 的 18 条里 14 条整段是
// `PDF(8989 KB) 中国A级景区运营效率测度… {{javascript:window.custom_author_cn_index=0;}} {{article.zuoZhe_CN}}
// 作者信息 + …`。骨架能剩下七百字、中文密度也过 0.55，所以「删完还剩几个字」和密度两条都放它过去——
// 必须按占位符单独判一次。规则只写在 lib/text.ts 一处，抽取、喂模型、中文兜底三处都读它。
const SHELL =
  "PDF(8989 KB) 中国A级景区运营效率测度及其空间分异特征 {{javascript:window.custom_author_cn_index=0;}} {{article.zuoZhe_CN}} 作者信息 + Measurement of operational efficiency in China's A-level scenic spots {{javascript:window.custom_author_en_index=0;}} {{article.zuoZhe_EN}} Author information + 文章历史 + {{article.keyPoints_cn}} {{article.keyPoints_en}} 本文二维码 引用本文 导出引用 {{article.zuoZheCn_L}}. {{article.title_cn}}[J]. {{journal.qiKanMingCheng_CN}}, 2026, 45(9): 2745-2766 https://doi.org/10.11821/dlyj020260063 中图分类号： 参考文献 基金 版权";

test("页面骨架不是正文：占位符与 PDF 角标都不给读者看", () => {
  assert.ok(isBoilerplateBody(SHELL), "占位符成堆的骨架要判成「没读到正文」，它有七百字也不行");
  const cleaned = stripBoilerplate(SHELL);
  assert.ok(!cleaned.includes("{{"), `骨架里的占位符没剥干净：${cleaned.slice(0, 120)}`);
  assert.ok(!/PDF\(\d+ KB\)/.test(cleaned), "列表页的 PDF 角标不是文章的一部分");
  assert.ok(cleaned.includes("中国A级景区运营效率测度及其空间分异特征"), "篇名本身要留下");
  // 中文兜底那条路（finalizeCopy → ownChineseLead）不能把骨架当摘要发出去。
  const input = { title: "中国A级景区运营效率测度及其空间分异特征", text: SHELL, sourceKind: "web_list", sourceName: "地理研究 当期目录" } as unknown as TranslateInput;
  assert.equal(finalizeCopy(input, { titleZh: "中国A级景区运营效率测度及其空间分异特征", summaryZh: "" }).summaryZh, "", "骨架不能当中文稿");
  // 阈值取 3：一篇真稿子（代码教程、软件测评）带一两个模板字符串不算骨架，不能被这条规则误杀；
  // 而线上那 14 条骨架每一条都有十几个占位符。
  assert.ok(!isBoilerplateBody("教程讲 Vue 的插值写法 {{ msg }} 的两种变体 {{ user.name }} 差别在哪里，另外附上正文说明部分，够六十个字才算一篇稿子，这里把长度补足以免长度那条规则替它说话。"));
});

// 2026-10-12 独立复核抓到 d93fd0a 埋的坑：shared 的 stripBoilerplate 是被 content/sanitize.ts 逐文本节点调用的，
// "未闭合的 {{ 必然在整段结尾"这个前提在正文那条路上不成立。下面两条各自钉一件事，都能红：
test("未闭合的外壳尾巴只在收口路径剥——shared 剥壳与非外壳形状都不许被它动到", () => {
  const chrome = "秦岭脱贫山区农户生计转型适应性地理分异及影响机制——以陕西省商州区为例 {{javascript:window.custom_author_cn_index=0";
  assert.equal(stripBoilerplate(chrome), chrome, "这条规则放进 shared 就会吃掉正文中间节点的尾巴，不许回来");
  assert.equal(stripTruncatedShellTail("本段说明符号约定：本文用 {{ layer_name 表示矢量图层"),
    "本段说明符号约定：本文用 {{ layer_name 表示矢量图层", "不是外壳形状的未闭合 {{ 属于正文，不许剥");
  assert.equal(stripTruncatedShellTail(chrome), "秦岭脱贫山区农户生计转型适应性地理分异及影响机制——以陕西省商州区为例");
});

// 复核发现：存量那 14 条修好了，但**生成它们的那条路还开着**。`isTemplateShell` 数的是闭合占位符（≥3），
// 截断形状一个都数不到；`stripBoilerplate` 要求配对括号，也放它过去；最后 `closeTruncatedSentence`
// 找不到任何结尾标点，就**给外壳文本点了个句号**——比存量那 14 条更糟。这条用例钉住运行时。
test("中文兜底与模型答复都不能把截断的页面外壳当摘要发出去", () => {
  const chrome = "秦岭脱贫山区农户生计转型适应性地理分异及影响机制——以陕西省商州区为例 {{javascript:window.custom_author_cn_index=0";
  const input = { title: chrome.slice(0, 40), text: chrome, sourceKind: "web_list", sourceName: "地理研究 当期目录" } as unknown as TranslateInput;
  const viaModel = finalizeCopy(input, { titleZh: "秦岭脱贫山区农户生计转型", summaryZh: chrome }).summaryZh;
  const viaFallback = finalizeCopy(input, { titleZh: "秦岭脱贫山区农户生计转型", summaryZh: "" }).summaryZh;
  assert.ok(!viaModel.includes("{{") && !/javascript:/i.test(viaModel), `模型答复把页面外壳发给了读者：「${viaModel}」`);
  assert.match(viaModel, /[。！？…]$/u, `模型答复的提要要收在闭合标点上：「${viaModel}」`);
  // 兜底这条路**应当交白卷**：外壳剥完什么都不剩，空提要会让 normalizeAnalysis 把这条判成「等待」，
  // 而不是把骨架当摘要发出去——这正是线上那 14 条的反面。
  assert.equal(viaFallback, "", `剥完外壳已经没有内容，兜底不该硬凑一句：「${viaFallback}」`);
});
