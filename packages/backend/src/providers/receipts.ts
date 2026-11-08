// Paid requests (models, SocialData, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. ops.recover releases it once after 30 minutes (admin/runs.ts), so a lost answer costs at
//    most one repeat; after that it waits for the admin.
import { sql, type Db, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

/** Every class below sets `name`: the operator scripts log `error.name` as the whole failure category
 *  (provider text may carry endpoint credentials, so it is deliberately not logged), and an inherited
 *  `"Error"` makes three different failures print the same identical line in the cycle ledger. */
export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.name = "BudgetExceededError";
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {
  constructor(message: string) { super(message); this.name = "ReceiptBusyError"; }
}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string) {
    super(message);
    this.name = "ReceiptUnknownError";
    this.receiptId = receiptId;
  }
}

/** An execution refusal can be retried, but does not itself prove that the provider did not bill. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly modelKey?: string;
  readonly billingStatus: "unknown" | "unbilled";
  constructor(message: string, status: number | null, retryable: boolean, modelKey?: string, billingStatus: "unknown" | "unbilled" = "unknown") {
    super(message);
    this.name = "ProviderRejectedError";
    this.status = status;
    this.retryable = retryable;
    this.modelKey = modelKey;
    this.billingStatus = billingStatus;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface PaidAlternative {
  request: ReceiptRequest;
  call: () => Promise<CallOutcome>;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
}

export interface ReceiptResult {
  receiptId: number;
  logicalKey: string;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

/** How long a paid request may queue behind the per-service budget lock before it gives up and asks
 *  the caller to come back. The claim transaction is DB-only and measured ~20ms on this host, so a
 *  three-second cap never trips on ordinary queueing (11 concurrent claims reached 210ms); it trips
 *  only when something else holds the lock for seconds, which is the 2026-11-08 shape: eleven sessions
 *  queued 8–11s behind one holder while readers starved. Tripping writes nothing and is retried. */
const CLAIM_QUEUE_TIMEOUT_MS = 3_000;

/**
 * 预算锁的分片数：默认 8，`GEOHOT_BUDGET_SHARDS` 覆盖，非法值回落默认。
 *
 * 一把锁的代价：20 个执行槽位（杭州 12 + 武汉 8）全排在 `budget:<service>` 这**一条**队列上——
 * 2026-11-08 生产上 18 个持有 + 1 个未授予就是这条队列。分片后排队按"这一篇稿子"摊到 8 条队列：
 * 同一篇文章仍然固定走同一条（重试、并发重入、同一批备选模型都要串行），不同文章互不相干。
 *
 * 上限定在 64：20 个槽位用不到更多队列，而**越界窗口随分片数变大**（见 checkBudget 里 55P03 上方
 * 的说明），调大只会削弱预算语义，不会更快。
 */
export const BUDGET_SHARD_DEFAULT = 8;
const BUDGET_SHARD_MAX = 64;

/** 只认十进制正整数；空串、负数、小数、垃圾一律回落默认（与 GEOHOT_TRANSLATE_* 同一套约定）。 */
export function budgetShardCount(raw: string | undefined = process.env.GEOHOT_BUDGET_SHARDS, dflt = BUDGET_SHARD_DEFAULT): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return dflt;
  const n = Number(text);
  return n >= 1 && n <= BUDGET_SHARD_MAX ? n : dflt;
}

/**
 * FNV-1a 32 位。这里故意不用 pg 的 `hashtext`：分片要能在**开事务之前**算出来（少一次数据库往返，
 * 一次 claim 只走一次网络），也要能在没有数据库的测试里断言"同一个请求永远落在同一个分片"。
 * 要求只是跨进程、跨版本稳定——算法本身是不是 hashtext 无关紧要。
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 分片键：与请求相关且稳定。优先 `subject`（文章/查询标识，同一篇重试走同一条队列）；
 *  没有 subject 时退回 logicalKey（identity 的哈希，对同一个请求同样稳定，且不会把不同请求挤在一起）。 */
export function budgetShardKey(req: ReceiptRequest): string {
  const subject = req.subject?.trim();
  return subject ? subject : logicalKeyFor(req);
}

/** 分片号 = 稳定哈希 % 分片数。 */
export function budgetShardOf(key: string, shards: number = budgetShardCount()): number {
  return fnv1a32(key) % Math.max(1, shards);
}

/** 锁名：`budget:<service>:<shard>`。service 仍按 budgets 行分，shard 只决定"排哪一条队"。 */
export function budgetLockName(service: string, shard: number): string {
  return `budget:${service}:${shard}`;
}

/**
 * Claim transaction with a bounded wait on the advisory lock.
 * `lock_timeout` is set per transaction, so the 15s session default from db.ts keeps applying to every
 * other background transaction. The 55P03 mapping lives here only: the two result-writing transactions
 * that follow the model call are never turned into "busy" by this.
 */
async function claimWithQueueLimit<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    // Wrapped in an object so postgres.js' UnwrapPromiseArray<T> (array-only conditional) stays concrete.
    const claim = await sql.begin(async (tx) => {
      await tx`SELECT set_config('lock_timeout', ${`${CLAIM_QUEUE_TIMEOUT_MS}ms`}, true)`;
      return { result: await body(tx) };
    });
    return claim.result;
  } catch (error) {
    // 55P03 = lock_not_available. Only our own lock_timeout becomes "come back later": a trigger or a
    // constraint on the INSERT also raises 55P03 (tests inject exactly that), and swallowing it as
    // "busy" would retry a write that can never succeed. Lock waits carry "lock timeout"/"could not
    // obtain lock" in the message; anything else is a real ledger fault and must propagate.
    const code = (error as { code?: string }).code;
    const text = String((error as { message?: string }).message ?? "");
    if (code === "55P03" && /lock timeout|could not obtain lock/i.test(text)) {
      throw new ReceiptBusyError(`budget lock queue exceeded ${CLAIM_QUEUE_TIMEOUT_MS}ms; retry later`);
    }
    throw error;
  }
}

/** 收据行已收款但 response 缺失时写进 error 的原因（收据页与排查都读它）。 */
const MISSING_ANSWER_REASON = "answer missing from a collected receipt; not re-buying";
export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  logical_key: string;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  // 统计口径与分片无关：下面两条语句都不带 shard（receipt_attempts 也没有分片列），一条 count 数的是
  // **整个 service** 在窗口里的尝试。分片只决定"排哪一条队"，不决定"数哪些账"——否则每个分片各算
  // 一份，上限就变成 N 倍，这正是这次改动明令不能出现的结果。
  //
  // 代价（明确取舍）：原来一把全局锁让「查预算 → 写 attempts」对同一个 service 是串行的，所以永远
  // 精确。分片后两条不同队列的 claim 可以同时数到 limit-1 并各写一行，于是某个窗口最多越界
  // 「并发分片数 - 1」次（≤ BUDGET_SHARD_MAX-1，默认 ≤7）。越界不累积：本事务提交后，下一个 claim
  // 在任何分片上都看得见已提交的行，立刻回到上限以内。第二道闸是这条语句的位置——它在锁之后、
  // 写 attempts 之前，已经是本事务能取到的最新读数。
  //
  // 没选 SERIALIZABLE 的原因：SSI 确实能把这段窗口关掉（写偏斜会 abort 一个事务），但 abort 恰好
  // 会在"20 个槽位抢同一个 service"时最频繁——那正是这次要缓解的场景；而且 40001 得沿着每一条
  // 调用方的重试策略重新布线。宁可保留一个可计算、可监控的小越界。
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!budget) throw new BudgetExceededError(service, "missing", 3600);
  // 三个窗保护的是两件不同的事，所以计数口径也不同：
  // · 分钟窗是**速率**——只要真打出去了就算，429 也算（对方确实在被我们敲）。
  // · 小时/天窗是**花费**——已收到结果、结果说不清、还在飞的都算；只有明确未计费才排除。
  //   执行失败、放行重发或 usage 缺失不能证明免费，费用归属独立保存在 billing_status。
  // 第三十四轮评审指出的后果：原先三个窗都数全部尝试，一次代理故障（每篇 5 步 × 重试 8 次）
  // 就能把当天 6000 次的额度烧光而一条中文稿都不产出——那正是"全站停止更新"的形状。
  const unbilled = unbilledAttempt();
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour' AND NOT ${unbilled}) AS hour,
      count(*) FILTER (WHERE NOT ${unbilled}) AS day
    FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

/**
 * 花费口径只有一处定义：一次尝试有没有产生（或可能产生）账单。
 * 熔断器、后台的「已用」和运维告警数的是同一件事——第三十四轮把熔断器改成只数真花了钱的尝试，
 * 却没改另外两处，于是一次代理故障之后，后台显示的 used 比熔断器实际用的大，
 * 告警能报「24 小时额度用完」而 paidRequest 还在放行。
 * 列名一律不带表别名：费用读点里 billing_status 只可能来自 receipt_attempts，
 * 加了别名反而拼不出语句——`${alias}.` 在模板里是一个**参数**，不是字符串拼接。
 */
export function unbilledAttempt() {
  return sql`(billing_status = 'unbilled')`;
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(
  req: ReceiptRequest, call: () => Promise<CallOutcome>, recoveryCandidates: ReceiptRequest[] = [],
  alternatives: PaidAlternative[] = [],
): Promise<ReceiptResult> {
  const dispatches = [{ request: req, call }, ...alternatives];
  const candidates = [...dispatches.map((d) => d.request), ...recoveryCandidates];
  const keys = [...new Set(candidates.map(logicalKeyFor))];

  // 这一批请求排哪一条队：由**主请求**的 subject 决定，一次 claim 只算一次。
  // 同一篇文章的重试、并发重入、同一批备选模型都落同一个 shard；不同文章摊到不同 shard。
  // 备选服务共用同一个 shard，所以锁集合里 (service, shard) 只差 service，按 service 名排序
  // 就是全局一致的加锁顺序——不会因为 shard 不同而互相绕成死锁（不同 shard 的锁集合本来就不相交）。
  const shard = budgetShardOf(budgetShardKey(dispatches[0]!.request));

  const claimed = await claimWithQueueLimit(async (tx) => {
    // 这把咨询锁是**排队**用的，不是防死锁：同一个 (service, shard) 的选路与预算判断本来就该一个接一个。
    // 排队必须有上界：2026-11-08 生产上 11 个会话在这把锁上等了 8–11 秒（持锁方 idle in transaction
    // 18 秒），读者 /api/site/timeline 一并被拖到 3.3 秒、/all 503。claimWithQueueLimit 只把**本事务**
    // 的 lock_timeout 收到 3 秒，超时变成可重试的 ReceiptBusyError；会话级 15 秒对别的后台事务不变。
    //
    // 2026-11-08 分片：原来一把 `budget:<service>` 让 20 个执行槽位抢同一条队列，现在按 shard 拆成
    // `budget:<service>:<0..N-1>`。排队宽度从「全部槽位」降到「同一 shard 的请求」；同一 shard 的
    // 预算判断仍然串行（同一篇文章不会被并发买两遍）。统计口径不变，见 checkBudget。
    // The same pool may choose a different service after a health change. Lock the full candidate set
    // in a stable order, so two concurrent choices cannot both buy this step. Budgets stay per service.
    for (const service of [...new Set(candidates.map((c) => c.service))].sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${budgetLockName(service, shard)}))`;
    }
    const rows = await tx<ReceiptRow[]>`
      SELECT id, logical_key, status, response, created_at, updated_at FROM receipts
       WHERE logical_key = ANY(${keys}::text[]) ORDER BY id FOR UPDATE`;
    // 复用要求原始答复还在行上：response 为 NULL 的 received/completed 行仍算已收款，但拿不回原始
    // 答复，复用它会得到一个空 body（无论 NULL 来自历史上的外部清理，还是未来可能加入的保留策略）。
    // 宁可重新调用，也不要让解析器读到 null。仓库里目前没有裁剪 receipts.response 的代码路径，
    // 这条护栏是为"行已收款而答复已不在"这一类数据形态兜底。
    const received = rows.find((r) => (r.status === "received" || r.status === "completed") && r.response !== null);
    if (received) return { kind: "reuse" as const, row: received };
    // 已收款、答复却不在（response 为 NULL）：这不是"没买过"，是"买过但答案丢了"。
    // 旧逻辑会走到下面 existing 分支 attempts+1 再买一次 —— 同一笔账付两遍，而且账单上看不出
    // 异常。既不重买也不把 null 递给解析器：按 unknown 释放（自动放行一次，之后由后台人工处理），
    // 原因写进 error 让它在收据页上可见。
    const lostAnswer = rows.find((r) => (r.status === "received" || r.status === "completed") && r.response === null);
    if (lostAnswer) {
      await tx`
        UPDATE receipts SET status = 'unknown', error = ${MISSING_ANSWER_REASON}, updated_at = now()
         WHERE id = ${lostAnswer.id} AND status IN ('received', 'completed')`;
      console.error(JSON.stringify({
        level: "error",
        msg: "a collected receipt has no answer on record; released as unknown instead of buying it again",
        receiptId: lostAnswer.id,
        logicalKey: lostAnswer.logical_key,
      }));
      return { kind: "unknown" as const, row: lostAnswer };
    }
    const unresolved = rows.find((r) => r.status === "unknown" || r.status === "pending");
    if (unresolved) {
      if (unresolved.status === "unknown") return { kind: "unknown" as const, row: unresolved };
      if (Date.now() - unresolved.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: unresolved };
      await markUnknown(tx, unresolved.id, "placeholder went stale without a recorded result");
      return { kind: "unknown" as const, row: unresolved };
    }
    // Choose within local budgets while candidate locks hold. Unknown outcomes never change dispatch;
    // a proven unbilled connection failure can re-enter with the remaining candidates below.
    let chosen = dispatches[0]!;
    let earliestBudgetError: BudgetExceededError | undefined;
    const blockedServices = new Set<string>();
    let available = false;
    for (const dispatch of dispatches) {
      if (blockedServices.has(dispatch.request.service)) continue;
      try {
        await checkBudget(tx, dispatch.request.service);
        chosen = dispatch;
        available = true;
        break;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        if (!earliestBudgetError || error.retryAfterSeconds < earliestBudgetError.retryAfterSeconds) earliestBudgetError = error;
        blockedServices.add(dispatch.request.service);
      }
    }
    if (!available) throw earliestBudgetError!;
    const selected = chosen.request;
    const logicalKey = logicalKeyFor(selected);
    const existing = rows.find((r) => r.logical_key === logicalKey);
    if (existing) {
      // failed permits a new attempt, but does not refund the prior attempt's possible bill.
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, selected);
      return { kind: "call" as const, id: existing.id, attemptId, chosen, logicalKey };
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${selected.service}, ${selected.model ?? null}, ${selected.purpose}, ${selected.subject ?? null}, 'pending',
              ${tx.json((selected.requestSummary ?? {}) as never)}, 1)
      ON CONFLICT (logical_key) DO NOTHING
      RETURNING id`;
    if (!row) {
      // 分片之后，同一个 logical_key 的两条并发请求**理论上**可以从不同队列同时进来（前提是它们的主
      // subject 不同 ⇒ shard 不同）。receipts.logical_key 的唯一索引仍然是最后一道闸：让输的一方按
      // 「在飞」退回去重试（调用方本来就当"稍后再来"），而不是让 23505 掀掉一个执行槽位。
      // 正常情况下 subject 对同一篇文章是稳定的，这条路只作为并发兜底，不参与日常路径。
      throw new ReceiptBusyError(`Receipt for ${logicalKey} was claimed concurrently`);
    }
    const attemptId = await startAttempt(tx, row!.id, 1, selected);
    return { kind: "call" as const, id: row!.id, attemptId, chosen, logicalKey };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, logicalKey: claimed.row.logical_key, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; it is released once automatically, then from the admin`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await claimed.chosen.call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    const billingStatus = error instanceof ProviderRejectedError ? error.billingStatus : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, billing_status = ${billingStatus}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
    });
    if (status === "unknown") throw new ReceiptUnknownError(receiptId, `Provider outcome is unknown; ${message}`);
    if (error instanceof ProviderRejectedError && error.retryable && error.billingStatus === "unbilled") {
      const remaining = dispatches.filter(d => logicalKeyFor(d.request) !== claimed.logicalKey);
      if (remaining.length) {
        // Keep the full recovery set: a concurrent caller's pending/unknown receipt still blocks a
        // second purchase, and an already received alternative is reused before any dispatch.
        return paidRequest(remaining[0]!.request, remaining[0]!.call, candidates, remaining.slice(1));
      }
    }
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', billing_status = 'billed', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
  });
  return { receiptId, logicalKey: claimed.logicalKey, response: outcome.response, reused: false };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, billing_status) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending', 'reserved')
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  // `AND status = 'pending'`：只有还挂在占位上的收据才能被翻成 unknown。`markStalePendingReceipts`
  // 先在事务外 SELECT 陈旧 pending 再逐个开事务翻转，中间若那笔付费请求正常完成（received），
  // 无条件 UPDATE 会把一笔已收到答案的收据翻转成 unknown 制造毒行——与 paidRequest 内部
  // 持行锁的同类翻转（status 判定后更新）同一个守卫。rowcount=0 时 attempts 的翻转也一并跳过。
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId} AND status = 'pending'`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', billing_status = CASE WHEN billing_status = 'reserved' THEN 'unknown' ELSE billing_status END,
           error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const stale = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)}`;
  for (const r of stale) await sql.begin((tx) => markUnknown(tx, r.id, "placeholder went stale without a recorded result"));
  return stale.length;
}

/**
 * Book the receipt as delivered, unless the answer was refused: a refused answer must stay re-callable,
 * even though the caller completes every receipt it was handed. A refusal never lands here on content that
 * was published — the same words that failed the usability check failed the editorial gate too.
 */
export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
           WHERE id = ${receiptId} AND status <> 'failed'`;
}

/**
 * Marks a received response that could not be used (unparsable, or no usable words) so a fresh attempt can be
 * made. Only a response still sitting unredeemed is refused: an answer already booked as delivered backs content
 * the site shows, and a flip to `failed` would make the next attempt pay for the same inputs again; `unknown`
 * belongs to the operator's resolve flow (admin/runs.ts).
 */
export async function rejectReceivedResponse(receiptId: number, reason: string): Promise<void> {
  await sql`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now()
            WHERE id = ${receiptId} AND status IN ('received', 'pending')`;
}
