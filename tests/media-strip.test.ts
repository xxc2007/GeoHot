import test from "node:test";
import assert from "node:assert/strict";
import { imageSourceOf, stripImageSources } from "../packages/backend/src/media/strip.ts";

/**
 * 2026-11-08：正文里取不到的图会让整篇稿子永久停在「媒体未就绪」。这里的判据必须只摘掉
 * 明确失败的那几张，其余字节（含属性顺序、空白、其它 img）原样保留——正文指纹参与发布判定，
 * 多改一个字节就会让一篇本来能发的稿子重新过一遍闸门。
 */
test("只删掉命中的 img，其它字节不动", () => {
  const html = `<p>甲</p><img src="https://a.example/1.jpg" alt="x"><p>乙</p><img src='https://b.example/2.jpg'>`;
  const out = stripImageSources(html, ["https://a.example/1.jpg"]);
  assert.equal(out.removed, 1);
  assert.equal(out.html, `<p>甲</p><p>乙</p><img src='https://b.example/2.jpg'>`);
});

test("实体编码过的地址也能对上", () => {
  const html = `<img src="https://a.example/p?a=1&amp;b=2">`;
  assert.equal(imageSourceOf(`<img src="https://a.example/p?a=1&amp;b=2">`), "https://a.example/p?a=1&b=2");
  assert.equal(stripImageSources(html, ["https://a.example/p?a=1&b=2"]).removed, 1);
});

test("无 src 的 img 与空列表都不动", () => {
  assert.equal(stripImageSources(`<img alt="x">`, ["https://a.example/1.jpg"]).removed, 0);
  assert.equal(stripImageSources(`<img src="https://a.example/1.jpg">`, []).removed, 0);
});

test("同一张图出现两次都摘掉", () => {
  const html = `<img src="https://a.example/1.jpg"><p>x</p><img src="https://a.example/1.jpg">`;
  const out = stripImageSources(html, ["https://a.example/1.jpg"]);
  assert.equal(out.removed, 2);
  assert.equal(out.html, `<p>x</p>`);
});

test("video poster 与非 img 标签不受影响（只处理 img）", () => {
  const html = `<video poster="https://a.example/p.jpg"></video><img src="https://a.example/p.jpg">`;
  const out = stripImageSources(html, ["https://a.example/p.jpg"]);
  assert.equal(out.removed, 1);
  assert.match(out.html, /<video poster=/);
});
