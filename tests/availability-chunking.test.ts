// 收藏页把用户收藏的**全部** id 一次发给 /api/site/items/availability。`availability.ts` 原先
// `.slice(0, 500)`：第 501 条起根本没被查过，而"没被查过"在读侧等于"不知道"（`starred.tsx` 只在值
// 严格等于 'unavailable' 时才划掉），于是撤下/未公开的第 501 条以后仍按正常条目渲染，读者只有点进去
// 才发现。现在按 500 一批查完整列表，只留一个总量上限当请求大小的闸门——上限之外是"不回答"，
// 不是编一个结论。（一条评审说旧实现把超出的都报成 unavailable，那是记错了：旧代码只给留在列表里
// 的 id 赋初值。）
//
// 这里不建信源/条目：判定值本身（public / summary-only / withdrawn）由 `publication-copy-gate.test.ts`
// 用真条目钉住，本文件只钉"跨批不漏"这一件事，所以全部用不存在的 id——它们的答案一律是
// 'unavailable'，正好能看出谁没被查到。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { itemAvailability } from "@aihot/backend/publication/availability";

after(closeDb);

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

test("跨过一批上限的收藏列表：每一条都得到答案，没有谁被静默漏掉", async () => {
  const answer = await itemAvailability(ids(501, "starred"));
  assert.equal(Object.keys(answer).length, 501, "501 个 id 进来，501 个 id 出去（旧实现只回 500 个）");
  assert.equal(answer["starred-500"], "unavailable", "最后一个落在第二批里，也被真的查过");
});

test("三批也一样：批与批之间的 id 不会掉进缝里", async () => {
  const answer = await itemAvailability(ids(1_200, "many"));
  assert.equal(Object.keys(answer).length, 1_200);
  for (const at of [0, 499, 500, 999, 1000, 1199]) assert.equal(answer[`many-${at}`], "unavailable", `第 ${at + 1} 个 id 有答案`);
});

test("总量上限只做请求大小闸门：超出的部分不回答，而不是回答成一个结论", async () => {
  const answer = await itemAvailability(ids(5_000, "flood"));
  assert.equal(Object.keys(answer).length, 2_000, "上限之外的一条都不编造答案");
  assert.ok(!("flood-2000" in answer), "第 2001 个 id 不在响应里：读侧据此显示为“未确认”而不是“文章没了”");
});

test("重复与非法的 id 不占名额，也不产生第二个答案", async () => {
  const answer = await itemAvailability(["dup", "dup", "https://evil.example/#javascript:alert(1)", ""]);
  assert.deepEqual(Object.keys(answer).sort(), ["dup"], "去重，且带非法字符的那条根本不进入查询");
  assert.equal(answer["dup"], "unavailable");
});
