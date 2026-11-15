import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { cachePage, peekPage, resetPageCaches } from "@aihot/backend/admin/page-cache";

beforeEach(() => resetPageCaches());

test("新鲜期内不再调用 load", async () => {
  let calls = 0;
  const load = async () => { calls += 1; return { v: calls }; };
  const a = await cachePage("t1", "k", load, { freshMs: 60_000 });
  const b = await cachePage("t1", "k", load, { freshMs: 60_000 });
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test("过期的旧值先给，load 在后台补一次", async () => {
  let calls = 0;
  const load = async () => { calls += 1; return { v: calls }; };
  const first = await cachePage("t2", "k", load, { freshMs: 1, staleMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5)); // 跨过 1 毫秒的新鲜期
  const second = await cachePage("t2", "k", load, { freshMs: 1, staleMs: 60_000 });
  assert.deepEqual(first, { v: 1 });
  assert.deepEqual(second, { v: 1 }, "过期时先给旧值");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, "后台补过一次");
  assert.deepEqual(peekPage<{ v: number }>("t2", "k", { freshMs: 1, staleMs: 60_000 })?.data, { v: 2 });
});

test("重算失败时仍给旧值，没有旧值才抛", async () => {
  await cachePage("t3", "k", async () => ({ v: 1 }), { freshMs: 0, staleMs: 60_000 });
  const stale = await cachePage("t3", "k", async () => { throw new Error("boom"); }, { freshMs: 0, staleMs: 60_000 });
  assert.deepEqual(stale, { v: 1 });
  await assert.rejects(
    () => cachePage("t3", "none", async () => { throw new Error("boom"); }, { freshMs: 0, staleMs: 0 }),
    /boom/,
  );
});

test("同一个 key 的并发请求只跑一次 load", async () => {
  let calls = 0;
  const load = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { v: calls }; };
  const [a, b, c] = await Promise.all([
    cachePage("t4", "k", load),
    cachePage("t4", "k", load),
    cachePage("t4", "k", load),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});
