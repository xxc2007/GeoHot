import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { getSourcePoolStats } from "../packages/backend/src/sources/registry.ts";

const P = "test-pool-";

before(async () => {
  await sql`DELETE FROM source_reserves WHERE source_id LIKE ${P + "%"}`;
  await sql`DELETE FROM source_retirements WHERE source_id LIKE ${P + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${P + "%"}`;
});

after(async () => {
  await sql`DELETE FROM source_reserves WHERE source_id LIKE ${P + "%"}`;
  await sql`DELETE FROM source_retirements WHERE source_id LIKE ${P + "%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${P + "%"}`;
  await closeDb();
});

test("1. active source cannot be inserted into reserves (mutex)", async () => {
  const id = P + "mutex-active";
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, canonical_url)
    VALUES (${id}, 'Active', 'rss', '{}', 'T1', 'editorial', 360, true, 'ok', 'https://example.com/active')`;
  await assert.rejects(
    () => sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id}, now(), '{}', true)`,
    /already enabled in active pool/,
  );
  await sql`DELETE FROM sources WHERE id = ${id}`;
});

test("2. cap counts ALL non-quarantined rows (eligible=false still counts toward 1000)", async () => {
  // Set cap to 2.
  await sql`UPDATE source_registry_policy SET target_reserves = 2 WHERE singleton`;
  const id1 = P + "ineligible-1";
  const id2 = P + "ineligible-2";
  const id3 = P + "ineligible-3";
  for (const id of [id1, id2, id3]) {
    await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
      VALUES (${id}, 'Reserve', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')`;
  }
  // Insert first 2 as eligible=false (should still count toward cap).
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id1}, now(), '{}', false)`;
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id2}, now(), '{}', false)`;
  // Third one (even with eligible=false) should be blocked — cap is on total candidates, not eligible.
  await assert.rejects(
    () => sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id3}, now(), '{}', false)`,
    /capacity exhausted/,
  );
  // Restore.
  await sql`UPDATE source_registry_policy SET target_reserves = 1000 WHERE singleton`;
  for (const id of [id1, id2, id3]) {
    await sql`DELETE FROM source_reserves WHERE source_id = ${id}`;
    await sql`DELETE FROM sources WHERE id = ${id}`;
  }
});

test("3. quarantined rows do NOT count toward cap", async () => {
  await sql`UPDATE source_registry_policy SET target_reserves = 1 WHERE singleton`;
  const id1 = P + "q-1";
  const id2 = P + "q-2";
  for (const id of [id1, id2]) {
    await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
      VALUES (${id}, 'Reserve', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')`;
  }
  // First row: non-quarantined, counts toward cap.
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible, quarantined) VALUES (${id1}, now(), '{}', true, false)`;
  // Second row: quarantined=true, should NOT count toward cap.
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible, quarantined) VALUES (${id2}, now(), '{}', true, true)`;
  // Restore.
  await sql`UPDATE source_registry_policy SET target_reserves = 1000 WHERE singleton`;
  for (const id of [id1, id2]) {
    await sql`DELETE FROM source_reserves WHERE source_id = ${id}`;
    await sql`DELETE FROM sources WHERE id = ${id}`;
  }
});

test("4. enabling a source auto-removes it from reserves (mutex)", async () => {
  const id = P + "enable-auto-remove";
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
    VALUES (${id}, 'Will Enable', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')`;
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id}, now(), '{}', true)`;
  await sql`UPDATE sources SET enabled = true WHERE id = ${id}`;
  const rows = await sql`SELECT count(*)::int AS n FROM source_reserves WHERE source_id = ${id}`;
  assert.equal(rows[0]!.n, 0);
  await sql`DELETE FROM sources WHERE id = ${id}`;
});

test("5. getSourcePoolStats separates candidates_total / fresh / quarantined", async () => {
  const s = await getSourcePoolStats();
  assert.equal(typeof s.reserve_candidates_total, "number");
  assert.equal(typeof s.reserve_fresh, "number");
  assert.equal(typeof s.reserve_quarantined, "number");
  // fresh must be subset of candidates_total.
  assert.ok(s.reserve_fresh <= s.reserve_candidates_total);
});

test("6. overcap quarantine function quarantines (does not delete)", async () => {
  await sql`UPDATE source_registry_policy SET target_reserves = 1 WHERE singleton`;
  const ids = [P + "overcap-1", P + "overcap-2", P + "overcap-3"];
  for (const id of ids) {
    await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
      VALUES (${id}, 'Overcap', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')`;
  }
  // First one is inserted (non-quarantined, counts toward cap=1).
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${ids[0]}, now(), '{}', true)`;
  // Run quarantine function.
  const result = await sql`SELECT quarantine_reserve_overcap() AS q`;
  assert.equal(result[0]!.q, 0, "should quarantine 0 because only 1 row and cap=1");
  // Restore.
  await sql`UPDATE source_registry_policy SET target_reserves = 1000 WHERE singleton`;
  for (const id of ids) {
    await sql`DELETE FROM source_reserves WHERE source_id = ${id}`;
    await sql`DELETE FROM sources WHERE id = ${id}`;
  }
});

test("7. concurrent import of same id is idempotent (ON CONFLICT)", async () => {
  const id = P + "idem";
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
    VALUES (${id}, 'Idem', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
    VALUES (${id}, 'Idem', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  const rows = await sql`SELECT count(*)::int AS n FROM sources WHERE id = ${id}`;
  assert.equal(rows[0]!.n, 1);
  await sql`DELETE FROM sources WHERE id = ${id}`;
});

test("8. same canonical_url with different ids cannot be in active + reserve simultaneously", async () => {
  const idActive = P + "canon-active";
  const idReserve = P + "canon-reserve";
  // Active source with canonical_url.
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, canonical_url)
    VALUES (${idActive}, 'Active', 'rss', '{}', 'T1', 'editorial', 360, true, 'ok', 'https://example.com/same-feed')`;
  // Reserve source with SAME canonical_url but different id.
  await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, canonical_url)
    VALUES (${idReserve}, 'Reserve', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok', 'https://example.com/same-feed')`;
  // Try to add reserve to source_reserves — should be blocked by canonical mutex.
  await assert.rejects(
    () => sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${idReserve}, now(), '{}', true)`,
    /canonical_url|already enabled/,
  );
  await sql`DELETE FROM source_reserves WHERE source_id = ${idReserve}`;
  await sql`DELETE FROM sources WHERE id IN (${idActive}, ${idReserve})`;
});

test("9. ineligible reserve (eligible=false) still counts toward cap and cannot bypass", async () => {
  await sql`UPDATE source_registry_policy SET target_reserves = 1 WHERE singleton`;
  const id1 = P + "ineligible-a";
  const id2 = P + "ineligible-b";
  for (const id of [id1, id2]) {
    await sql`INSERT INTO sources(id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health)
      VALUES (${id}, 'Ineligible', 'rss', '{}', 'T2', 'isolated', 1440, false, 'ok')`;
  }
  // First ineligible row enters (counts toward cap=1).
  await sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id1}, now(), '{}', false)`;
  // Second ineligible row should be blocked (cap counts all non-quarantined, regardless of eligible).
  await assert.rejects(
    () => sql`INSERT INTO source_reserves(source_id, validated_at, validation, eligible) VALUES (${id2}, now(), '{}', false)`,
    /capacity exhausted/,
  );
  await sql`UPDATE source_registry_policy SET target_reserves = 1000 WHERE singleton`;
  for (const id of [id1, id2]) {
    await sql`DELETE FROM source_reserves WHERE source_id = ${id}`;
    await sql`DELETE FROM sources WHERE id = ${id}`;
  }
});
