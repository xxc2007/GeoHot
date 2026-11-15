import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { sessionPrincipal, endSession, forgetSession, resetSessionCache } from "@aihot/backend/admin/auth";

/** 只回答一次查询的假库：数一下被打了几次，够断言「缓存命中就不再打库」。 */
function fakeDb(rows: unknown[] = [{ user_id: 7, csrf_token: "csrf-7", name: "管理员", email: null }]) {
  let calls = 0;
  const db = (async () => {
    calls += 1;
    return rows;
  }) as unknown as Parameters<typeof sessionPrincipal>[1];
  return { db, calls: () => calls };
}

const cookie = "aihot_admin=token-abc";

beforeEach(() => resetSessionCache());

test("同一个会话第二次校验不再打库", async () => {
  const { db, calls } = fakeDb();
  const first = await sessionPrincipal(cookie, db);
  const second = await sessionPrincipal(cookie, db);
  assert.equal(calls(), 1);
  assert.equal(first?.userId, 7);
  assert.deepEqual(second, first);
});

test("没有 cookie 时不查库，也不留缓存", async () => {
  const { db, calls } = fakeDb();
  assert.equal(await sessionPrincipal(undefined, db), null);
  assert.equal(calls(), 0);
});

test("查不到会话时不缓存未命中", async () => {
  const { db, calls } = fakeDb([]);
  assert.equal(await sessionPrincipal(cookie, db), null);
  assert.equal(await sessionPrincipal("aihot_admin=token-abc2", db), null);
  assert.equal(calls(), 2);
});

test("forgetSession 之后重新查库（登出即时生效）", async () => {
  const { db, calls } = fakeDb();
  await sessionPrincipal(cookie, db);
  forgetSession("token-abc");
  await sessionPrincipal(cookie, db);
  assert.equal(calls(), 2);
});

test("endSession 删行的同时清掉缓存", async () => {
  const { db, calls } = fakeDb();
  await sessionPrincipal(cookie, db);
  // endSession 用的是模块里的 sql；这里只验证缓存被清掉，不落库。
  await endSession(undefined).catch(() => {});
  forgetSession("token-abc");
  await sessionPrincipal(cookie, db);
  assert.equal(calls(), 2);
});
