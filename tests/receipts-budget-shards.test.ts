// 预算锁分片（2026-11-08）。
//
// 生产现场：`pg_locks` 里长期 18 个 `advisory/ExclusiveLock` 持有 + 1 个未授予，全部来自
// `pg_advisory_xact_lock(hashtext('budget:<service>'))`。20 个执行槽位（杭州 12 + 武汉 8）抢同一条
// 队列，读者面/后台一起变慢。改动把锁拆成 `budget:<service>:<shard>`（默认 8 片，GEOHOT_BUDGET_SHARDS
// 覆盖），分片键是主请求的 subject（稳定且与请求相关）。
//
// 这个文件钉住四件事：
//   1. 不同 shard 的请求不再互相排队（持一条队列不会挡住另一条）；
//   2. 同一 shard 仍然串行（锁的是队列，不是请求）；
//   3. 预算统计跨分片汇总（顺序请求仍然精确，上限不会变成 N 倍）；
//   4. 环境变量非法值回落到 8。
//
// 只有需要真实咨询锁/真实事务的用例才碰数据库；纯映射的用例在 `canWriteDb` 为假时也跑。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import {
  BUDGET_SHARD_DEFAULT,
  budgetLockName,
  budgetShardCount,
  budgetShardKey,
  budgetShardOf,
  BudgetExceededError,
  logicalKeyFor,
  paidRequest,
  ReceiptBusyError,
  type CallOutcome,
  type ReceiptRequest,
} from "@aihot/backend/providers/receipts";

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
const canWriteDb = /_(test|ci)$/.test(database);

const tag = () => Math.random().toString(36).slice(2, 10);
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const ok: CallOutcome = { response: { ok: true }, usage };

/** 分片是哈希，测试只能枚举出一个落在指定分片上的 subject。 */
function subjectOn(shard: number, prefix: string, shards = budgetShardCount()): string {
  for (let i = 0; i < 5_000; i += 1) {
    const subject = `${prefix}-${i}`;
    if (budgetShardOf(subject, shards) === shard) return subject;
  }
  throw new Error(`no subject hashed to shard ${shard}/${shards}`);
}

/** 枚举一个**不**落在给定分片上的 subject（用来说"这条请求排的是另一条队"）。 */
function subjectOff(shard: number, prefix: string, shards = budgetShardCount()): string {
  for (let i = 0; i < 5_000; i += 1) {
    const subject = `${prefix}-${i}`;
    if (budgetShardOf(subject, shards) !== shard) return subject;
  }
  throw new Error(`every subject hashed to shard ${shard}/${shards}`);
}

const request = (service: string, subject: string): ReceiptRequest =>
  ({ service, purpose: "budget_shard_test", subject, identity: { subject } });

async function cleanup(service: string): Promise<void> {
  await sql`DELETE FROM receipt_attempts WHERE service = ${service}`;
  await sql`DELETE FROM receipts WHERE service = ${service}`;
  await sql`DELETE FROM budgets WHERE service = ${service}`;
}

test("GEOHOT_BUDGET_SHARDS：合法值生效，非法值回落默认 8", () => {
  const saved = process.env.GEOHOT_BUDGET_SHARDS;
  try {
    delete process.env.GEOHOT_BUDGET_SHARDS;
    assert.equal(BUDGET_SHARD_DEFAULT, 8, "默认分片数是 8");
    assert.equal(budgetShardCount(), 8, "未设置时用默认值");

    for (const raw of ["", "   ", "abc", "0", "-3", "2.5", "8abc", "0x10", "1e2", "1000", "６"]) {
      assert.equal(budgetShardCount(raw), 8, `非法值 ${JSON.stringify(raw)} 必须回落到 8`);
    }
    for (const raw of ["1", "2", "8", "16", "64", " 3 "]) {
      assert.equal(budgetShardCount(raw), Number(raw.trim()), `合法值 ${JSON.stringify(raw)} 应当生效`);
    }

    process.env.GEOHOT_BUDGET_SHARDS = "5";
    assert.equal(budgetShardCount(), 5, "环境变量会被读到");
    process.env.GEOHOT_BUDGET_SHARDS = "0";
    assert.equal(budgetShardCount(), 8, "环境变量非法时仍然回落到 8");
  } finally {
    if (saved === undefined) delete process.env.GEOHOT_BUDGET_SHARDS;
    else process.env.GEOHOT_BUDGET_SHARDS = saved;
  }
});

test("分片键稳定且与请求相关：同一请求同一分片，subject 优先于 identity", () => {
  const shards = 8;
  const first: ReceiptRequest = { service: "s", purpose: "p", subject: "article-42", identity: { a: 1 } };
  assert.equal(budgetShardKey(first), "article-42");
  assert.equal(budgetShardOf(budgetShardKey(first), shards), budgetShardOf("article-42", shards), "同一 subject 永远同一分片");
  assert.equal(budgetShardKey({ ...first, subject: "  article-42  " }), "article-42", "subject 前後空白不制造新分片");

  // 没有 subject 时退回 logicalKey：同一个 identity 仍然固定，不同 identity 不挤在一条队列上。
  const noSubject: ReceiptRequest = { service: "s", purpose: "p", identity: { a: 1 } };
  assert.equal(budgetShardKey(noSubject), logicalKeyFor(noSubject));
  assert.equal(budgetShardOf(budgetShardKey(noSubject), shards), budgetShardOf(logicalKeyFor(noSubject), shards));

  // 锁名三要素：service、分片号、前缀。少了分片号就退化成改动前的全局队列。
  assert.equal(budgetLockName("llm", 0), "budget:llm:0");
  assert.equal(budgetLockName("llm", 7), "budget:llm:7");

  // 256 个 subject 摊到 8 个分片上：每个分片都要被用到，且没有哪个分片吃掉一半以上。
  const buckets = new Array<number>(shards).fill(0);
  for (let i = 0; i < 256; i += 1) buckets[budgetShardOf(`spread-${i}`, shards)]! += 1;
  assert.equal(buckets.reduce((a, b) => a + b, 0), 256);
  assert.ok(buckets.every((n) => n > 0), `每个分片都该被用到，实测 ${buckets.join(",")}`);
  assert.ok(Math.max(...buckets) < 128, `分布不该退化成一条队列，实测 ${buckets.join(",")}`);
});

test("不同 shard 的并发请求不再互相排队：别人持着一条队列，另一条照常放行", { skip: !canWriteDb }, async () => {
  const service = `shardprobe-${tag()}`;
  const shards = budgetShardCount();
  const busyShard = 0;
  const busySubject = subjectOn(busyShard, `busy-${tag()}`, shards);
  const freeSubject = subjectOff(busyShard, `free-${tag()}`, shards);
  const holder = await sql.reserve();
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 50, 500, 5000)`;
    await holder`BEGIN`;
    await holder`SELECT pg_advisory_xact_lock(hashtext(${budgetLockName(service, busyShard)}))`;

    // 另一条队列：不该等（旧实现里它会和上面这条抢同一把锁，3 秒后变成 ReceiptBusyError）。
    const started = Date.now();
    const free = await paidRequest(request(service, freeSubject), async () => { sent += 1; return ok; });
    const elapsed = Date.now() - started;
    assert.equal(free.reused, false);
    assert.equal(sent, 1, "另一条队列上的请求应当真的打到 provider");
    assert.ok(elapsed < 2_000, `不同分片不该互相排队，实测 ${elapsed}ms`);

    // 同一条队列：仍然要等，并且仍然在上限处变成可重试错误。
    await assert.rejects(
      paidRequest(request(service, busySubject), async () => { sent += 1; return ok; }),
      (error: unknown) => {
        assert.ok(error instanceof ReceiptBusyError, `同一分片应当排队到超时，实测 ${String(error)}`);
        assert.match(error.message, /budget lock queue/);
        return true;
      },
    );
    assert.equal(sent, 1, "排队失败的那条一次也没打 provider");
  } finally {
    await holder`ROLLBACK`.catch(() => undefined);
    holder.release();
    await cleanup(service);
  }
});

test("同一 shard 仍然串行：两个不同 subject 落在同一分片就排同一条队", { skip: !canWriteDb }, async () => {
  const service = `shardprobe-${tag()}`;
  const shards = budgetShardCount();
  const shard = 1 % shards;
  const first = subjectOn(shard, `same-a-${tag()}`, shards);
  const second = subjectOn(shard, `same-b-${tag()}`, shards);
  assert.notEqual(first, second, "两个 subject 不同，但分片相同");
  assert.equal(budgetShardOf(first, shards), budgetShardOf(second, shards), "前提：落在同一分片");
  const holder = await sql.reserve();
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 50, 500, 5000)`;
    await holder`BEGIN`;
    await holder`SELECT pg_advisory_xact_lock(hashtext(${budgetLockName(service, shard)}))`;
    // 两条并发发出（而不是排队着等两次 3 秒超时）：它们抢的是同一条队列，所以都会在超时处被拒。
    const results = await Promise.allSettled([first, second].map((subject) =>
      paidRequest(request(service, subject), async () => { sent += 1; return ok; })));
    for (const [index, result] of results.entries()) {
      assert.equal(result.status, "rejected", `第 ${index} 条与持锁方同分片，必须排队`);
      assert.ok((result as PromiseRejectedResult).reason instanceof ReceiptBusyError,
        `第 ${index} 条应当是 ReceiptBusyError，实测 ${String((result as PromiseRejectedResult).reason)}`);
    }
    assert.equal(sent, 0);
  } finally {
    await holder`ROLLBACK`.catch(() => undefined);
    holder.release();
    await cleanup(service);
  }
});

test("分片后预算上限仍生效：顺序请求跨分片汇总，不会变成 N 倍", { skip: !canWriteDb }, async () => {
  const service = `shardprobe-${tag()}`;
  const shards = budgetShardCount();
  // 三个不同分片上的请求，按顺序发；per_minute = 2 时第三个必须被拒——如果 count 是按分片各自数的，
  // 三个分片各有一条记录、各自都不到 2，第三个就会被放行，也就是上限变成 8 倍。
  const shardIds = [0, 1 % shards, 2 % shards];
  assert.equal(new Set(shardIds).size, shardIds.length, "前提：三个不同分片");
  const subjectA = subjectOn(shardIds[0]!, `limit-a-${tag()}`, shards);
  const subjectB = subjectOn(shardIds[1]!, `limit-b-${tag()}`, shards);
  const subjectC = subjectOn(shardIds[2]!, `limit-c-${tag()}`, shards);
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 2, 500, 5000)`;
    await paidRequest(request(service, subjectA), async () => { sent += 1; return ok; });
    await paidRequest(request(service, subjectB), async () => { sent += 1; return ok; });
    await assert.rejects(
      paidRequest(request(service, subjectC), async () => { sent += 1; return ok; }),
      (error: unknown) => {
        assert.ok(error instanceof BudgetExceededError, `第三个必须是超预算，实测 ${String(error)}`);
        assert.equal((error as BudgetExceededError).retryAfterSeconds, 60, "挡的是分钟窗");
        return true;
      },
    );
    assert.equal(sent, 2, "被拒的那条一次也没打 provider");
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE service = ${service}`;
    assert.equal(count!.n, 2, "账上只有 2 条尝试，不是每分片各 2 条");
  } finally {
    await cleanup(service);
  }
});

test("并发窗口的越界有上界：最多 并发分片数-1 次，不是每条请求都放行", { skip: !canWriteDb }, async () => {
  const service = `shardprobe-${tag()}`;
  const shards = budgetShardCount();
  const limit = 2;
  const requests = 12;
  let sent = 0;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, ${limit}, 500, 5000)`;
    const subjects = Array.from({ length: requests }, (_, i) => `burst-${i}-${tag()}`);
    // 前提：这些 subject 摊在多个分片上（否则它们本来就该串行，测不到并发窗口）。
    assert.ok(new Set(subjects.map((s) => budgetShardOf(s, shards))).size > 1, "前提：请求分布在多个分片");
    const results = await Promise.allSettled(subjects.map((subject) =>
      paidRequest(request(service, subject), async () => { sent += 1; return ok; })));
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    for (const r of results) {
      if (r.status === "rejected") assert.ok(r.reason instanceof BudgetExceededError, `被拒的必须是超预算，实测 ${String(r.reason)}`);
    }
    assert.ok(fulfilled >= limit, `上限之内应当放行，实测 ${fulfilled}`);
    assert.ok(fulfilled <= limit + shards - 1,
      `越界上界是 并发分片数-1（${shards - 1}），实测放行 ${fulfilled}，分片数 ${shards}`);
    assert.equal(sent, fulfilled, "放行几条就打几次 provider");
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE service = ${service}`;
    assert.equal(count!.n, fulfilled, "attempts 行数 = 放行数（被拒的不写行）");
  } finally {
    await cleanup(service);
  }
});

after(async () => { await closeDb(); });
