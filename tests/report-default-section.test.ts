// The daily paper's fallback bucket is computed from the *position* of a field, not from a declared name:
// `reports/compose.ts:19-21` builds SECTION_ORDER as the first-appearance order of `CATEGORIES[].section`
// and takes `SECTION_ORDER.at(-1)` as DEFAULT_SECTION, the section every entry without a category is filed
// under (`compose.ts:162` `?? DEFAULT_SECTION`). So appending a category that carries a fourth section name
// — or that pushes 「实践」 off the end of that derived list — silently moves every uncategorised item into
// the new section. No type and no other test notices. This file pins the three names and the fallback
// itself, so such an append fails here instead of re-arranging tomorrow's edition.
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
const EXPECTED_SECTIONS = ["学科", "技术", "实践"];
/** The bucket for uncategorised entries: `SECTION_ORDER.at(-1)` in compose.ts:21. */
const EXPECTED_DEFAULT_SECTION = "实践";

/** compose.ts:19 — the same expression, not an import of the module's private constant. */
const sectionOrder = [...new Set(CATEGORIES.map((c) => c.section))];

test("the daily paper's section order and fallback bucket are the three declared names, in that order", () => {
  assert.deepEqual(sectionOrder, EXPECTED_SECTIONS, `日报分节必须逐字等于 ${EXPECTED_SECTIONS.join("/")}（实际 ${sectionOrder.join("/")}）`);
  assert.equal(sectionOrder.at(-1), EXPECTED_DEFAULT_SECTION, `兜底分节必须是「${EXPECTED_DEFAULT_SECTION}」：compose.ts 把没有类别的资料都写进那一节`);
  // The invariant the pack's own header comment states: the fallback section is still the one the array ends with.
  assert.equal(CATEGORIES.at(-1)!.section, EXPECTED_DEFAULT_SECTION, `CATEGORIES 末位（${CATEGORIES.at(-1)!.key}）的 section 必须仍是「${EXPECTED_DEFAULT_SECTION}」，否则未分类资料一夜之间换节`);
  for (const c of CATEGORIES) {
    assert.equal(EXPECTED_SECTIONS.includes(c.section), true, `类别 ${c.key} 带了第四个分节「${c.section}」——新类别必须复用 ${EXPECTED_SECTIONS.join("/")} 之一`);
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
  assert.equal(CATEGORY_KEYS.at(-1), "comment", "cache.test.ts 用末键筛一遍，改成别的键它就不再覆盖「观点与解读」那条链");
});
