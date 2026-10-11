// Health measures usable answers without rewriting paid attempts or releasing their budgets.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { invalidateModelCache, sickServices } from "@aihot/backend/editorial/models";
import { BudgetExceededError, logicalKeyFor, paidRequest, ReceiptUnknownError, type ReceiptRequest } from "@aihot/backend/providers/receipts";

const T = tag();
const services: string[] = [];
let serial = 0;
function service(label: string) {
  const name = `test-output-health-${T}-${label}`;
  services.push(name);
  return name;
}
interface Fixture {
  status?: "received" | "failed" | "unknown" | "pending";
  receiptStatus?: "received" | "completed" | "failed" | "unknown" | "pending";
  error?: string | null;
  usage?: boolean;
  attempt?: number;
  current?: number;
  origin?: "live" | "replay" | "imported";
  ageMinutes?: number;
  request?: ReceiptRequest;
}
async function attempt(name: string, opts: Fixture = {}) {
  const status = opts.status ?? "received";
  const n = opts.attempt ?? 1;
  const current = opts.current ?? n;
  const origin = opts.origin ?? "live";
  const key = opts.request ? logicalKeyFor(opts.request) : `${T}:${++serial}`;
  const usage = opts.usage === false ? null : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,error,attempts,origin,usage)
    VALUES(${key},${name},'summarize_article',${opts.receiptStatus ?? status},${opts.error ?? null},${current},${origin},${usage === null ? null : sql.json(usage)}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,origin,usage,cost,currency,cost_basis,latency_ms,started_at)
    VALUES(${receipt!.id},${n},${name},${status},${origin},${usage === null ? null : sql.json(usage)},0.01,'USD','actual',10,now()-${opts.ageMinutes ?? 0}*interval '1 minute')`;
  return receipt!.id as number;
}
async function sick(name: string) {
  invalidateModelCache();
  return (await sickServices()).has(name);
}
after(async () => {
  try {
    if (services.length) {
      await sql`DELETE FROM receipts WHERE service=ANY(${services}::text[])`;
      await sql`DELETE FROM budgets WHERE service=ANY(${services}::text[])`;
    }
  } finally {
    invalidateModelCache();
    await closeDb();
  }
});

test("four current output refusals among six received answers make the service unhealthy without changing billing", async () => {
  const name = service("billing");
  for (let i = 0; i < 6; i++) await attempt(name, {
    receiptStatus: i < 4 ? "failed" : "received",
    error: i < 2 ? "answer refused: Chinese copy missing" : i < 4 ? "unusable output: invalid shape" : null,
    usage: i % 2 === 0,
  });
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${name},20,6,6)`;
  const ledger = await sql`SELECT * FROM receipt_attempts WHERE service=${name} ORDER BY id`;
  const receipts = await sql`SELECT * FROM receipts WHERE service=${name} ORDER BY id`;
  const budget = await sql`SELECT * FROM budgets WHERE service=${name}`;
  const req: ReceiptRequest = { service: name, purpose: "summarize_article", identity: `${T}-unsent` };
  let sent = 0;
  const neverSend = async () => { sent++; throw new Error("health must not release a billed answer's budget"); };
  const budgetFull = () => assert.rejects(paidRequest(req, neverSend), (error: unknown) =>
    error instanceof BudgetExceededError && error.message.includes("(hour)"));
  await budgetFull();
  assert.equal(await sick(name), true, "only two of six paid answers are usable, including the usage-NULL case");
  await budgetFull();
  assert.equal(sent, 0);
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE service=${name} ORDER BY id`, ledger);
  assert.deepEqual(await sql`SELECT * FROM receipts WHERE service=${name} ORDER BY id`, receipts);
  assert.deepEqual(await sql`SELECT * FROM budgets WHERE service=${name}`, budget);
});

test("half usable remains healthy and fewer than six terminal answers do not trigger isolation", async () => {
  const half = service("half");
  for (let i = 0; i < 6; i++) await attempt(half, { receiptStatus: i < 3 ? "failed" : "received", error: i < 3 ? "answer refused: empty" : null });
  assert.equal(await sick(half), false);
  const five = service("five");
  for (let i = 0; i < 5; i++) await attempt(five, { receiptStatus: "failed", error: "unusable output: invalid" });
  assert.equal(await sick(five), false);
});

test("historical attempts and unrecognized or null receipt errors remain received successes", async () => {
  const name = service("history");
  for (let i = 0; i < 4; i++) await attempt(name, { receiptStatus: "failed", error: "answer refused: newer attempt", attempt: 1, current: 2 });
  await attempt(name, { receiptStatus: "failed", error: "HTTP 429: a different failure" });
  await attempt(name, { receiptStatus: "failed", error: null });
  assert.equal(await sick(name), false, "a failed logical receipt cannot rewrite unrelated earlier answers");
});

test("pending, replay/imported, and old attempts stay outside the terminal live health window", async () => {
  const name = service("window");
  for (let i = 0; i < 3; i++) await attempt(name);
  for (let i = 0; i < 7; i++) await attempt(name, { status: "pending", receiptStatus: "failed", error: "answer refused: not terminal" });
  for (const origin of ["replay", "imported"] as const) {
    for (let i = 0; i < 6; i++) await attempt(name, { receiptStatus: "failed", error: "answer refused: replay", origin });
  }
  for (let i = 0; i < 6; i++) await attempt(name, { receiptStatus: "failed", error: "unusable output: old", ageMinutes: 11 });
  assert.equal(await sick(name), false);
});

test("unknown remains a non-success terminal result and cannot be sent again", async () => {
  const name = service("unknown");
  const req: ReceiptRequest = { service: name, purpose: "summarize_article", identity: `${T}-unknown` };
  const id = await attempt(name, { status: "unknown", request: req, usage: false });
  for (let i = 0; i < 3; i++) await attempt(name, { status: "unknown", usage: false });
  for (let i = 0; i < 2; i++) await attempt(name);
  const ledger = await sql`SELECT * FROM receipt_attempts WHERE service=${name} ORDER BY id`;
  assert.equal(await sick(name), true, "four unknown out of six remain in the original denominator");
  let sent = 0;
  await assert.rejects(paidRequest(req, async () => { sent++; throw new Error("unknown must not be resent"); }), ReceiptUnknownError);
  assert.equal(sent, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${id}`)[0]!.status, "unknown");
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE service=${name} ORDER BY id`, ledger);
});
