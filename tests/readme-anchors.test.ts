// The README is this repo's front page, and its nav row is hand-maintained: the anchor has to be the slug
// GitHub generates from the heading, which nobody can see without opening the rendered page. Three failures of
// exactly this kind were found in one week — `[技术栈](#-技术栈)` next to a heading that had no emoji (so
// GitHub's slug is `技术栈`, no leading hyphen), the same link broken the other way when an emoji was added to
// the heading (because `⚙️` carries U+FE0F and GitHub keeps that character in the slug), and a nav entry that
// pointed at a `### ` sub-heading while this file only knew to look at `## ` ones.
//
// GitHub's rule that this file can check locally: downcase, drop every character that is not a letter, a
// number, a space or a hyphen, then replace spaces with hyphens — no trimming, which is why an emoji-led
// heading yields a leading `-`. Variation selectors are the one thing this cannot model (GitHub keeps them,
// the rule above drops them), so any heading that carries one is refused outright instead of guessed about.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** GitHub's slug, to the extent it is computable from the text alone. */
function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} \-]/gu, "").replace(/ /g, "-");
}

const lines = readme.split(/\r?\n/);
/** Anchors can point at any heading level, so the set is wider than the nav row. */
const headings = lines.filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#{2,4} /, ""));
const h2 = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
const anchors = new Set(headings.map(slug));

test("README 的每个 #锚点 都能落到一个标题上", () => {
  assert.ok(h2.length >= 6, `至少该有六个二级标题，实到 ${h2.length}：文件结构变了就连本文件一起重看`);
  const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
  assert.ok(links.length >= 8, `导航与徽章里该有八个以上的站内锚点，实到 ${links.length}`);
  for (const href of links) {
    assert.ok(anchors.has(href), `README 里的 (#${href}) 落不到任何标题上；可跳转的锚点：${[...anchors].join(" ")}`);
  }
});

test("标题里不许有变体选择符（GitHub 会把它留在 slug 里，规则算不出来）", () => {
  for (const h of headings) {
    assert.equal(/[\uFE0E\uFE0F]/.test(h), false, `「${h}」带了 U+FE0E/FE0F 变体选择符：GitHub 生成的 slug 与按规则算出来的不一致，导航会跳不过去——去掉 emoji，或改用没有变体选择符的那个`);
  }
});

test("顶部导航那一行把每个二级标题都列出来", () => {
  const nav = lines.find((l) => l.startsWith("[") && l.includes("](#") && l.includes(" · "));
  assert.ok(nav, "README 顶部那行 `[…](#…) · […]` 的导航还在不在？挪走或改名了就同步这一行");
  for (const h of h2) {
    assert.ok(nav.includes(`](#${slug(h)})`), `导航里少了「${h}」（锚点应为 #${slug(h)}）`);
  }
});
