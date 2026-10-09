// 出口对称性：加一个分类时，机器可读的出口必须一起认得它。
// 2026-10-03 本地实测：四个新分类在 v1 的 `category=`、`/feed/category/<key>.xml`、MCP 工具的枚举里都能用
// （分类表是唯一来源，各处都从它推导）。这个文件把"推导"这件事钉住——它断言的是**共享的词表**
// （v1/RSS 用的 `isFeedCategory`、MCP 工具用的 `PUBLIC_API_CATEGORY_KEYS` 都从 `CATEGORY_KEYS` 推导），
// 而不是 MCP 的处理函数本身；MCP 那条链在本地是对着真接口 curl 验的（host 头 + tools/list）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { CATEGORY_KEYS, CATEGORY_LABELS, PUBLIC_API_CATEGORY_KEYS, isCategoryKey, toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { isFeedCategory } from "@aihot/backend/publication/feeds";

test("每个分类都能进 v1、RSS 分类订阅与 MCP 的枚举，且只有它们能", () => {
  for (const key of CATEGORY_KEYS) {
    assert.equal(toPublicApiCategory(key), key, `v1 认不出 ${key}`);
    assert.equal(isFeedCategory(key), true, `/feed/category/${key}.xml 不认 ${key}`);
    assert.equal(isCategoryKey(key), true);
    assert.ok(CATEGORY_LABELS[key], `${key} 没有标签`);
  }
  assert.equal(isFeedCategory("no-such-category"), false, "不认识的 key 必须被拒（线上返回 404）");
  assert.equal(toPublicApiCategory("no-such-category"), null);
  assert.deepEqual([...PUBLIC_API_CATEGORY_KEYS], [...CATEGORY_KEYS], "公开接口的枚举必须就是分类表本身");
});

test("筛选栏与各处出口的词表是七个分类，「前沿地理」紧挨在「地理信息系统」之前", () => {
  // 2026-10-03 站长要求把「地理信息系统」与「考研」换位；2026-10-09 删掉「考研」`geoedu`（原来那条相对
  // 次序断言因此没有对象了——indexOf 找不到 key 返回 -1，会假红），同日站长要求新增「前沿地理」`frontier`
  // 并指定它排在「地理信息系统」之前。这里钉三件事：词表七个、frontier 紧跟在 geotech 前面、geotech 仍是
  // 末位键（`cache.test.ts` 与 report-default-section.test.ts 都按末键取值）。
  assert.equal(CATEGORY_KEYS.length, 7, "本站七个分类（industry/taxonomy.ts 的 CATEGORIES）");
  assert.equal(
    CATEGORY_KEYS.indexOf("frontier" as never),
    CATEGORY_KEYS.indexOf("geotech" as never) - 1,
    "「前沿地理」必须排在「地理信息系统」前面一格（站长 2026-10-09 指定，这一格就是筛选栏的顺序）",
  );
  assert.equal(CATEGORY_KEYS.at(-1), "geotech", "「地理信息系统」仍是末位键：按末键取值的两处测试都依赖它");
});

test("日报的分节没有被新分类挤动（兜底分节仍由首现顺序决定）", () => {
  // 与 tests/report-default-section.test.ts 同源：这里只复查七个分类之后的首现顺序仍是两节。
  // 2026-10-03：「野外与考察」「观点与解读」连同「实践」那一节一起删掉，兜底分节由「实践」变成「技术」。
  const order = [...new Set(CATEGORIES.map((c) => c.section))];
  assert.deepEqual(order, ["学科", "技术"]);
  assert.equal(order.at(-1), "技术", "未分类条目的兜底分节");
});
