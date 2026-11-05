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

// 2026-11-05：24 小时分析新进 1496 条、只跑完 493 条，而全流水线完成 9142 条 —— 名额被便宜的内部活
// 占满，判「精选」的那条链路排不进去。给它一条饥饿下限：超过 60 秒没领到活，就先于「谁最久没被服务」
// 的轮转顺序轮到自己（名额总数与其它车道的轮次都不变）。
test("an analysis lane starved past the floor takes more turns than the same timeline without it", async () => {
  const go = async (budget: IntakeBudget, queue: string, now: number) => {
    let sent = false;
    const db = async () => { sent = true; return { rows: [{ id: "job" }] }; };
    await budget.execute(db, claim(queue), [], healthy, now, 0, intakeAvailableLanes([], true, 2));
    return sent;
  };
  // 两个车道都在持续轮询（生产里 analyze 每 2–5 秒问一次），谁问都不改变别人的 offer。
  const run = async (budget: IntakeBudget) => {
    assert.equal(await go(budget, "sources.fetch", 0), false, "暂停期不放行");
    assert.equal(await go(budget, "sources.fetch", 20_000), true);
    assert.equal(await go(budget, "content.analyze", 21_000), true);
    let analysisTurns = 0;
    for (let n = 1; n <= 10; n++) {
      // 两次询问至少隔 1 秒（领到活之后有 1 秒冷却），跟线上两条轮询线程的节奏一致。
      const t = 100_000 + n * 4_000;
      await go(budget, "sources.fetch", t);
      if (await go(budget, "content.analyze", t + 1_000)) analysisTurns += 1;
    }
    return analysisTurns;
  };
  const before = process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS;
  try {
    // 下限极小 ⇒ 分析车道每次来都被当作"饿着"，几乎每问必得；下限极大 ⇒ 回到纯轮转。
    process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS = "1";
    const starved = await run(new IntakeBudget(true));
    process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS = "600000";
    const patient = await run(new IntakeBudget(true));
    assert.ok(starved >= 8, `饥饿下限生效时分析链路几乎每问必得（实际 ${starved}/10）`);
    assert.ok(patient <= 5, `下限抬高后回到轮转（实际 ${patient}/10）`);
    assert.ok(starved > patient, "同一条时间线上，饥饿下限确实把名额挪给了分析链路");
    // 生产默认值是 60 秒：不是无限优先，只是给它一条不至于饿死的下限。
    delete process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS;
    const byDefault = await run(new IntakeBudget(true));
    assert.ok(byDefault >= patient, `默认 60 秒不该比纯轮转更少（${byDefault} vs ${patient}）`);
  } finally {
    if (before === undefined) delete process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS;
    else process.env.GEOHOT_INTAKE_ANALYSIS_STARVE_MS = before;
  }
});
