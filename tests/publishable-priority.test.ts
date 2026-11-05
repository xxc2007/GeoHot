import test from "node:test";
import assert from "node:assert/strict";
import { PUBLISHABLE_BOOST, realTimePriority } from "@aihot/backend/operations/resource-budget";

// 2026-11-05 现场：analyze 队列里 7,432 条 `created`，大头是只准摘要、永不公开的来信，
// 把 284 篇能公开的条目堵在后面。这条用例钉住"能过读者门禁的活先跑"这一挡。
test("a publishable item outranks an unpublishable one observed at the same minute", () => {
  process.env.GEOHOT_RESOURCE_PROFILE = "balanced";
  try {
    const observedAt = Date.now();
    const base = { historical: false, archive: false, signal: false, observedAt };
    const publishable = realTimePriority({ ...base, publishable: true });
    const unpublishable = realTimePriority({ ...base, publishable: false });
    assert.equal(publishable - unpublishable, PUBLISHABLE_BOOST, "the boost is exactly the documented constant");
    assert.ok(publishable > unpublishable, "higher priority is served first");

    // 一个更早、可公开的条目也只输给比它新一分钟的不可公开条目——除非超过这一挡的跨度。
    const older = realTimePriority({ ...base, publishedAt: 0, observedAt: observedAt - 60 * 60_000, publishable: true } as never);
    assert.ok(older > unpublishable, "an hour-old publishable item still leads a fresh unpublishable one");
  } finally {
    delete process.env.GEOHOT_RESOURCE_PROFILE;
  }
});

test("the boosted priority stays inside the integer range pg-boss accepts", () => {
  process.env.GEOHOT_RESOURCE_PROFILE = "balanced";
  try {
    for (const observedAt of [0, Date.now(), Date.now() + 3_600_000]) {
      const priority = realTimePriority({ historical: false, archive: false, signal: true, observedAt, publishable: true });
      assert.ok(Number.isSafeInteger(priority), "integer");
      assert.ok(priority <= 2_147_483_646 && priority >= -2, `inside pg-boss range, got ${priority}`);
    }
  } finally {
    delete process.env.GEOHOT_RESOURCE_PROFILE;
  }
});

test("without the balanced profile nothing is boosted (local runs keep their order)", () => {
  delete process.env.GEOHOT_RESOURCE_PROFILE;
  const observedAt = Date.now();
  assert.equal(realTimePriority({ historical: false, archive: false, signal: false, observedAt, publishable: true }), 0);
  assert.equal(realTimePriority({ historical: false, archive: false, signal: false, observedAt, publishable: false }), 0);
});