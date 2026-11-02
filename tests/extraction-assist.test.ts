import assert from "node:assert/strict";
import { test } from "node:test";
import { extractionClaim, assistEligible, installExtractionAssist } from "../packages/backend/src/operations/extraction-assist.ts";

const plans = await import(new URL("../node_modules/pg-boss/dist/plans.js", import.meta.url).href);

test("helper admits only current, healthy samples; missing/stale/maintenance/power/version fail closed", () => {
  const now = Date.now();
  const sample = { at: now, onAC: true, localFreeMiB: 3000, remoteFreeMiB: 140, memoryFull: 1, ioFull: 2,
    apiHealthy: true, workerAll: true, sourceMatches: true, maintenance: false, r115: false };
  assert.equal(assistEligible(sample, now), true);
  for (const patch of [{ at: now - 21_000 }, { at: now + 1000 }, { onAC: false }, { localFreeMiB: 1000 },
    { remoteFreeMiB: 50 }, { memoryFull: NaN }, { ioFull: 61 }, { apiHealthy: false },
    { workerAll: false }, { sourceMatches: false }, { maintenance: true }, { r115: true }]) {
    assert.equal(assistEligible({ ...sample, ...patch }, now), false, JSON.stringify(patch));
  }
  assert.equal(assistEligible({}, now), false);
});

test("public-only claim preserves atomic skip-locked and excludes X before claiming; completion is unchanged", () => {
  const claim = plans.fetchNextJob({ schema: "pgboss", table: "job", name: "content.extract-body", policy: "short", limit: 1 }).text;
  const restricted = extractionClaim(claim);
  assert.match(restricted!, /x_post/);
  assert.match(restricted!, /FOR UPDATE OF j SKIP LOCKED/);
  assert.match(restricted!, /LIMIT 1/);
  assert.equal(extractionClaim("UPDATE pgboss.job SET state='completed' WHERE id=$1"), null);
  assert.throws(() => extractionClaim(claim.replaceAll("content.extract-body", "content.analyze")), /only body extraction/);
});

test("extraction assist envelope: slots 1..4 with one extra pooled connection, else refuse to start", () => {
  const boss = { getDb: () => ({ executeSql: () => { throw new Error("must not be reached"); } }) } as never;
  const role = "extraction-executor";
  const lease = "lease.json";
  const env = (slots: string, db: string, bossPool: string) => {
    process.env.WORKER_ROLE = role; process.env.GEOHOT_ASSIST_LEASE_FILE = lease;
    process.env.EXTRACT_CONCURRENCY = slots; process.env.DATABASE_POOL_MAX = db; process.env.PGBOSS_POOL_MAX = bossPool;
  };
  for (const [slots, pool] of [["1", "2"], ["2", "3"], ["4", "5"]] as const) {
    env(slots, pool, pool);
    assert.doesNotThrow(() => installExtractionAssist(boss), `${slots}/${pool}`);
  }
  for (const [slots, pool] of [["0", "1"], ["5", "6"], ["-1", "0"], ["2", "2"], ["2", "4"], ["NaN", "3"], ["1.5", "2.5"], ["", "2"]] as const) {
    env(slots, pool, pool);
    assert.throws(() => installExtractionAssist(boss), `${slots}/${pool}`);
  }
  delete process.env.GEOHOT_ASSIST_LEASE_FILE;
  env("2", "3", "3");
  delete process.env.GEOHOT_ASSIST_LEASE_FILE; // env() always restores it, so drop it again
  assert.throws(() => installExtractionAssist(boss)); // missing lease stays fail-closed
  env("2", "3", "3");
  process.env.WORKER_ROLE = "all";
  assert.doesNotThrow(() => installExtractionAssist(boss)); // non-assist roles are untouched
  for (const key of ["WORKER_ROLE", "GEOHOT_ASSIST_LEASE_FILE", "EXTRACT_CONCURRENCY", "DATABASE_POOL_MAX", "PGBOSS_POOL_MAX"]) delete process.env[key];
});
