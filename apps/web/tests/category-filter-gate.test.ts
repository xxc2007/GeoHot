// 分类筛选参数在三个出口必须说同一句话。
//
// 2026-10-11 评审波实测：`/geohot/all?category=geoedu`（`geoedu` 已于 2026-10-09 删除）回 200、照常给 40 张
// **没有过滤**的卡片，翻页链接还把那个不存在的键带着走；而 `/api/v1/items?category=geoedu` 回 400
// 「category must be one of …」、`/feed/category/geoedu.xml` 回 404。读者从旧书签或别处的链接进来，看到的
// 是"这个分类有内容"，而内容其实一句都不属于它。
//
// 钉写法而不是钉行为：把 `throw new Response("Not found", { status: 404 })` 那一行删掉，本测试立刻红；
// 而起一次站点逐条点参数是另一件事（scripts/smoke.ts 覆盖线上出口的一致性）。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROUTES = path.resolve(import.meta.dirname, "../app/routes");

test("每个读 ?category= 的路由都不许把词表外的键当成没过滤", () => {
  const readers = readdirSync(ROUTES).filter((f) => /\.tsx$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(path.join(ROUTES, f), "utf8") }))
    .filter((r) => /searchParams\.get\("category"\)/.test(r.src));
  assert.ok(readers.length >= 2, `这条规则要真的扫到东西才算数：只找到 ${readers.length} 个读 category 的路由`);
  for (const r of readers) {
    const reads = (r.src.match(/categoryParam && isCategoryKey\(categoryParam\)/g) ?? []).length;
    const refuses = (r.src.match(/!isCategoryKey\(categoryParam\)[\s\S]{0,80}status: 404/g) ?? []).length;
    assert.equal(refuses, reads, `${r.file}：${reads} 处只在键合法时才用 category，却只有 ${refuses} 处拒绝非法键——非法键于是被当成"没有筛选"`);
  }
});
