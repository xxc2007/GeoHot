// Explicit operator activation; no source rows are seeded, removed, enabled or disabled.
import { parseArgs } from "node:util";
import { sql, closeDb } from "@aihot/backend/db";
import { setRegistryTarget } from "@aihot/backend/sources/registry";
const { values } = parseArgs({ options: { target: { type: "string" }, "expected-enabled": { type: "string" }, reason: { type: "string" }, apply: { type: "boolean", default: false }, "database-url-env": { type: "string" } } });
try {
  if (!process.env.DATABASE_URL) throw new Error("Explicit DATABASE_URL required");
  const target = values.target === "off" ? null : Number(values.target);
  const expected = Number(values["expected-enabled"]);
  if ((target !== null && (!Number.isSafeInteger(target) || target < 0)) || !Number.isSafeInteger(expected) || expected < 0 || !values.reason?.trim()) throw new Error("Valid target/off, expected-enabled and reason required");
  if (!values.apply) {
    const [policy] = await sql`SELECT target_enabled,enabled_count,policy_version FROM source_registry_policy WHERE singleton`;
    console.log(JSON.stringify({ mode: "dry-run", policy, requestedTarget: target, expectedEnabled: expected }));
  } else {
    if (values["database-url-env"] !== "DATABASE_URL") throw new Error("Apply requires --database-url-env=DATABASE_URL acknowledgement");
    console.log(JSON.stringify(await setRegistryTarget(target,expected,"operator:source-registry",values.reason)));
  }
} finally { await closeDb(); }
