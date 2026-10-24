import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedAdminRead } from "@aihot/backend/admin/read-cache";

test("simultaneous admin reads share one snapshot and failed reads remain retryable", async () => {
  let calls = 0;
  let release!: (n: number) => void;
  const read = sharedAdminRead(1000, () => { calls++; return new Promise<number>(resolve => { release = resolve; }); });
  const first = read();
  const second = read();
  assert.equal(calls, 1);
  release(42);
  assert.deepEqual(await Promise.all([first, second, read()]), [42,42,42]);
  assert.equal(calls, 1);
  let attempts = 0;
  const recover = sharedAdminRead(1000, async () => { if (++attempts === 1) throw new Error("busy"); return 7; });
  await assert.rejects(recover(), /busy/);
  assert.equal(await recover(), 7);
  assert.equal(attempts, 2);
});

test("transient failures may return an explicitly stale bounded snapshot without renewing it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let fail = false;
  const read = sharedAdminRead(10, async () => {
    if (fail) throw Object.assign(new Error("statement timeout"), { code: "57014" });
    return { checkedAt: Date.now(), stale: false };
  }, { staleIfErrorMs: 100, canUseStale: e => (e as { code?: string }).code === "57014", markStale: v => ({ ...v, stale: true }) });
  assert.deepEqual(await read(), { checkedAt: 1000, stale: false });
  fail = true; t.mock.timers.tick(11);
  assert.deepEqual(await read(), { checkedAt: 1000, stale: true });
  t.mock.timers.tick(100);
  await assert.rejects(read(), /statement timeout/);
});

test("stale snapshots never conceal a non-transient programming error", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let fail = false;
  const read = sharedAdminRead(10, async () => {
    if (fail) throw new Error("invalid query");
    return 3;
  }, { staleIfErrorMs: 100, canUseStale: e => (e as { code?: string }).code === "57014", markStale: v => v });
  assert.equal(await read(), 3); fail = true; t.mock.timers.tick(11);
  await assert.rejects(read(), /invalid query/);
});
