import "./setup.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { topicsFor } from "../packages/backend/src/publication/topic-assign.ts";
import type { TopicRow } from "../packages/backend/src/publication/topics.ts";

const topic = (over: Partial<TopicRow> & { slug: string }): TopicRow => ({
  name: over.slug,
  grp: "field",
  entity_id: null,
  tags: [],
  keywords: [],
  definition: "",
  related: [],
  position: 0,
  ...over,
});

const topics: TopicRow[] = [
  topic({ slug: "earthquakes", tags: ["地震"] }),
  topic({ slug: "cenc", entity_id: "cenc", tags: ["中国地震台网"] }),
  topic({ slug: "geopolitics", tags: ["政治地理"], keywords: ["关税", "制裁"] }),
  topic({ slug: "economic-geography", tags: ["经济地理"], keywords: ["供应链", "通胀"] }),
];

test("标签撞上就是 tags 归因，机构主题吃 entity: 前缀", () => {
  const hits = topicsFor({ title: "某地发生 5.0 级地震", summary: null, category: null, tags: ["地震", "entity:cenc"] }, topics);
  assert.deepEqual(hits.map((h) => h.slug).sort(), ["cenc", "earthquakes"]);
  assert.equal(hits.find((h) => h.slug === "cenc")?.source, "tags");
});

test("粗标签条目靠关键词落进专题，而不是掉在主题之外", () => {
  const hits = topicsFor({ title: "美欧就关税与供应链达成新安排", summary: null, category: null, tags: ["非地理/通用"] }, topics);
  assert.deepEqual(hits.map((h) => h.slug).sort(), ["economic-geography", "geopolitics"]);
  assert.equal(hits.every((h) => h.source === "keyword"), true);
});

test("分类本身就是主题的键时算 category 归因", () => {
  const withCategory = topic({ slug: "urban-geography", tags: ["城市化"], keywords: ["urban"] });
  const hits = topicsFor({ title: "城中村改造", summary: null, category: "urban", tags: [] }, [...topics, withCategory]);
  assert.deepEqual(hits, [{ slug: "urban-geography", source: "category" }]);
});

test("关键词太短（单个字）时不乱归类", () => {
  // 两个汉字的词本身就是有意义的主题词（"关税""地震"），所以只挡一个字的那种。
  const noisy = topic({ slug: "noise", tags: [], keywords: ["的", "了"] });
  const hits = topicsFor({ title: "区域发展的情况", summary: null, category: null, tags: [] }, [noisy]);
  assert.deepEqual(hits, []);
});

test("一条条目同时被标签与关键词命中时只出现一次", () => {
  const hits = topicsFor({ title: "地震后的关税谈判", summary: null, category: null, tags: ["地震"] }, topics);
  assert.deepEqual(hits.map((h) => h.slug).sort(), ["earthquakes", "geopolitics"]);
});