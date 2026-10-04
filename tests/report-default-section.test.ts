// The daily paper's bucket for items with no category used to be computed from a *position*:
// `SECTION_ORDER.at(-1)`. That was harmless while every section had categories, and quietly wrong after
// 2026-10-03, when the owner deleted 野外与考察 and 观点与解读 — the last section became 技术, so a
// 碳排放解读 with no category was printed under a heading that expands to 「地理信息系统」 and counted by
// `compose.ts` as a data release (8 such rows sat in the development database the day it was found).
// The bucket is now a declared name that belongs to no category, and the release metric counts items by
// their own category key. This file pins all three, because none of them is visible to the type system
// and none of them fails any other test: a future edit that returns to a positional fallback, or that
// gives a category the section name 「未归类」, re-creates the mislabel without a single red test.
//
// `compose.ts` is not imported here: it pulls in `../db.ts`, and this check needs only the vocabulary.
// The coupling is pinned by reading the source text instead — if those derivations are rewritten, the
// assertions below say so and the expected values must be re-derived on purpose, not edited to pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES, RELEASE_CATEGORY_KEY } from "@aihot/industry/taxonomy";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

/** The sections this pack declares, in the order compose.ts derives them. Fixed on purpose. */
const EXPECTED_SECTIONS = ["学科", "技术"];
/** The bucket for uncategorised entries: `compose.ts` `DEFAULT_SECTION`. It is not a section name. */
const FALLBACK_BUCKET = "未归类";

/** compose.ts:19 — the same expression, not an import of the module's private constant. */
const sectionOrder = [...new Set(CATEGORIES.map((c) => c.section))];

test("the daily's sections are the two declared names, and the uncategorised bucket is neither of them", () => {
  assert.deepEqual(sectionOrder, EXPECTED_SECTIONS, `日报分节必须逐字等于 ${EXPECTED_SECTIONS.join("/")}（实际 ${sectionOrder.join("/")}）`);
  for (const c of CATEGORIES) {
    assert.equal(EXPECTED_SECTIONS.includes(c.section), true, `类别 ${c.key} 带了第三个分节「${c.section}」——新类别必须复用 ${EXPECTED_SECTIONS.join("/")} 之一`);
    assert.notEqual(c.section, FALLBACK_BUCKET, `类别 ${c.key} 不许占用「${FALLBACK_BUCKET}」：那是没有类别的条目专用的桶，一旦被某个类别声明，未分类条目就又会被印成那个类别的名字`);
  }
});

test("compose.ts files uncategorised items in the declared bucket and counts releases by category key", () => {
  const source = readFileSync(new URL("../packages/backend/src/reports/compose.ts", import.meta.url), "utf8");
  assert.ok(source.includes("const SECTION_ORDER = [...new Set(CATEGORIES.map((c) => c.section))];"), "compose.ts 的分节算式变了：本文件的死值要跟着重新推一遍，别改测试来让它通过");
  assert.ok(source.includes(`const DEFAULT_SECTION = "${FALLBACK_BUCKET}";`), "compose.ts 的兜底桶不再是声明的名字（大概又回到了 SECTION_ORDER.at(-1)）：那正是 2026-10-03 之后会印错节名的写法");
  assert.ok(source.includes("const REPORT_SECTIONS = [...SECTION_ORDER, DEFAULT_SECTION];"), "compose.ts 不再把兜底桶接在分节顺序末尾打印：未分类条目会从日报上消失");
  assert.ok(source.includes("c.category === RELEASE_CATEGORY_KEY"), `日报的「${RELEASE_CATEGORY_KEY} 发布数」指标不再按条目自己的类别计数：按分节桶计数会把未分类的条目算成技术与数据发布`);
  // The release metric's category must still exist, or the front page silently prints one fewer statistic.
  assert.equal(CATEGORIES.some((c) => c.key === RELEASE_CATEGORY_KEY), true, `词表里没有 ${RELEASE_CATEGORY_KEY} 这个类别了，报眼那条指标会静默消失`);
  // Two more positions other code reads: `llms.ts:49` prints CATEGORY_KEYS[0] as the example slug and
  // `apps/web/tests/cache.test.ts:91` filters by `.at(-1)`.
  assert.equal(CATEGORY_KEYS[0], "physical", "llms.txt 的示例 slug 是首键，改成别的键等于对外的订阅示例换人");
  assert.equal(CATEGORY_KEYS.at(-1), "geoedu", "cache.test.ts 用末键筛一遍；2026-10-03 换位与删类之后末键是 geoedu（考研）");
});
