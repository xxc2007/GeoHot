// 出口对称性：加一个分类时，机器可读的出口必须一起认得它。
// 2026-10-03 本地实测：四个新分类在 v1 的 `category=`、`/feed/category/<key>.xml`、MCP 工具的枚举里都能用
// （分类表是唯一来源，各处都从它推导）。这个文件把"推导"这件事钉住——它断言的是**共享的词表**
// （v1/RSS 用的 `isFeedCategory`、MCP 工具用的 `PUBLIC_API_CATEGORY_KEYS` 都从 `CATEGORY_KEYS` 推导），
// 而不是 MCP 的处理函数本身；MCP 那条链在本地是对着真接口 curl 验的（host 头 + tools/list）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { CATEGORY_KEYS, CATEGORY_LABELS, PUBLIC_API_CATEGORY_KEYS, isCategoryKey, toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { isFeedCategory } from "@aihot/backend/publication/feeds";
import { REPO_ROOT } from "@aihot/backend/config";

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

test("板块声明的分类与标签都在词表里——加板块不能写一个不存在的分类", () => {
  const boards = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/boards.json"), "utf8")) as {
    boards: Array<{ slug: string; categories: string[]; plate: string }>;
  };
  assert.ok(boards.boards.length >= 4, "四个跨类别板块");
  const slugs = boards.boards.map((b) => b.slug);
  assert.equal(new Set(slugs).size, slugs.length, "板块 slug 不能重复");
  const plates = new Set(boards.boards.map((b) => b.plate));
  assert.equal(plates.size, boards.boards.length, "每个板块一枚图记，不能两处共用");
  for (const b of boards.boards) {
    assert.ok(b.categories.length > 0, `${b.slug} 至少要挂一个分类`);
    for (const c of b.categories) assert.ok(isCategoryKey(c), `${b.slug} 的分类 ${c} 不在词表里`);
  }
  // /boards 的四块不按词表位置整体排序（板块顺序历来是站长的编排，不是词表的投影），但 2026-10-03 站长要求
  // 「考研」与「地理信息系统」换位，筛选栏与板块页两处必须一起换——否则会出现「筛选栏里地理信息系统在前、
  // 板块页里考研在前」。所以这里钉住的是这两块的相对次序，而不是四块的整体次序。
  const order = boards.boards.map((b) => b.slug);
  assert.ok(
    order.indexOf("gis") < order.indexOf("kaoyan-geo"),
    `板块页里「地理信息系统」必须排在「考研」之前（实际 ${order.join(" → ")}）`,
  );
  assert.ok(
    CATEGORY_KEYS.indexOf("geotech" as never) < CATEGORY_KEYS.indexOf("geoedu" as never),
    "筛选栏里「地理信息系统」必须排在「考研」之前（industry/taxonomy.ts 的 CATEGORIES 顺序）",
  );
});

test("日报的分节没有被新分类挤动（兜底分节仍由首现顺序决定）", () => {
  // 与 tests/report-default-section.test.ts 同源：这里只复查七个分类之后的首现顺序仍是两节。
  // 2026-10-03：「野外与考察」「观点与解读」连同「实践」那一节一起删掉，兜底分节由「实践」变成「技术」。
  const order = [...new Set(CATEGORIES.map((c) => c.section))];
  assert.deepEqual(order, ["学科", "技术"]);
  assert.equal(order.at(-1), "技术", "未分类条目的兜底分节");
});
