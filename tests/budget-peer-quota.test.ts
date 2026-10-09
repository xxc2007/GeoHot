// The breaker closes a door the peer has already said is shut for the day, and keeps hammering one that
// only says "too fast". Both halves come from the same production measurement (2026-10-10): after the `.com`
// key burned its daily text quota the site still sent 8 requests a minute and got 1 answer — 2,386 certain
// failures in a day — while at the CN endpoint's 9/minute ceiling 8.2 of 9 were still accepted, so cooling
// THAT one would trade real output for nothing.
import { tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, ProviderRejectedError, paidRequest, type ReceiptRequest } from "@aihot/backend/providers/receipts";

const T = tag();
/** One service per test: strikes belong to a service, so a shared one would carry the previous test's evidence. */
const service = (name: string) => `test-peer-quota-${name}-${T}`;
/** The two replies, copied from `receipt_attempts.error` as the providers actually worded them. */
const DAY_IS_GONE = `HTTP 429: {"error":{"message":"You have used up today's text quota and are now limited to 1 request per minute."}}`;
const TOO_FAST = 'HTTP 429: {"error":{"code":"","message":"您已达到免费用户的 API 速率限制。升级 Token Plan 即可解锁更高限额"}}';

async function open(name: string): Promise<string> {
  const s = service(name);
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${s}, 100, 10000, 100000, 'peer-quota test')`;
  return s;
}

/** One send attempt: "rejected" means the request reached the wire and the peer refused it,
 *  "closed(<window>)" means the breaker would not let it go out at all. */
async function send(s: string, subject: string, reply: string): Promise<string> {
  const req: ReceiptRequest = { service: s, model: "test-model", purpose: "prefilter_article", subject, identity: { subject } };
  try {
    await paidRequest(req, async () => {
      throw new ProviderRejectedError(reply, 429, true);
    });
    return "answered";
  } catch (error) {
    if (error instanceof ProviderRejectedError) return "rejected";
    if (error instanceof BudgetExceededError) return `closed(${error.message.replace(/^.*\((.*)\)$/, "$1")})`;
    throw error;
  }
}

const services: string[] = [];
before(async () => {
  for (const name of ["closes", "rate", "reopens"]) services.push(await open(name));
});
after(async () => {
  for (const s of services) {
    await sql`DELETE FROM receipt_attempts WHERE service = ${s}`;
    await sql`DELETE FROM receipts WHERE service = ${s}`;
    await sql`DELETE FROM budgets WHERE service = ${s}`;
  }
  await closeDb();
});

test("a peer that has said its day is gone stops being sent to", async () => {
  const s = services[0]!;
  assert.equal(await send(s, "quota-1", DAY_IS_GONE), "rejected");
  assert.equal(await send(s, "quota-2", DAY_IS_GONE), "rejected");
  assert.equal(await send(s, "quota-3", DAY_IS_GONE), "rejected", "the third refusal is the one that closes it");
  assert.equal(await send(s, "quota-4", DAY_IS_GONE), "closed(peer-quota)", "…and the next request never reaches the wire");
  assert.equal(await send(s, "quota-5", DAY_IS_GONE), "closed(peer-quota)");
});

test("an ordinary rate limit keeps its retry ladder, because most of it still answers", async () => {
  const s = services[1]!;
  for (const subject of ["rate-1", "rate-2", "rate-3", "rate-4", "rate-5", "rate-6"]) {
    assert.equal(await send(s, subject, TOO_FAST), "rejected", `${subject}: a 429 about speed is not a closed day`);
  }
});

test("the door opens by itself, when the evidence rolls out of the window", async () => {
  const s = services[2]!;
  for (const subject of ["gone-1", "gone-2", "gone-3"]) await send(s, subject, DAY_IS_GONE);
  assert.equal(await send(s, "gone-4", DAY_IS_GONE), "closed(peer-quota)");
  await sql`UPDATE receipt_attempts SET started_at = started_at - interval '61 minutes'
             WHERE service = ${s} AND error ILIKE '%quota%'`;
  assert.equal(await send(s, "after-window", DAY_IS_GONE), "rejected", "no operator has to clear a flag");
});
