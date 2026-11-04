import assert from "node:assert/strict";
import { test } from "node:test";
import { IntakeBudget, intakeQueue, intakeActive, intakeAvailableLanes, intakeBusy } from "../packages/backend/src/operations/resource-intake.ts";
import { resourcePressured } from "../packages/backend/src/operations/resource-budget.ts";
import { r115FenceActive } from "../packages/backend/src/operations/resource-intake.ts";
import { BacklogShare } from "../packages/backend/src/operations/backlog-share.ts";
const { fetchNextJob } = await import(new URL("../node_modules/pg-boss/dist/plans.js", import.meta.url).href);
const claim = (name: string) => fetchNextJob({ schema: "pgboss", table: "job", name, policy: "short", limit: 1 }).text as string;
const healthy = { availableMiB: 180, memoryFull: 0, ioFull: 0, cpuSome: 0, diskFreeMiB: 4000, loadPerCpu: .2 };

test("resource admission recognises installed pg-boss claims and never blocks completion", async () => {
  assert.equal(intakeQueue(claim("content.analyze")), "content.analyze");
  let sent = 0;
  const db = async () => { sent++; return { rows: [{ id: "job" }] }; };
  const budget = new IntakeBudget(true);
  await budget.execute(db, claim("content.analyze"), [], { ...healthy, availableMiB: 20 }, 0, 0);
  assert.equal(sent, 0);
  await budget.execute(db, "UPDATE pgboss.job SET state='completed' WHERE id=$1", ["job"], { ...healthy, availableMiB: 20 }, 1, 0);
  assert.equal(sent, 1);
  await budget.execute(db, claim("content.analyze"), [], healthy, 10_000, 0);
  assert.equal(sent, 1, "recovery window holds claims");
  await budget.execute(db, claim("content.analyze"), [], healthy, 26_000, 0);
  assert.equal(sent, 2);
});

test("combined work respects the total cap and occupied lanes", () => {
  const work = [{ name: "content.analyze", count: 1 }, { name: "sources.fetch", count: 1 }];
  assert.equal(intakeActive("events.group", work, true, 2), 1);
  assert.equal(intakeAvailableLanes(work, true, 2).size, 0);
  assert.equal(intakeActive("content.extract-body", [{ name: "sources.fetch", count: 1 }], true), 1);
});

test("old work receives a bounded share through the existing atomic claim, with unused turns returned", async () => {
  const share = new BacklogShare();
  const queries: string[] = [];
  const db = async (text: string) => { queries.push(text); return { rows: [{ id: "job" }] }; };
  for (let n = 0; n < 10; n++) await share.execute(db, "content.analyze", claim("content.analyze"), [], Date.now());
  assert.equal(queries.filter(q => q.includes("AND j.priority <")).length, 3);
  assert.ok(queries.every(q => q.includes("FOR UPDATE OF j SKIP LOCKED")));
  const empty = new BacklogShare();
  const attempts: string[] = [];
  const fallback = async (text: string) => { attempts.push(text); return { rows: text.includes("AND j.priority <") ? [] : [{ id: "live" }] }; };
  for (let n = 0; n < 3; n++) await empty.execute(fallback, "content.analyze", claim("content.analyze"), [], Date.now());
  assert.equal(attempts.length, 4);
});

// 2026-11-04：生产每小时只完成 21 条 analyze，而单任务 p50 是 51 秒 —— 卡点不是模型，是调用点把
// intakeActive() 的 0/1 当成"全局是否忙"，execute() 见 active>=1 就拒绝一切取任务，于是
// ANALYZE_CONCURRENCY / EXTRACT_CONCURRENCY 从未生效。名额应按 lane 数算（analysis/fetch/processing 各一）。
test("intake admits one job per lane instead of one job per pipeline", () => {
  // 一个 analyze 在跑：analysis lane 占满，但 fetch 与 processing 还空着 ⇒ 不该整条流水线停摆。
  assert.equal(intakeBusy([{ name: "content.analyze", count: 1 }], 3), 0);
  // 两个在跑（analysis + fetch）：还剩 processing 一格。
  assert.equal(intakeBusy([{ name: "content.analyze", count: 1 }, { name: "content.extract-body", count: 1 }], 3), 0);
  // 三格占满才停下来。
  assert.equal(intakeBusy([
    { name: "content.analyze", count: 1 }, { name: "content.extract-body", count: 1 }, { name: "events.group", count: 1 },
  ], 3), 1);
  // 不可控队列不占名额。
  assert.equal(intakeBusy([{ name: "notify.selected", count: 9 }], 3), 0);
  // 没给名额时退回旧行为（任一个在跑就算满），供未改造的调用点与测试使用。
  assert.equal(intakeBusy([{ name: "content.analyze", count: 1 }], undefined), 1);
});

// 阈值旋钮：默认值不变（memoryFull 20 就判压力），但机器可以把门口挪一点，而不必改代码。
test("pressure thresholds stay at the old defaults until an operator moves them", () => {
  const sample = { availableMiB: 140, memoryFull: 25, ioFull: 40, cpuSome: 5, diskFreeMiB: 30000, loadPerCpu: 1 };
  assert.equal(resourcePressured(sample), true, "memoryFull 25 is over the 20 default");
  const before = process.env.GEOHOT_PRESSURE_MEMORY_FULL;
  try {
    process.env.GEOHOT_PRESSURE_MEMORY_FULL = "30";
    assert.equal(resourcePressured(sample), false, "an operator-raised ceiling admits the same machine");
    assert.equal(resourcePressured({ ...sample, memoryFull: 31 }), true, "the new ceiling still bites above it");
  } finally {
    if (before === undefined) delete process.env.GEOHOT_PRESSURE_MEMORY_FULL;
    else process.env.GEOHOT_PRESSURE_MEMORY_FULL = before;
  }
});

// 闸门冻结：读到未过期的截止时间就停领活；文件不存在/已过期/写坏了都当放行（宁可多干活，
// 也不让一个坏文件把整条流水线永久冻死）。
// 闸门冻结：读到未过期的截止时间就停领活；文件不存在/已过期/写坏了都当放行（宁可多干活，
// 也不让一个坏文件把整条流水线永久冻死）。
test("the reader gate freezes intake by file, and a broken file never freezes it forever", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fence-"));
  const path = join(dir, "fence");
  const now = Date.now();
  try {
    assert.equal(r115FenceActive(now, path), false, "no file, no fence");
    writeFileSync(path, `${Math.floor(now / 1000) + 60} 1 fence\n`);
    assert.equal(r115FenceActive(now, path), true, "an unexpired deadline freezes intake");
    writeFileSync(path, `${Math.floor(now / 1000) - 1} 1 fence\n`);
    assert.equal(r115FenceActive(now, path), false, "an expired deadline releases it");
    writeFileSync(path, "closed\n");
    assert.equal(r115FenceActive(now, path), false, "a hand-edited file is not a fence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
