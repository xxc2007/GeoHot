// 2026-11-18 事故回归：容量闸的槽位释放必须独立于 work promise 是否 settle。
// 旧实现把还槽挂在 `await work()` 的 finally 上，底层承诺永不 settle（半开 socket / 挂死查询）
// 时槽位被永久占住，后续请求 1–3 ms 内被拒。这里用纯内存 fake 工作钉住：
//  1. 永不 settle 的工作在墙钟超时后被强制还槽；
//  2. 迟到的 settle 只释放一次，active 计数不为负、不再占新槽；
//  3. 并发上限与队满当场拒绝；
//  4. 排队等待也有界；
//  5. 名额随唤醒移交，等待者最终都被执行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CapacityExceeded, CapacityGate, CapacityTimeout } from "@aihot/backend/lib/capacity";

const hang = () => new Promise<never>(() => {});

test("永不 settle 的工作在超时后被强制还槽，后续工作能拿到名额", async () => {
  const gate = new CapacityGate(1, 0);
  const timedOut = await gate.run(hang, { timeoutMs: 20 }).catch((e: unknown) => e);
  assert.ok(timedOut instanceof CapacityTimeout, "超时必须抛 CapacityTimeout");
  assert.equal(gate.activeCount, 0, "槽位已独立归还，active 回到 0");
  const result = await gate.run(async () => "ok", { timeoutMs: 1_000 });
  assert.equal(result, "ok");
  assert.equal(gate.activeCount, 0);
});

test("迟到 settle 不重复还槽、不产生负计数", async () => {
  const gate = new CapacityGate(1, 0);
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => { releaseLate = resolve; });
  const timedOut = await gate.run(() => late, { timeoutMs: 20 }).catch((e: unknown) => e);
  assert.ok(timedOut instanceof CapacityTimeout);
  releaseLate(); // 迟到 settle：此时槽位已被超时归还
  await delay(20);
  assert.equal(gate.activeCount, 0, "迟到 settle 不得把计数减成负数");
  const result = await gate.run(async () => "second", { timeoutMs: 1_000 });
  assert.equal(result, "second");
  assert.equal(gate.activeCount, 0);
});

test("并发上限：满员且无排队位时当场 CapacityExceeded", async () => {
  const gate = new CapacityGate(2, 0);
  const first = gate.run(async () => { await delay(60); return 1; });
  const second = gate.run(async () => { await delay(60); return 2; });
  await delay(10);
  const overflow = await gate.run(async () => 3).catch((e: unknown) => e);
  assert.ok(overflow instanceof CapacityExceeded, "队满当场拒绝，不排队");
  assert.equal(gate.activeCount, 2);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(gate.activeCount, 0);
});

test("排队等待有界：排不到名额在 queueTimeoutMs 处被拒", async () => {
  const gate = new CapacityGate(1, 1);
  const holder = gate.run(async () => { await delay(120); return "held"; });
  await delay(10);
  const queued = gate.run(async () => "queued", { queueTimeoutMs: 30 }).catch((e: unknown) => e);
  assert.ok((await queued) instanceof CapacityTimeout, "排队超时抛 CapacityTimeout");
  assert.equal(gate.queuedCount, 0);
  assert.equal(await holder, "held");
  assert.equal(gate.activeCount, 0);
});

test("名额随唤醒移交：等待者最终都被执行，峰值不超过上限", async () => {
  const gate = new CapacityGate(1, 2);
  let peak = 0;
  const job = () => gate.run(async () => {
    peak = Math.max(peak, gate.activeCount);
    await delay(15);
    return "done";
  });
  const results = await Promise.all([job(), job(), job()]);
  assert.deepEqual(results, ["done", "done", "done"]);
  assert.ok(peak <= 1, `峰值并发不超过 1，实测 ${peak}`);
  assert.equal(gate.activeCount, 0);
});
