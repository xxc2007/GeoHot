// The per-service budget advisory lock is a queue, and a queue needs a bound.
//
// 2026-11-08: eleven sessions sat on `SELECT pg_advisory_xact_lock(hashtext('budget:llm'))` for 8–11s
// while one holder was `idle in transaction` for 18s; readers of /api/site/timeline fell to 3.3s and /all
// answered 503 (PublicReadBusyError). The claim transaction itself is DB-only — the model HTTP call is
// outside it (paidRequest: `claimed.chosen.call()` runs after the transaction returns) — so the wait came
// from something holding the lock, not from network inside the transaction. What the code now guarantees:
//
//   1. no provider/network call may be made inside the claim transaction;
//   2. the claim transaction waits at most CLAIM_QUEUE_TIMEOUT_MS (3s) for the lock and turns that wait
//      into ReceiptBusyError, which every caller already treats as "come back later";
//   3. the bound is per transaction (`set_config(..., true)`), so db.ts' 15s session default and the
//      readers' 1.5s bound are untouched.
//
// Kept out of setup.ts on purpose: this file writes rows but never talks to a provider, so it only needs
// DATABASE_URL to name a throwaway database.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, budgetLockName, budgetShardCount, paidRequest, ReceiptBusyError, ReceiptUnknownError, type CallOutcome, type ReceiptRequest } from "@aihot/backend/providers/receipts";

const source = readFileSync(new URL("../packages/backend/src/providers/receipts.ts", import.meta.url), "utf8");
const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
const canWriteDb = /_(test|ci)$/.test(database);

/** 2026-11-08 分片之后，"预算锁"不再是**一把**：每个 service 有 `budgetShardCount()` 条队列
 *  （`budget:<service>:<0..N-1>`）。下面涉及"有人在持锁"的用例必须覆盖全部分片，否则它只证明
 *  "某一条队列空着"，什么也没证明。 */
const budgetLocks = (service: string): string[] =>
  Array.from({ length: budgetShardCount() }, (_, shard) => budgetLockName(service, shard));

const tag = () => Math.random().toString(36).slice(2, 10);
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const ok: CallOutcome = { response: { ok: true }, usage };

/** Extracts the body of the claim transaction: from its opening call to the first branch reading `claimed`. */
function claimBody(): string {
  const start = source.indexOf("const claimed = await claimWithQueueLimit");
  const end = source.indexOf('if (claimed.kind === "reuse")');
  assert.ok(start >= 0 && end > start, "receipts.ts 里应当有 claimWithQueueLimit(...) 事务与紧随其后的分支");
  return source.slice(start, end);
}

test("no provider call is made inside the claim transaction", () => {
  const claim = claimBody();
  assert.doesNotMatch(claim, /fetch\(/, "claim 事务里不许有 HTTP");
  assert.doesNotMatch(claim, /\.call\(/, "claim 事务里不许调用被选中的 provider");
  assert.doesNotMatch(claim, /chatJson|createChatCompletion/, "claim 事务里不许出现模型客户端");
  // 反向证明：调用点必须排在事务外面。
  const callAt = source.indexOf("claimed.chosen.call()");
  assert.ok(callAt > source.indexOf("claimWithQueueLimit(async (tx) =>"), "provider 调用必须在 claim 事务之后");
  assert.ok(source.indexOf("await claimWithQueueLimit") < callAt, "顺序：先短事务拿锁，再出事务调用");
});

test("the claim transaction bounds its own lock queue at a few seconds", () => {
  const claim = claimBody();
  // 2026-11-08 分片：锁名从 `budget:<service>` 变成 `budget:<service>:<shard>`，所以这条断言只能改
  // 成新的表达式——但断言的**意思**没变：claim 仍然要拿一把预算咨询锁，而且只拿这一把（走同一个
  // budgetLockName，别处拼锁名会绕过分片）。分片没有把锁去掉，只是把它拆成 N 条队列。
  assert.match(claim, /pg_advisory_xact_lock\(hashtext\(\$\{budgetLockName\(service, shard\)\}\)\)/, "预算咨询锁仍然保留（分片后叫 budget:<service>:<shard>）");
  assert.equal(budgetLockName("llm", 3), "budget:llm:3", "锁名必须带分片号，否则分片退化成原来的全局队列");
  assert.ok(budgetShardCount() >= 1, "分片数至少 1（= 旧行为）");
  assert.ok(claim.startsWith("const claimed = await claimWithQueueLimit(async (tx) => {"), "claim 必须走带队列上限的包装");
  const helper = source.slice(source.indexOf("async function claimWithQueueLimit"), source.indexOf("export function logicalKeyFor"));
  assert.match(helper, /set_config\('lock_timeout'/, "claim 事务必须自己把 lock_timeout 收紧");
  const m = source.match(/const CLAIM_QUEUE_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(m, "应当有命名的队列上限常量");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ms > 0 && ms <= 5_000, `队列上限应当是秒级而不是分钟级，实测 ${ms}ms`);
  // 只对这一个事务生效：不能写成会话级 SET。
  assert.match(source, /set_config\('lock_timeout',[^)]*,\s*true\)/, "必须是事务级的 set_config(..., true)");
});

test("waiting behind someone else's budget lock returns 'come back later' instead of hanging", { skip: !canWriteDb }, async () => {
  const service = `lockprobe-${tag()}`;
  // 分片后一个 service 有 N 条队列；持锁方必须把**全部** N 条都拿住，这条用例才仍然在验
  // "排在别人后面会超时"，而不是"碰巧排在一条空队列上"。
  const locks = budgetLocks(service);
  const req: ReceiptRequest = { service, purpose: "claim_lock_test", subject: `blocked-${tag()}`, identity: { blocked: tag() } };
  let sent = 0;
  const holder = await sql.reserve();
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
    await holder`BEGIN`;
    for (const name of locks) await holder`SELECT pg_advisory_xact_lock(hashtext(${name}))`;

    const started = Date.now();
    await assert.rejects(
      paidRequest(req, async () => { sent += 1; return ok; }),
      (error: unknown) => {
        assert.ok(error instanceof ReceiptBusyError, `应当是 ReceiptBusyError，实测 ${String(error)}`);
        assert.match(error.message, /budget lock queue/, "错误信息应当说明排队超时");
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_500, `应当在 3 秒上限处放弃，实测 ${elapsed}ms`);
    assert.ok(elapsed < 8_000, `不应当一直等下去，实测 ${elapsed}ms`);
    assert.equal(sent, 0, "没拿到锁就不许调用 provider");
    const rows = await sql<{ n: string }[]>`SELECT count(*) AS n FROM receipts WHERE service = ${service}`;
    assert.equal(Number(rows[0]!.n), 0, "排队失败不该留下收据行");
  } finally {
    await holder`ROLLBACK`.catch(() => undefined);
    holder.release();
    await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});

test("the budget lock is free while the model is being called", { skip: !canWriteDb }, async () => {
  const service = `lockprobe-${tag()}`;
  const locks = budgetLocks(service);
  const req: ReceiptRequest = { service, purpose: "claim_lock_test", subject: `free-${tag()}`, identity: { free: tag() } };
  let open!: () => void;
  let callStarted!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const startedCall = new Promise<void>((resolve) => { callStarted = resolve; });
  const probe = await sql.reserve();
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
    const inFlight = paidRequest(req, async () => { callStarted(); await gate; return ok; });
    await startedCall;
    // 调用在飞时：**每一条**预算队列都必须已经还回去（只查一条会漏掉真正被用的那个分片）。
    const taken: string[] = [];
    let free = true;
    for (const name of locks) {
      const [row] = await probe<{ got: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${name})) AS got`;
      if (row!.got) taken.push(name); else free = false;
    }
    for (const name of taken) await probe`SELECT pg_advisory_unlock(hashtext(${name}))`;
    assert.equal(free, true, "模型调用期间不该还握着任何一条预算锁队列");
    const idle = await probe<{ n: string }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`;
    assert.equal(Number(idle[0]!.n), 0, "模型调用期间不该有 idle in transaction");
    open();
    const result = await inFlight;
    assert.equal(result.reused, false);
  } finally {
    open();
    probe.release();
    await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});

test("a received answer is still reused, keyed by the same receipt", { skip: !canWriteDb }, async () => {
  const service = `lockprobe-${tag()}`;
  const req: ReceiptRequest = { service, purpose: "claim_lock_test", subject: `reuse-${tag()}`, identity: { reuse: tag() } };
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
    const first = await paidRequest(req, async () => { sent += 1; return ok; });
    const second = await paidRequest(req, async () => { sent += 1; return ok; });
    assert.equal(sent, 1, "第二次必须复用，不再打 provider");
    assert.equal(second.reused, true);
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(first.reused, false);
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});

test("a stopped budget still throws BudgetExceededError before the provider is reached", { skip: !canWriteDb }, async () => {
  const service = `lockprobe-${tag()}`;
  const req: ReceiptRequest = { service, purpose: "claim_lock_test", subject: `budget-${tag()}`, identity: { budget: tag() } };
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 0, 0, 0)`;
    await assert.rejects(paidRequest(req, async () => { sent += 1; return ok; }), BudgetExceededError);
    assert.equal(sent, 0, "超限时一次都不许发出");
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});

test("an unknown outcome still blocks a second send and still reports itself", { skip: !canWriteDb }, async () => {
  const service = `lockprobe-${tag()}`;
  const req: ReceiptRequest = { service, purpose: "claim_lock_test", subject: `unknown-${tag()}`, identity: { unknown: tag() } };
  let sent = 0;
  const lost = async (): Promise<CallOutcome> => {
    sent += 1;
    throw new Error("socket hang up after sending");
  };
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 5, 5, 5)`;
    await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
    const [row] = await sql<{ status: string; error: string }[]>`SELECT status, error FROM receipts WHERE service = ${service}`;
    assert.equal(row!.status, "unknown");
    assert.match(row!.error, /socket hang up/);
    // 未知结果不放行：第二次调用直接被收据挡住，一次也不再发。
    await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
    assert.equal(sent, 1, "unknown 语义不变：不自动重发");
  } finally {
    await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});

after(async () => { await closeDb(); });