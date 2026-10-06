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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** GitHub's slug, to the extent it is computable from the text alone. */
function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} \-]/gu, "").replace(/ /g, "-");
}

/** Both front pages are hand-maintained the same way, so every rule below runs over both. */
const FILES = ["README.md", "README.en.md"] as const;
const readmes = new Map(FILES.map((f) => [f, readFileSync(new URL(`../${f}`, import.meta.url), "utf8")]));

for (const [name, readme] of readmes) {
  const lines = readme.split(/\r?\n/);
  /** Anchors can point at any heading level, so the set is wider than the nav row. */
  const headings = lines.filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#{2,4} /, ""));
  const h2 = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
  const anchors = new Set(headings.map(slug));

  test(`${name}：每个 #锚点 都能落到一个标题上`, () => {
    assert.ok(h2.length >= 6, `至少该有六个二级标题，实到 ${h2.length}：文件结构变了就连本文件一起重看`);
    const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length >= 8, `导航与徽章里该有八个以上的站内锚点，实到 ${links.length}`);
    for (const href of links) {
      assert.ok(anchors.has(href), `${name} 里的 (#${href}) 落不到任何标题上；可跳转的锚点：${[...anchors].join(" ")}`);
    }
  });

  test(`${name}：标题里不许有变体选择符（GitHub 会把它留在 slug 里，规则算不出来）`, () => {
    for (const h of headings) {
      assert.equal(/[\uFE0E\uFE0F]/.test(h), false, `「${h}」带了 U+FE0E/FE0F 变体选择符：GitHub 生成的 slug 与按规则算出来的不一致，导航会跳不过去——去掉 emoji，或改用没有变体选择符的那个`);
    }
  });

  /**
   * A `---` rule that sits directly under a line of text is not a rule: CommonMark reads that line as a setext
   * heading, so the paragraph becomes an `h2`. It bit the README twice on 2026-10-04 — the caption under each
   * screenshot ends right above a `---`, and the second one inherited a whole section's worth of weight, which
   * pushed 📈 Star History off the "last h2 in the file" position the repo is meant to hold.
   */
  test(`${name}：游离段落不许紧贴 ---（会被解析成 setext 二级标题）`, () => {
    for (let i = 1; i < lines.length; i++) {
      if (!/^---\s*$/.test(lines[i]!)) continue;
      const above = lines[i - 1]!;
      const isBlockStart = above === "" || /^(#{1,6} |>|```|\||\[[^\]]*\]:|\s)/.test(above);
      assert.ok(isBlockStart, `第 ${i + 1} 行的 --- 紧贴着「${above.slice(0, 40)}」：CommonMark 会把上一行当 setext 标题渲染成 h2，要么加空行，要么改用 ***`);
    }
  });

  test(`${name}：顶部导航那一行把每个二级标题都列出来`, () => {
    const nav = lines.find((l) => l.startsWith("[") && l.includes("](#") && l.includes(" · "));
    assert.ok(nav, "顶部那行 `[…](#…) · […]` 的导航还在不在？挪走或改名了就同步这一行");
    for (const h of h2) {
      assert.ok(nav.includes(`](#${slug(h)})`), `导航里少了「${h}」（锚点应为 #${slug(h)}）`);
    }
  });

  test(`${name}：相对链接都指到真实存在的文件`, () => {
    // 两页互相指向对方（语言切换）也走这条规则，所以它同时钉住"英文版还挂得上去"。
    const links = [...readme.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) => m[1]!.split("#")[0]!);
    assert.ok(links.length >= 10, `${name} 的相对链接该有十条以上，实到 ${links.length}`);
    const root = path.dirname(fileURLToPath(new URL(`../${name}`, import.meta.url)));
    for (const rel of links) {
      assert.ok(existsSync(path.resolve(root, decodeURIComponent(rel))), `${name} 里的相对链接 ${rel} 指向的文件不存在`);
    }
  });
}

