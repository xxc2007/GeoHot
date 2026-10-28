import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import { prepareArticleBody, siteItemDetail } from "@aihot/backend/publication/detail";

for (const chars of [1_000, 64_000, 412_027]) {
  test(`a ${chars}-character article retains every paragraph and its ending`, () => {
    const html = Array.from({ length: Math.ceil(chars / 1000) }, (_, i) =>
      `<p data-section="${i}">${"文".repeat(Math.min(1000, chars - i * 1000))}</p>`).join("");
    const result = prepareArticleBody(html);
    assert.equal(result.html === html, true, "every paragraph must survive byte for byte");
    assert.equal(result.shown, chars);
    assert.equal(result.total, chars);
    assert.equal(result.truncated, false);
  });
}

test("a single huge paragraph keeps its final words and closing tag", () => {
  const html = `<p>${"long paragraph 😀 ".repeat(15_000)}FINAL SENTENCE.</p>`;
  const result = prepareArticleBody(html);
  assert.equal(result.html === html, true);
  assert.ok(result.html.endsWith("FINAL SENTENCE.</p>"));
});

test("late headings, figures, tables, footnotes and references all survive", () => {
  const html = `<p>${"正文".repeat(32_000)}</p><h2>Results</h2>` +
    '<figure><img src="https://example.org/figure.png"><figcaption>Final figure</figcaption></figure>' +
    '<table><caption>Final table</caption><tbody><tr><td>42</td></tr></tbody></table>' +
    '<h3>References</h3><p>Last reference <sup>1</sup><a href="https://example.org/source">Source</a></p>';
  const result = prepareArticleBody(html);
  assert.equal(result.html === html, true);
  const $ = cheerio.load(result.html, null, false);
  assert.equal($("h3").text(), "References");
  assert.equal($("td").text(), "42");
  assert.equal($("figcaption").text(), "Final figure");
  assert.equal($("a").attr("href"), "https://example.org/source");
  assert.equal(result.shown, $.root().text().length);
});



test("both language projections retain the ending and late outline anchors", () => {
  for (const original of [false, true]) {
    const zh = '<h2>开头</h2><p>' + '中'.repeat(64000) + '</p><h2>参考文献</h2><p>中文结尾</p>';
    const en = '<h2>Start</h2><p>' + 'English '.repeat(12000) + '</p><h2>References</h2><p>ORIGINAL END</p>';
    const detail = { body: { zh, original: en, zhKind: "translation", complete: true }, x: null } as unknown as Parameters<typeof siteItemDetail>[0];
    const result = siteItemDetail(detail, original);
    const html = original ? result.body!.original! : result.body!.zh!;
    assert.ok(html.includes(original ? 'ORIGINAL END' : '中文结尾'));
    assert.equal(result.outline.at(-1)?.text, original ? 'References' : '参考文献');
    assert.equal(result.bodyLanguage, original ? 'original' : 'zh');
    assert.equal(original ? result.body!.zh : result.body!.original, null);
  }
});
