import assert from "node:assert/strict";
import test from "node:test";
import { ResourceBudget, RECURRING_TASK_SLOTS } from "../packages/backend/src/operations/resource-budget.ts";

/**
 * 2026-11-07 现场：杭州只有一个循环任务名额，`cron.content.translate` 几乎每次都被
 * sweep/rank/digest 占住，译文永远不 complete，读者面整天没有新内容。
 */
const healthy = { availableMiB: 900, memoryFull: 0, ioFull: 0, cpuSome: 0.1, loadPerCpu: 0.05, diskFreeMiB: 29_000 };

function deferred<T>() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { gate, release };
}

test("a translation can run alongside one regular scan, and a third job waits", async () => {
  assert.equal(RECURRING_TASK_SLOTS, 2);
  const budget = new ResourceBudget();
  const a = deferred<void>();
  const b = deferred<void>();
  const now = Date.now();

  // 队列默认是暂停的：先喂两个健康样本把 30 秒恢复窗走完，再谈名额。
  await budget.run("content.sweep", async () => "warm", healthy, now - 31_000, true);
  await budget.run("content.sweep", async () => "warm", healthy, now, true);

  const first = budget.run("content.sweep", () => a.gate, healthy, now, true);
  const second = budget.run("content.translate", () => b.gate, healthy, now, true);
  const third = await budget.run("hot.rank", async () => "ran", healthy, now, true);

  assert.deepEqual(third, { deferred: true, reason: "recurring-task-slot-busy" }, "third concurrent scan waits");

  a.release();
  b.release();
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);

  const after = await budget.run("hot.rank", async () => "ran", healthy, now, true);
  assert.equal(after, "ran", "slot is released once the pair finishes");
});

test("a pressured sample still pauses the queue before any slot arithmetic", async () => {
  const budget = new ResourceBudget();
  const stressed = { ...healthy, availableMiB: 32, memoryFull: 40 };
  const result = await budget.run("content.translate", async () => "ran", stressed, Date.now(), true);
  assert.equal((result as { deferred?: boolean }).deferred, true);
  assert.equal((result as { reason?: string }).reason, "resource-pressure");
});