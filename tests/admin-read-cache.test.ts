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
