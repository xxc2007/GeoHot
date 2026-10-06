// The industry pack's source list is data-as-code: `scripts/seed.ts` only checks these rules when a
// database is reachable, so a bad entry used to be caught at deploy time rather than in CI. Checked
// here instead — the same three rules, without a database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { ENTITIES } from "@aihot/industry/taxonomy";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

interface PackSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  owner_entity_id?: string | null;
  participation_mode: string;
  interval_minutes: number;
  enabled: boolean;
  defaultCategory?: string;
}

const sources = (JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: PackSource[] }).sources;

test("every registered config is one its kind actually implements", () => {
  for (const s of sources) assertSupportedConfig(s.kind, s.config);
});

test("every default category names a real section", () => {
  for (const s of sources) {
    if (s.defaultCategory !== undefined) assert.ok(isCategoryKey(s.defaultCategory), `${s.id}: defaultCategory ${s.defaultCategory}`);
  }
});

test("an owner is either nothing or a key of the entity table", () => {
  // writing.ts:133 resolves the owner through IDENTITY_LEXICON, and a value only it knows silently reads
  // as "no publisher" — the pack's own rule is that a non-null owner is an ENTITIES key.
  for (const s of sources) {
    if (s.owner_entity_id !== null && s.owner_entity_id !== undefined) {
      assert.ok(Object.hasOwn(ENTITIES, s.owner_entity_id), `${s.id}: owner_entity_id "${s.owner_entity_id}" is not an ENTITIES key`);
    }
  }
});

test("a source billed per request is registered stopped", () => {
  // x_search needs SOCIALDATA_API_KEY and mp_account needs DAJIALA_KEY. This deployment has neither, so an
  // enabled entry of those kinds would schedule a paid call that can only fail.
  for (const s of sources) {
    if (s.kind === "x_search" || s.kind === "mp_account") {
      assert.equal(s.enabled, false, `${s.id}: a per-request source must be registered with enabled=false`);
    }
  }
});

test("ids and names are unique and each source has a polling interval", () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const s of sources) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    assert.ok(!names.has(s.name), `duplicate name ${s.name}`);
    ids.add(s.id);
    names.add(s.name);
    if (s.kind !== "external") assert.ok(Number.isFinite(s.interval_minutes) && s.interval_minutes >= 15, `${s.id}: interval ${s.interval_minutes}`);
  }
});
