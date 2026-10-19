import assert from "node:assert/strict";
import { test } from "node:test";

import * as roles from "../packages/backend/src/jobs/worker-role.ts";

test("workers default to the compatible all role and reject unknown roles", () => {
  assert.ok(roles, "worker roles must be explicit before starting a second host");
  assert.equal(roles.workerPlan().role, "all");
  assert.deepEqual(roles.workerPlan("all"), { role: "all", content: true, extraction: true, coordinator: true, heartbeat: "worker" });
  for (const value of ["ALL", "executor", "coordinatr"]) assert.throws(() => roles.workerPlan(value), /WORKER_ROLE/);
});

test("coordinator owns schedules but never analysis or extraction", () => {
  assert.ok(roles);
  assert.deepEqual(roles.workerPlan("coordinator"), {
    role: "coordinator", content: false, extraction: false, coordinator: true, heartbeat: "worker",
  });
});

test("content executor owns only analysis and extraction, with its own heartbeat", () => {
  assert.ok(roles);
  assert.deepEqual(roles.workerPlan("content-executor"), {
    role: "content-executor", content: true, extraction: true, coordinator: false, heartbeat: "content-executor",
  });
  assert.deepEqual(roles.bossOptions("content-executor", "2"), {
    max: 2, application_name: "aihot-jobs-content-executor", schedule: false, supervise: false, migrate: false, createSchema: false,
  });
});

test("queue pool settings reject invalid values instead of silently exceeding a connection budget", () => {
  assert.ok(roles);
  assert.equal(roles.bossOptions().max, 4);
  for (const raw of ["0", "-1", "2.5", "2jobs", "NaN", "9007199254740992"]) {
    assert.throws(() => roles.bossOptions("all", raw), /PGBOSS_POOL_MAX/);
    assert.throws(() => roles.poolSize(raw, "DATABASE_POOL_MAX", 10), /DATABASE_POOL_MAX/);
  }
});
