import assert from "node:assert/strict";
import { test } from "node:test";
import { IntakeBudget, intakeQueue, intakeActive, intakeAvailableLanes } from "../packages/backend/src/operations/resource-intake.ts";
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
