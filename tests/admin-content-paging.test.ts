// 「最近入库」要能一直往下拉（2026-11-07 站长要求）：页大小由页面递增着给，
// 而「还有没有下一页」必须靠多取一行判断——尾页正好满一页时，靠「满页」推断会让下一页落到空表。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(p, "utf8");

test("最近入库按页给，并且用多取一行判断还有没有下一页", () => {
  const source = read("packages/backend/src/admin/content.ts");
  assert.match(source, /export async function searchContent\(q: string, limit = 60\)/, "页大小要能从调用方给");
  assert.ok(source.includes("Math.min(Math.max(Math.trunc(limit) || 60, 1), 600)"), "上限 600，防止一次拉穿库");
  assert.ok(source.includes("run(take + 1)"), "多取一行");
  assert.ok(source.includes("hasMore: rows.length > take"), "多出来的那行切成 hasMore");
  assert.equal((source.match(/LIMIT \$\{take\}/g) ?? []).length, 2, "空查询与带词查询都要按页给");
});

test("页面按滚动加页，且不打断回退", () => {
  const page = read("apps/web/app/routes/admin/content.tsx");
  assert.ok(page.includes("limit") && page.includes("hasMore"), "页面要拿到页大小与是否到底");
  assert.ok(page.includes("IntersectionObserver"), "下拉到底要能自动加页");
  assert.ok(page.includes("preventScrollReset: true"), "加页不能把操作者弹回顶部");
  assert.ok(page.includes("replace: true"), "加页不写新的历史项");
});

test("接口把 limit 透传给查询", () => {
  const api = read("apps/api/src/routes/admin.ts");
  assert.ok(api.includes('searchContent(q(req).q ?? "", Number(q(req).limit ?? 60) || 60)'), "接口要认 limit");
});
