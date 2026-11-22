// 474 个事件页只有英文标题（2026-10-05 生产库实测：4023 个可打开的事件里 474 个标题无汉字，其中只有 2 个
// 有中文报道标题可借）。这一页照常打开、照常列报道，但读者必须一眼看出这一页没有本站写的中文——所以
// `story.tsx` 上挂着两件由读取层驱动的东西：robots 的 noindex（爬虫承诺）和标题下面那句话（读者说明）。
// 两者都必须读 `story.indexable`，不能各判各的：`tests/publication-copy-gate.test.ts` 钉住那个字段怎么算，
// 这里钉住页面有没有照它办事。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../apps/web/app/routes/story.tsx", import.meta.url), "utf8");
// 文案进了逐页字典（界面英文化后，中文不再写死在 JSX 里）。意图不变：钉住那句说明的**中文措辞**，
// 所以读字典的 zh 值，而不是读已改成 `{c.untranslatedNote}` 的 JSX。
const dict = readFileSync(new URL("../apps/web/app/lib/i18n/pages/story.ts", import.meta.url), "utf8");

test("事件页的收录承诺与那句中文说明读同一个 indexable", () => {
  assert.ok(page.includes("noindex: !s.indexable"), "meta 不再按 `story.indexable` 决定 noindex：一个没有中文标题的事件对爬虫作出的承诺就与页面内容不一致了");
  assert.ok(page.includes("{!story.indexable && ("), "标题下面那句话也要跟着同一个判定，不能只在爬虫那边承认");
  assert.match(dict, /还没有中文稿/, "那句话得说清楚这是原文照录，不是本站写的");
  assert.match(dict, /原文照录/, "并且要点明白下面的报道是原文——读者会往下滚动");
  // 文案搬进字典之后，页面必须真的把那一句渲染出来：只钉字典措辞会漏掉「页面忘了接」。
  assert.match(page, /<span>\{c\.untranslatedNote\}<\/span>/, "标题下那句话要渲染字典里的 untranslatedNote");
});

test("这句话给出出口，而不只是宣布坏消息", () => {
  const notice = page.slice(page.indexOf("{!story.indexable && ("), page.indexOf("{!story.indexable && (") + 900);
  // 出口跟着页面语言：/en 事件页去 /en/hot，写死 to="/hot" 会把英文页读者送回中文热点榜。
  assert.match(notice, /to=\{localeAppPath\("\/hot", locale\)\}/, "空态与降级态都要有可点的地方，且随页面语言折算（A6 走查对 /hot 提过同一条）");
  assert.match(notice, /\{c\.untranslatedLink\}/, "出口文案同样来自字典");
  assert.ok(!/disabled|href="#"/.test(notice), "出口不能是个假链接");
});
