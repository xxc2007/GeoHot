// `scripts/close-open-ended-summaries.ts` 洗的是读者已经看到的存量文本，所以它必须满足两条：
// 抓得住线上实测的三种"半句话"形状（2026-10-11：公开行 1,772 条结尾挂分隔符、189 条整段没有结尾标点），
// 以及**只删不加**——收口只能用文本自己的边界，最多加一个收尾标点，不能凭空补半句内容。
// 这个文件会连库（判据要拿去 Postgres 里跑），所以 setup 的"测试库必须以 _test/_ci 结尾"闸门
// 必须排在 `@aihot/backend/db` 之前——`test-db-hygiene.test.ts` 就是查这个顺序的。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { closeTruncatedSentence } from "../packages/backend/src/editorial/writing.ts";
import { OPEN_ENDED, closeStockSummary, openEndedCondition } from "../scripts/close-open-ended-summaries.ts";

const openEnded = new RegExp(OPEN_ENDED);

test("三种线上实测的半句话形状都在候选里", () => {
  assert.ok(openEnded.test("气象台继续发布暴雨橙色预警，各地做好准备；"), "结尾挂分隔符");
  assert.ok(openEnded.test("昨夜北京城区最大降水小时雨强达"), "整段没有结尾标点");
  assert.ok(openEnded.test("台风范围扩大。29号台风"), "写完一句后又起了一句");
  assert.equal(openEnded.test("黄河源区湖泊面积近十年扩大约一成。"), false, "写完的摘要不许被碰");
});

test("收口之后一定闭合，而且一个新字都不加", () => {
  for (const s of [
    "气象台继续发布暴雨橙色预警，各地做好准备；",
    "昨夜北京城区最大降水小时雨强达",
    "台风范围扩大。29号台风",
    "能见度小于500",
    "该流域耕地面积约占总面积的三分之一，",
  ]) {
    const out = closeTruncatedSentence(s);
    assert.match(out, /[。！？…]$/u, `${s} 收口后没有闭合标点`);
    // 除最后那个收尾标点之外，输出的每一个字都必须是原文开头就有的——不许凭空补内容。
    assert.ok(s.startsWith(out.replace(/[。！？…]$/u, "")), `加了新内容：「${s}」→「${out}」`);
    assert.equal(closeTruncatedSentence(out), out, "再跑一次应当原样返回");
  }
});

test("半句被丢掉的那一段永远是尾巴，不是中间", () => {
  const out = closeTruncatedSentence("长江流域水文监测网络建成。后续将扩展至支流");
  assert.equal(out, "长江流域水文监测网络建成。");
});

// 结尾挂分隔符 ≠ 半句话。这一句是说完的，只是缺收尾标点——把它换成句号，一个字都不许多删。
// 两条形状都是 2026-10-12 在生产存量上实测到的：旧写法会把它们连同真数字一起退回上一个「。」，
// 于是 1,744 条里有一批读者看得见的防御指引与统计数字被静默删掉。
test("结尾挂着分隔符的那条要原地收口，不许退回上一句", () => {
  const alert = "梅县区气象台发布雷雨大风黄色预警信号。 提醒您：请注意防御。 防御指南： 1、妥善保管易受雷击的贵重电器设备，断电后放到安全的地方；";
  assert.equal(closeTruncatedSentence(alert),
    "梅县区气象台发布雷雨大风黄色预警信号。 提醒您：请注意防御。 防御指南： 1、妥善保管易受雷击的贵重电器设备，断电后放到安全的地方。");
  const profits = "1—8 月份，全国规模以上工业企业实现利润总额 52719.8 亿元，同比增长 15.7%。 国有控股企业实现利润总额 16759.9 亿元，同比增长 10.3%；";
  assert.equal(closeTruncatedSentence(profits),
    "1—8 月份，全国规模以上工业企业实现利润总额 52719.8 亿元，同比增长 15.7%。 国有控股企业实现利润总额 16759.9 亿元，同比增长 10.3%。");
  // 真数字不许被删掉——这两条各自只在末尾多了一个句号。
  assert.ok(closeTruncatedSentence(profits).includes("16759.9"), "国有控股那组数字被删了");
  // 线上实测的形状是「20.4% ；」——分隔符前留着一个半角空格，收口要紧跟正文，不许写出「% 。」。
  assert.equal(closeTruncatedSentence("规模以上工业企业利润增长 20.4% ；"), "规模以上工业企业利润增长 20.4%。");
});

// 洗的是库里存量，所以"谁算没闭合"必须由**数据库那份正则**判定：Postgres 的 `~` 与 JS 的 RegExp 在字符类、
// 多字节类上并不总是同意，而写库用的就是 `~`。同一段判据拿去跑 VALUES，量的才是真判据本身。
test("候选判据在 Postgres 里跑出来的形状与线上实测一致", async () => {
  const expected = new Map<string, boolean>([
    ["气象台继续发布暴雨橙色预警，各地做好准备；", true],
    ["昨夜北京城区最大降水小时雨强达", true],
    ["台风范围扩大。29号台风", true],
    ["该流域耕地面积约占总面积的三分之一，", true],
    ["黄河源区湖泊面积近十年扩大约一成。", false],
    ["自然资源部发布新一轮找矿突破。", false],
  ]);
  const rows = await sql<{ summary: string; hit: boolean }[]>`
    SELECT summary, ${openEndedCondition()} AS hit
      FROM (VALUES ${sql([...expected.keys()].map((s) => [s]))}) AS t(summary)`;
  assert.equal(rows.length, expected.size);
  for (const r of rows) {
    assert.equal(r.hit, expected.get(r.summary), `${r.summary} 的判定与预期不符`);
  }
});

// 存量里除了"半句话"还有一种更坏的形状：页面骨架。2026-10-11 生产实测 15 条公开摘要（全部来自
// web-dlyj-toc，0 条 selected）整段是 `PDF(19898 KB) 标题… {{javascript:window.custom_author_cn_index=0;}}`。
// 只收口不剥壳，就会给骨架点上一个句号，装作它是一句说完了的话——读者看不出来，下一次按形状扫查也扫不出来。
// 剥壳用的是运行时同一份 `lib/text.ts` 的 PDF_MARK / TEMPLATE_PLACEHOLDER，所以这条脚本不许再自带一套正则。
test("剥掉页面外壳后剩下的正文照常收口，骨架碎片一个不许留", () => {
  const out = closeStockSummary("PDF(8989 KB) 中国A级景区运营效率测度与空间分异特征{{javascript:window.custom_author_cn_index=0;}}");
  assert.equal(out.kind, "rewrite");
  assert.doesNotMatch(out.text, /PDF\(|\{\{|_cn_index/, `剥壳没起作用：「${out.text}」`);
  assert.match(out.text, /[。！？…]$/u, "留下的正文片段要收在闭合标点上");
  assert.ok(out.text.includes("中国A级景区运营效率测度"), "标题本身不许被一起削掉");
});

test("整条就是骨架、剥完没东西可留的不写库", () => {
  const out = closeStockSummary("PDF(8989 KB) {{javascript:window.custom_author_cn_index=0;}} {{article.zuoZhe_CN}}");
  assert.equal(out.kind, "skeleton", `剥完应该判成骨架留给人工，实际「${out.text}」`);
  assert.equal(out.text.replace(/\s+/g, ""), "", "骨架行不许留下任何字符");
});

// 这一条是测试先抓出来的真缺陷：曾经按"剩下的字数不够就当骨架"判，而
// `气象台继续发布暴雨橙色预警，各地做好准备；` 只有 21 字——官方预警就是这种又短又干净的摘要，
// 那条判据会让脚本把一大批真候选悄悄跳过，报告说洗过了其实什么都没改。
test("短而干净的官方预警摘要不许被当成骨架跳过", () => {
  const out = closeStockSummary("气象台继续发布暴雨橙色预警，各地做好准备；");
  assert.equal(out.kind, "rewrite");
  assert.equal(out.text, "气象台继续发布暴雨橙色预警，各地做好准备。");
  assert.equal(closeStockSummary("黄河源区湖泊面积近十年扩大约一成。").kind, "keep", "写完的摘要不许被碰");
});

after(async () => { await closeDb(); });
