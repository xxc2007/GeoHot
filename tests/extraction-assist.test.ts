import assert from "node:assert/strict";
import { test } from "node:test";
import { extractionClaim, assistEligible } from "../packages/backend/src/operations/extraction-assist.ts";

const plans = await import(new URL("../node_modules/pg-boss/dist/plans.js", import.meta.url).href);

test("helper admits only current, healthy samples; missing/stale/maintenance/power/version fail closed", () => {
  const now = Date.now();
  const sample = { at: now, onAC: true, localFreeMiB: 3000, remoteFreeMiB: 140, memoryFull: 1, ioFull: 2,
    apiHealthy: true, workerAll: true, sourceMatches: true, maintenance: false, r115: false };
  assert.equal(assistEligible(sample, now), true);
  for (const patch of [{ at: now - 21_000 }, { at: now + 1000 }, { onAC: false }, { localFreeMiB: 1000 },
    { remoteFreeMiB: 50 }, { memoryFull: NaN }, { ioFull: 31 }, { apiHealthy: false },
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
