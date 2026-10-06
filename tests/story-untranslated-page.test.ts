// 474 个事件页只有英文标题（2026-10-05 生产库实测：4023 个可打开的事件里 474 个标题无汉字，其中只有 2 个
// 有中文报道标题可借）。这一页照常打开、照常列报道，但读者必须一眼看出这一页没有本站写的中文——所以
// `story.tsx` 上挂着两件由读取层驱动的东西：robots 的 noindex（爬虫承诺）和标题下面那句话（读者说明）。
// 两者都必须读 `story.indexable`，不能各判各的：`tests/publication-copy-gate.test.ts` 钉住那个字段怎么算，
// 这里钉住页面有没有照它办事。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../apps/web/app/routes/story.tsx", import.meta.url), "utf8");

test("事件页的收录承诺与那句中文说明读同一个 indexable", () => {
  assert.ok(page.includes("noindex: !s.indexable"), "meta 不再按 `story.indexable` 决定 noindex：一个没有中文标题的事件对爬虫作出的承诺就与页面内容不一致了");
  assert.ok(page.includes("{!story.indexable && ("), "标题下面那句话也要跟着同一个判定，不能只在爬虫那边承认");
  assert.match(page, /还没有中文稿/, "那句话得说清楚这是原文照录，不是本站写的");
  assert.match(page, /原文照录/, "并且要点明白下面的报道是原文——读者会往下滚动");
});

test("这句话给出出口，而不只是宣布坏消息", () => {
  const notice = page.slice(page.indexOf("{!story.indexable && ("), page.indexOf("{!story.indexable && (") + 900);
  assert.match(notice, /to="\/hot"/, "空态与降级态都要有可点的地方（A6 走查对 /hot 提过同一条）");
  assert.ok(!/disabled|href="#"/.test(notice), "出口不能是个假链接");
});
