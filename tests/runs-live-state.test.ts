import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { readLiveRunsState } from "../packages/backend/src/admin/runs.ts";
after(closeDb);

test("live run status falls back within its lock deadline instead of occupying HTTP reads", { timeout: 5000 }, async () => {
  await sql.begin(async lock => {
    await lock`LOCK TABLE settings IN ACCESS EXCLUSIVE MODE`;
    const start = Date.now();
    assert.equal(await readLiveRunsState(), null);
    assert.ok(Date.now() - start < 2500);
  });
  assert.notEqual(await readLiveRunsState(), null, "a later healthy read recovers");
});
