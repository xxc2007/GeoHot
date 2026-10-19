import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import path from "node:path";

after(closeDb);
test("billing DDL preserves historical tuples and conservatively labels every old attempt", async () => {
  const schema = `billing_metadata_${Date.now()}`;
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx`CREATE TABLE receipt_attempts(id serial PRIMARY KEY,status text,cost numeric)`;
    await tx`INSERT INTO receipt_attempts(status,cost) VALUES ('received',5),('pending',NULL),('failed',NULL),('unknown',NULL)`;
    const before = await tx`SELECT id,ctid::text AS tuple FROM receipt_attempts ORDER BY id`;
    const migration = readFileSync(path.join(REPO_ROOT,"database/migrations/0068_receipt_attempt_billing.sql"),"utf8");
    await tx.unsafe(migration);
    assert.deepEqual(await tx`SELECT id,ctid::text AS tuple FROM receipt_attempts ORDER BY id`,before);
    assert.deepEqual((await tx`SELECT billing_status FROM receipt_attempts`).map((row) => row.billing_status),Array(4).fill("unknown"));
    const [constraint] = await tx`SELECT convalidated FROM pg_constraint WHERE conrelid='receipt_attempts'::regclass AND conname='receipt_attempts_billing_status_check'`;
    assert.equal(constraint.convalidated,false);
    await assert.rejects(tx.savepoint(async (sp) => { await sp`INSERT INTO receipt_attempts(billing_status) VALUES ('free-without-proof')`; }),{code:"23514"});
    await tx`INSERT INTO receipt_attempts(billing_status) VALUES ('reserved'),('unknown'),('billed'),('unbilled')`;
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
