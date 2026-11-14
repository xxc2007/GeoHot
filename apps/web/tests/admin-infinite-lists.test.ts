// 站长 2026-11-14：后台不能再有「上一页／下一页」。三个后台列表（审计、反馈、信源）改成滚到底续读，
// 这里守着两件事：列表页不许再 import Pager，续读组件必须真的挂在页面上。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const pages = ["audit", "feedback", "sources"] as const;

for (const page of pages) {
  test(`admin/${page} 滚到底续读，不再有上一页／下一页`, async () => {
    const source = await readFile(new URL(`../app/routes/admin/${page}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /Pager/, `${page} 仍在用 Pager`);
    assert.match(source, /useInfiniteRows/, `${page} 没有接续读 hook`);
    assert.match(source, /<LoadMore\b/, `${page} 没有挂续读哨兵`);
  });
}

test("续读组件提前 600px 触发，失败给一次重试", async () => {
  const source = await readFile(new URL("../app/features/admin/infinite.tsx", import.meta.url), "utf8");
  assert.match(source, /rootMargin:\s*"600px 0px"/);
  assert.match(source, /再试一次/);
});
