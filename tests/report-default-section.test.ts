// The daily paper's fallback bucket is computed from the *position* of a field, not from a declared name:
// `reports/compose.ts:19-21` builds SECTION_ORDER as the first-appearance order of `CATEGORIES[].section`
// and takes `SECTION_ORDER.at(-1)` as DEFAULT_SECTION, the section every entry without a category is filed
// under (`compose.ts:162` `?? DEFAULT_SECTION`). So appending a category that carries a third section name
// silently moves every uncategorised item into the new section. No type and no other test notices. This file
// pins the two names and the fallback itself, so such an append fails here instead of re-arranging
// tomorrow's edition.
//
// 2026-10-03 (owner's request): 「野外与考察」与「观点与解读」两个类别连同它们那一节「实践」一起删掉，
// 「地理信息系统」提到「考研」之前。分节因此只剩两节，兜底分节从「实践」变成「技术」。注意这一天的
// 另一个后果：**末位类别（geoedu 考研）的 section 已经不再是兜底分节**——兜底由首现顺序决定，不由数组
// 末位决定，两者在过去只是恰好重合。下面第 30 行那条断言因此改成「兜底分节必须真的被某个类别用着」。
//
// `compose.ts` is imported nowhere in this file: it pulls in `../db.ts`, and this check needs only the
// vocabulary. The coupling is pinned by reading the source text instead — if that derivation is rewritten,
// the assertion below says so and the expected list here has to be re-derived on purpose.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORIES, RELEASE_CATEGORY_KEY } from "@aihot/industry/taxonomy";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

/** The sections this pack declares, in the order compose.ts derives them. Fixed on purpose. */
const EXPECTED_SECTIONS = ["学科", "技术"];
/** The bucket for uncategorised entries: `SECTION_ORDER.at(-1)` in compose.ts:21. */
const EXPECTED_DEFAULT_SECTION = "技术";

/** compose.ts:19 — the same expression, not an import of the module's private constant. */
const sectionOrder = [...new Set(CATEGORIES.map((c) => c.section))];

test("the daily paper's section order and fallback bucket are the two declared names, in that order", () => {
  assert.deepEqual(sectionOrder, EXPECTED_SECTIONS, `日报分节必须逐字等于 ${EXPECTED_SECTIONS.join("/")}（实际 ${sectionOrder.join("/")}）`);
  assert.equal(sectionOrder.at(-1), EXPECTED_DEFAULT_SECTION, `兜底分节必须是「${EXPECTED_DEFAULT_SECTION}」：compose.ts 把没有类别的资料都写进那一节`);
  // The fallback must be a section some category actually carries: a bucket no category declares would file
  // uncategorised entries under a heading the rest of the paper never produces.
  assert.equal(CATEGORIES.some((c) => c.section === EXPECTED_DEFAULT_SECTION), true, `兜底分节「${EXPECTED_DEFAULT_SECTION}」必须至少被一个类别用着，否则未分类资料会落进一节没人声明的节`);
  for (const c of CATEGORIES) {
    assert.equal(EXPECTED_SECTIONS.includes(c.section), true, `类别 ${c.key} 带了第三个分节「${c.section}」——新类别必须复用 ${EXPECTED_SECTIONS.join("/")} 之一`);
  }
});

test("compose.ts still derives the bucket from that order, and the release metric still anchors a real section", () => {
  const source = readFileSync(new URL("../packages/backend/src/reports/compose.ts", import.meta.url), "utf8");
  assert.ok(source.includes("const SECTION_ORDER = [...new Set(CATEGORIES.map((c) => c.section))];"), "compose.ts 的分节算式变了：本文件的死值要跟着重新推一遍，别改测试来让它通过");
  assert.ok(source.includes("const DEFAULT_SECTION = SECTION_ORDER.at(-1)!;"), "compose.ts 的兜底分节算式变了：同上");
  // compose.ts:23 + :184 feed the paper's 报眼 metric; an anchor that finds no section reads as "0 releases"
  // and the whole metric line disappears without an error (`format.ts:225` filters it out).
  const releaseSection = CATEGORIES.find((c) => c.key === RELEASE_CATEGORY_KEY)?.section;
  assert.equal(releaseSection, "技术", `日报的发布数量指标锚在 ${RELEASE_CATEGORY_KEY} 的分节上，那一节必须还是「技术」`);
  assert.equal(EXPECTED_SECTIONS.includes(releaseSection ?? ""), true, "指标锚定的分节要在分节顺序里");
  // Two more positions other code reads: `llms.ts:49` prints CATEGORY_KEYS[0] as the example slug and
  // `apps/web/tests/cache.test.ts:91` filters by `.at(-1)`. Both were stable when the four new categories
  // landed (they were inserted before 野外与考察, not appended), and this is what keeps that true.
  assert.equal(CATEGORY_KEYS[0], "physical", "llms.txt 的示例 slug 是首键，改成别的键等于对外的订阅示例换人");
  assert.equal(CATEGORY_KEYS.at(-1), "geoedu", "cache.test.ts 用末键筛一遍；2026-10-03 换位与删类之后末键是 geoedu（考研）");
});
