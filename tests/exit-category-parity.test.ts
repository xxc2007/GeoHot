// 出口对称性：加一个分类时，机器可读的出口必须一起认得它。
// 2026-10-03 本地实测：四个新分类在 v1 的 `category=`、`/feed/category/<key>.xml`、MCP 工具的枚举里都能用
// （分类表是唯一来源，各处都从它推导）。这个文件把"推导"这件事钉住，免得下一轮有人在某处抄一份字面量。
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
});

test("日报的分节没有被新分类挤动（兜底分节仍由数组末位决定）", () => {
  // 与 tests/report-default-section.test.ts 同源：这里只复查 10 个分类之后的首现顺序仍是三节。
  const order = [...new Set(CATEGORIES.map((c) => c.section))];
  assert.deepEqual(order, ["学科", "技术", "实践"]);
  assert.equal(order.at(-1), "实践", "未分类条目的兜底分节");
});
