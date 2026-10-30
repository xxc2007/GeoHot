import { test } from "node:test";
import assert from "node:assert/strict";
// Production watchdog recovered into the release so all future updates are versioned.
// @ts-ignore Existing standalone deployment script is JavaScript.
import { maintenanceBlocksRecovery } from "../deploy/geohot/worker-liveness.mjs";

test("only a well formed workstation owner permits server worker recovery", () => {
  const owner = { owner: "workstation-extraction", session: "a".repeat(32) };
  assert.equal(maintenanceBlocksRecovery(owner, "worker"), false);
  assert.equal(maintenanceBlocksRecovery(owner, "content-executor"), true);
  for (const row of [null, {}, { owner: "release" }, { ...owner, session: "" }]) {
    assert.equal(maintenanceBlocksRecovery(row, "worker"), true);
  }
});
