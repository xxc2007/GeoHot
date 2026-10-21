// Execution recovery must never erase a possibly paid attempt. These tests use exclusive budgets,
// pure callbacks and a localhost HTTP provider; no provider billing or usage is fabricated.
import { gate, Reply, stub, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@aihot/backend/admin/runs";
import { Conflict } from "@aihot/backend/admin/sources";
import { listBudgets } from "@aihot/backend/admin/settings";
import { collectFindings } from "@aihot/backend/operations/alerts";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { BudgetExceededError, paidRequest, ProviderRejectedError, ReceiptBusyError, rejectReceivedResponse, unbilledAttempt } from "@aihot/backend/providers/receipts";

const provider = await stub(() => new Reply(500, { error: "upstream result is uncertain" }));
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
after(async () => { await provider.close(); await closeDb(); });

async function fixture(run: (service: string, req: { service: string; purpose: string; subject: string; identity: string }) => Promise<void>, limit = 1) {
  const service = `billing-${tag()}`;
  const req = { service, purpose: "billing_test", subject: service, identity: service };
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,${limit},${limit})`;
  try { await run(service, req); }
  finally {
    await sql`DELETE FROM audit_log WHERE action='receipt.release' AND subject IN
      (SELECT 'receipt:' || id FROM receipts WHERE service=${service})`;
    await sql`DELETE FROM receipts WHERE service=${service}`;
    await sql`DELETE FROM budgets WHERE service=${service}`;
  }
}
const attempts = (service: string) => sql`SELECT * FROM receipt_attempts WHERE service=${service} ORDER BY attempt`;
const used = async (service: string) => (await listBudgets()).find((r) => r.service === service)!;
const age = (id: number) => sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${id}`;
async function lose(req: { service: string; purpose: string; subject: string; identity: string }) {
  await assert.rejects(paidRequest(req, async () => { throw new Error("socket reset after sending"); }), /socket reset/);
  return (await sql<{ id: number }[]>`SELECT id FROM receipts WHERE service=${req.service}`)[0]!.id;
}

test("a missing budget prevents dispatch and creates no receipt or attempt, while received replay still works", async () => {
  await fixture(async (service, req) => {
    await sql`DELETE FROM budgets WHERE service=${service}`;
    let sent = 0;
    const call = async () => { sent++; return { response: { ok: true } }; };
    await assert.rejects(paidRequest(req, call), (e: unknown) => e instanceof BudgetExceededError && /missing/.test(e.message));
    assert.equal(sent, 0);
    assert.equal((await sql`SELECT id FROM receipts WHERE service=${service}`).length, 0);
    assert.equal((await attempts(service)).length, 0);
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},1,1,1)`;
    const first = await paidRequest(req, call);
    await sql`DELETE FROM budgets WHERE service=${service}`;
    const replay = await paidRequest(req, call);
    assert.equal(replay.receiptId, first.receiptId);
    assert.equal(replay.reused, true);
    assert.equal(sent, 1);
  });
});

test("automatic release retains the uncertain attempt's spend reservation", async () => {
  await fixture(async (service, req) => {
    const id = await lose(req);
    await age(id);
    await autoReleaseUnknownReceipts();
    let sent = 0;
    await assert.rejects(paidRequest(req, async () => { sent++; return { response: true }; }), BudgetExceededError);
    assert.equal(sent, 0, "a release permits recovery but cannot erase its possible bill");
    const [row] = await attempts(service);
    assert.equal(row!.status, "failed");
    assert.equal(row!.billing_status, "unknown");
    assert.equal(row!.usage, null);
    assert.equal((await used(service)).used_day, 1);
  });
});

test("manual billed confirmation retains spend even when usage and cost are absent", async () => {
  await fixture(async (service, req) => {
    const id = await lose(req);
    await releaseReceipt(id, { billed: true, note: "provider console confirms this attempt was billed" }, "test");
    let sent = 0;
    await assert.rejects(paidRequest(req, async () => { sent++; return { response: true }; }), BudgetExceededError);
    assert.equal(sent, 0);
    const [row] = await attempts(service);
    assert.equal(row!.billing_status, "billed");
    assert.equal(row!.usage, null);
    assert.equal(row!.cost, null);
    assert.equal((await used(service)).used_hour, 1);
  });
});

test("automatic release preserves an already known billing decision", async () => {
  await fixture(async (service, req) => {
    const id = await lose(req);
    // This can also come from migration 0068 when an unknown legacy attempt already has a cost.
    await sql`UPDATE receipt_attempts SET billing_status='billed' WHERE receipt_id=${id}`;
    await age(id);
    await autoReleaseUnknownReceipts();
    assert.equal((await attempts(service))[0]!.billing_status, "billed");
    const [log] = await sql`SELECT after FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${id}`}`;
    assert.equal(log!.after.billingStatus, "billed");
  });
});

test("manual unbilled confirmation releases spend but still obeys the minute rate limit", async () => {
  await fixture(async (service, req) => {
    await sql`UPDATE budgets SET per_minute=1 WHERE service=${service}`;
    const id = await lose(req);
    await releaseReceipt(id, { billed: false, note: "provider console confirms no charge" }, "test");
    assert.equal((await used(service)).used_day, 0);
    let sent = 0;
    const call = async () => { sent++; return { response: true }; };
    await assert.rejects(paidRequest(req, call), (e: unknown) => e instanceof BudgetExceededError && /minute/.test(e.message));
    assert.equal(sent, 0);
    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 minutes' WHERE receipt_id=${id}`;
    await paidRequest(req, call);
    assert.equal(sent, 1);
    assert.deepEqual((await attempts(service)).map((r) => r.billing_status), ["unbilled", "billed"]);
    assert.equal((await used(service)).used_day, 1);
  });
});

test("a later manual release changes only the current attempt and cannot refund an earlier unknown", async () => {
  await fixture(async (service, req) => {
    const id = await lose(req);
    await age(id);
    await autoReleaseUnknownReceipts();
    await lose(req);
    await age(id);
    await autoReleaseUnknownReceipts();
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${id}`)[0]!.status, "unknown", "only one automatic release");
    await releaseReceipt(id, { billed: false, note: "only the second attempt was not billed" }, "test");
    assert.deepEqual((await attempts(service)).map((r) => r.billing_status), ["unknown", "unbilled"]);
    assert.equal((await used(service)).used_day, 1);
    await assert.rejects(releaseReceipt(id, { billed: false, note: "duplicate" }, "test"), Conflict);
    assert.equal((await used(service)).used_day, 1);
  }, 2);
});

test("release rolls back when the current attempt is missing, and concurrent release classifies it once", async () => {
  await fixture(async (service, req) => {
    const id = await lose(req);
    await sql`UPDATE receipt_attempts SET attempt=2 WHERE receipt_id=${id}`;
    await assert.rejects(releaseReceipt(id, { billed: false, note: "must be attached to the current attempt" }, "test"), Conflict);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${id}`)[0]!.status, "unknown");
    await sql`UPDATE receipt_attempts SET attempt=1 WHERE receipt_id=${id}`;
    const outcomes = await Promise.allSettled([
      releaseReceipt(id, { billed: true, note: "confirmed charge" }, "test"),
      releaseReceipt(id, { billed: true, note: "same confirmation" }, "test"),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled" && r.value !== null).length, 1);
    assert.equal((await attempts(service))[0]!.billing_status, "billed");
    const logs = await sql`SELECT after FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${id}`}`;
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.after.attemptId, (await attempts(service))[0]!.id);
  });
});

test("a received unusable answer without usage remains billed", async () => {
  await fixture(async (service, req) => {
    const first = await paidRequest(req, async () => ({ response: "unusable" }));
    await rejectReceivedResponse(first.receiptId, "unusable output");
    assert.equal((await attempts(service))[0]!.usage, null);
    let sent = 0;
    await assert.rejects(paidRequest(req, async () => { sent++; return { response: true }; }), BudgetExceededError);
    assert.equal(sent, 0);
    assert.equal((await attempts(service))[0]!.billing_status, "billed");
  });
});

test("in-flight attempts reserve capacity before dispatch and concurrent requests cannot exceed it", async () => {
  await fixture(async (service, req) => {
    const started = gate();
    const finish = gate();
    const first = paidRequest(req, async () => { started.open(); await finish.promise; return { response: true }; });
    try {
      await within(started.promise);
      assert.equal((await attempts(service))[0]!.billing_status, "reserved");
      await assert.rejects(paidRequest(req, async () => ({ response: true })), ReceiptBusyError);
      let sent = 0;
      await assert.rejects(paidRequest({ ...req, identity: "different" }, async () => { sent++; return { response: true }; }), BudgetExceededError);
      assert.equal(sent, 0);
    } finally { finish.open(); await first; }
    assert.equal((await attempts(service))[0]!.billing_status, "billed");
  });
});

test("provider rejection is not proof of a free request; only explicit unbilled evidence releases spend", async () => {
  await fixture(async (service, req) => {
    await assert.rejects(paidRequest(req, async () => { throw new ProviderRejectedError("upstream 500", 500, true); }), ProviderRejectedError);
    assert.equal((await attempts(service))[0]!.status, "failed");
    assert.equal((await attempts(service))[0]!.billing_status, "unknown");
    let sent = 0;
    await assert.rejects(paidRequest(req, async () => { sent++; return { response: true }; }), BudgetExceededError);
    assert.equal(sent, 0);
  });
  await fixture(async (service, req) => {
    await assert.rejects(paidRequest(req, async () => { throw new ProviderRejectedError("connection refused before sending", null, true, undefined, "unbilled"); }), ProviderRejectedError);
    assert.equal((await attempts(service))[0]!.billing_status, "unbilled");
    assert.equal((await used(service)).used_day, 0);
    await paidRequest(req, async () => ({ response: true }));
    assert.equal((await used(service)).used_day, 1);
  });
});

test("an actual localhost HTTP 500 stays charged against the spend window", async () => {
  await fixture(async (service) => {
    const model = MODELS["default"]!;
    const previous = model.service;
    model.service = service;
    try {
      const ask = () => chatJson({ model: "default", purpose: "billing_test", subject: service, system: "s", user: service, promptVersion: "billing", schema: z.object({ ok: z.boolean() }) });
      const hits = provider.hits();
      await assert.rejects(ask(), ProviderRejectedError);
      await assert.rejects(ask(), BudgetExceededError);
      assert.equal(provider.hits() - hits, 1);
      assert.equal((await attempts(service))[0]!.billing_status, "unknown");
    } finally { model.service = previous; }
  });
});

test("missing-budget alternatives can dispatch only through an explicitly budgeted service", async () => {
  await fixture(async (service, req) => {
    const missing = { ...req, service: `${service}-missing` };
    let primary = 0, fallback = 0;
    const result = await paidRequest(missing, async () => { primary++; return { response: "primary" }; }, [], [
      { request: req, call: async () => { fallback++; return { response: "fallback" }; } },
    ]);
    assert.equal(result.response, "fallback");
    assert.equal(primary, 0);
    assert.equal(fallback, 1);
    await sql`DELETE FROM budgets WHERE service=${service}`;
    await assert.rejects(paidRequest({ ...missing, identity: "other" }, async () => ({ response: true }), [], [
      { request: { ...req, identity: "other" }, call: async () => ({ response: true }) },
    ]), BudgetExceededError);
  });
});

test("budgets, alerts and receipt throughput all preserve possible billing regardless of usage", async () => {
  await fixture(async (service, req) => {
    const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,attempts)
      VALUES(${req.identity},${service},'billing_test','failed',4) RETURNING id`;
    for (const [i, billing] of ["reserved", "unknown", "billed", "unbilled"].entries()) {
      await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,billing_status,usage)
        VALUES(${receipt!.id},${i+1},${service},'failed',${billing},${i % 2 ? sql.json({ total_tokens: 1 }) : null})`;
    }
    for (const [i, origin] of ["replay", "imported"].entries()) await sql`
      INSERT INTO receipt_attempts(receipt_id,attempt,service,status,origin,billing_status)
      VALUES(${receipt!.id},${i+5},${service},'received',${origin},'billed')`;
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,billing_status,started_at)
      VALUES(${receipt!.id},7,${service},'received','billed',now()-interval '25 hours')`;
    assert.equal((await used(service)).used_day, 3);
    assert.equal((await used(service)).used_hour, 3);
    assert.ok((await collectFindings()).some((f) => f.key === `budget.day.${service}`));
    let sent = 0;
    await assert.rejects(paidRequest({ ...req, identity: "blocked" }, async () => { sent++; return { response: true }; }), BudgetExceededError);
    assert.equal(sent, 0);
    // Same shape as archive-progress: a logical receipt counts once if any attempt might be billed.
    const progress = () => sql`SELECT r.id FROM receipts r WHERE r.service=${service} AND EXISTS
      (SELECT 1 FROM receipt_attempts WHERE receipt_id=r.id AND NOT ${unbilledAttempt()})`;
    assert.equal((await progress()).length, 1);
    await sql`UPDATE receipt_attempts SET billing_status='unbilled' WHERE receipt_id=${receipt!.id}`;
    assert.equal((await progress()).length, 0);
    assert.equal((await used(service)).used_day, 0);
  }, 3);
});

test("0068 upgrades legacy attempts conservatively and old writers cannot default to free", async () => {
  const migration = readFileSync(new URL("../database/migrations/0068_receipt_attempt_billing.sql", import.meta.url), "utf8");
  await sql.begin(async (tx) => {
    const schema = `billing_${tag()}`;
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx`CREATE TABLE receipt_attempts(id serial PRIMARY KEY,status text,usage jsonb,cost numeric,error text)`;
    await tx`INSERT INTO receipt_attempts(status,usage,cost,error) VALUES
      ('pending',NULL,NULL,NULL),('received',NULL,NULL,NULL),('failed',NULL,NULL,'HTTP 429'),
      ('unknown',NULL,NULL,NULL),('failed',NULL,NULL,'自动放行'),('failed',NULL,0.01,'人工核对'),
      ('failed','{"total_tokens":1}',NULL,'old rejection')`;
    const before = await tx`SELECT id,status,usage,cost,error FROM receipt_attempts ORDER BY id`;
    await tx.unsafe(migration);
    const rows = await tx`SELECT * FROM receipt_attempts ORDER BY id`;
    // Metadata-only deployment keeps every historical label unknown. All still reserve spend;
    // refining a received/pending label is optional and must not rewrite the tiny host's full table.
    assert.deepEqual(rows.map((r) => r.billing_status), Array(7).fill("unknown"));
    assert.equal((await tx`SELECT count(*)::int AS n FROM receipt_attempts WHERE billing_status <> 'unbilled'`)[0]!.n, 7);
    assert.deepEqual(rows.map(({ billing_status: _billing, ...r }) => r), [...before]);
    const [legacy] = await tx`INSERT INTO receipt_attempts(status) VALUES('unknown') RETURNING id,billing_status`;
    assert.equal(legacy!.billing_status, "unknown");
    await tx`UPDATE receipt_attempts SET status='failed' WHERE id=${legacy!.id}`;
    assert.equal((await tx`SELECT billing_status FROM receipt_attempts WHERE id=${legacy!.id}`)[0]!.billing_status, "unknown");
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
