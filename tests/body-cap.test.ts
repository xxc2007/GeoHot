// 长文正文的渲染上限。钉的是 `capBody()` 这个函数本身，不是它下游的页面——
// 2026-10-16 打开 260 道"feed 自带全文"的门之后，会翻成 full 的 15,751 条里有 223 条正文超过
// 60,000 字（最长一条 412,027 字是一整篇 SWP 报告），而读者路径上原本没有任何一处封顶。
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { BODY_CAP_CHARS, capBody } from "@aihot/backend/publication/detail";

const textOf = (html: string) => cheerio.load(html, null, false).root().text().length;

test("a body within the cap is returned untouched and says so", () => {
  const html = "<p>" + "短".repeat(500) + "</p><p>" + "尾".repeat(500) + "</p>";
  const r = capBody(html, 20_000);
  assert.equal(r.truncated, false, "没超上限就不许说'只贴了前段'");
  assert.equal(r.html, html, "未超上限时一个字节都不许动");
  assert.equal(r.total, 1000);
});

test("a long body is cut at a block boundary, not mid-sentence", () => {
  const paras = Array.from({ length: 60 }, (_unused, i) => `<p>第${i}段 ${"字".repeat(1000)}</p>`).join("");
  const r = capBody(`<div>${paras}</div>`);
  assert.equal(r.truncated, true, "6 万字必须被切");
  assert.ok(r.shown <= BODY_CAP_CHARS, `切完还剩 ${r.shown} 字，超过上限 ${BODY_CAP_CHARS}`);
  assert.ok(r.shown > BODY_CAP_CHARS - 1200, "切点必须贴着上限，不能早早收工");
  const $ = cheerio.load(r.html, null, false);
  const kept = $("p").toArray();
  assert.equal(kept.length, 19, `每段约 1,004 字、上限 20,000 ⇒ 应留 19 段，实际 ${kept.length}`);
  assert.equal($("p").last().text().startsWith("第18段"), true, "最后留下的一段必须是完整的一段");
  assert.equal(r.html.includes("第25段"), false, "被切掉的段落不许还在 HTML 里");
  assert.equal(textOf(r.html), r.shown, "报告的字数要等于页面上真有的字数");
});

test("a body that is one giant paragraph still cannot exceed the cap by much", () => {
  const huge = "<p>" + "长".repeat(200_000) + "</p>";
  const r = capBody(huge);
  assert.equal(r.truncated, true, "块边界切不动时也必须切，不能整篇吐给读者");
  assert.equal(r.total, 200_000);
  assert.ok(r.html.length <= 200_000, "HTML 长度必须真的降下来");
  assert.ok(r.html.length <= BODY_CAP_CHARS * 1.2 + 16, `硬切之后仍给了 ${r.html.length} 字符`);
  assert.equal(r.html.trim().endsWith(">"), true, "硬切必须落在标签边界，不许留半个标签");
});

test("headings after the cut are gone, so the outline cannot point at missing anchors", () => {
  const blocks = Array.from({ length: 40 }, (_unused, i) =>
    i % 4 === 0 ? `<h2>节${i}</h2>` : `<p>${"字".repeat(1000)}</p>`).join("");
  const r = capBody(blocks);
  assert.equal(r.truncated, true);
  assert.equal(/节3[0-9]/.test(r.html), false, "切点之后的标题必须一起消失");
  assert.match(r.html, /节0/, "切点之前的标题必须留着");
});
