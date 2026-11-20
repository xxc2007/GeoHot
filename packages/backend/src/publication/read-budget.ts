import { isPostgresTeardown, sql, type Tx } from "../db.ts";
import { CapacityExceeded, CapacityGate, CapacityTimeout } from "../lib/capacity.ts";

export class PublicReadBusyError extends Error {
  readonly retryAfter = 2;
}

/**
 * Why a health probe failed. Kept coarse so the route can split "gate/query busy" (transient,
 * do not page) from "the database itself is unreachable" (real outage).
 *  - gate_busy      : another probe already holds the single-probe slot
 *  - query_timeout  : probe query did not settle within its deadline (57014 / gate timeout)
 *  - conn_error     : socket-level failure (reset, refused, closed, connect timeout)
 *  - db_unavailable : anything else the probe could not classify
 */
export type HealthReason = "ok" | "gate_busy" | "query_timeout" | "conn_error" | "db_unavailable";

const CONN_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH",
  "CONNECTION_CLOSED", "CONNECTION_ERROR", "CONNECT_TIMEOUT", "CONNECTION_DESTROYED", "CONNECTION_ENDED",
]);

export class HealthProbeError extends Error {
  readonly reason: Exclude<HealthReason, "ok">;
  readonly cause?: unknown;
  constructor(reason: Exclude<HealthReason, "ok">, message: string, cause?: unknown) {
    super(message);
    this.reason = reason;
    this.cause = cause;
  }
}

export function classifyProbeError(error: unknown): Exclude<HealthReason, "ok"> {
  if (error instanceof CapacityExceeded) return "gate_busy";
  if (error instanceof CapacityTimeout) return "query_timeout";
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "57014") return "query_timeout";
  if (code && CONN_ERROR_CODES.has(code)) return "conn_error";
  const message = String((error as { message?: string } | undefined)?.message ?? error);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|CONNECTION_CLOSED|CONNECTION_ERROR|CONNECT_TIMEOUT|timeout exceeded/i.test(message)) {
    return "conn_error";
  }
  return "db_unavailable";
}

// Heavy, cold public aggregate reads share a small slot pool. 2026-11-04：原来是 (2, 0)，
// 而首页一次就要并发 3 个请求（timeline / calendar / pool，其中两个都走这里），
// 一个访客就能把 2 个槽占满、queueLimit=0 让第二个访客直接 503。
// 现在给 4 个槽 + 8 个排队位：排队有界，且「一个访客吃掉全部槽位」不再成立。
const aggregates = new CapacityGate(4, 8);

/**
 * Client-side wall-clock buffer on top of the server-side `statement_timeout`. The server cancels
 * the statement at `timeoutMs`; this extra slice covers round-trip, rollback and the case where a
 * half-open socket never delivers the server's cancel response. If the transaction promise still
 * has not settled by here, the gate releases the slot on its own deadline (it must not wait for a
 * promise that will never settle).
 *
 * 注：这里不调用 postgres.js 的 `query.cancel()`。3.4.9 的 `Query.cancel()` 用逗号表达式把内部
 * 「取消控制套接字」承诺丢弃了（cancel() 返回 null），对等方 reset 时那条承诺会变成
 * unhandledRejection，在 Node 24 / guardProcessExit 下直接拖崩进程——与本次要修的楔死同类。
 * 取消改由三层兜底：服务端 statement_timeout / lock_timeout 到点自行中止语句；闸在客户端
 * 截止时间独立还槽；keep_alive + max_lifetime 回收半开连接。
 */
const READ_DEADLINE_BUFFER_MS = 2_000;
/** Bound on waiting behind the aggregate pool: a reader must not queue behind a saturated gate forever. */
const READ_QUEUE_TIMEOUT_MS = 4_000;

// 2026-11-07：默认 8 秒是照「稳态」定的，可重启后第一次取数（页锚点 cold plan）实测 8.6 秒，
// 于是读者在部署窗口里拿到的是 503 而不是慢一点。2 vCPU 的机器冷启动本来就慢，
// 宁可让这一次等 12 秒，也不要把它判成故障。
//
// `signal`：路由层的总预算（site.ts 的 20 秒）。abort 后闸立即还槽，事务承诺走迟到拒绝兜底，
// 不再像旧的 Promise.race 那样把底层查询晾在连接上。
export async function withPublicRead<T>(
  read: (db: Tx) => Promise<T>,
  timeoutMs = 12_000,
  customPlan = false,
  signal?: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(new CapacityTimeout(0));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  try {
    return await aggregates.run(
      () => {
        const work = sql.begin(async (tx) => {
          await tx`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
          // 这两条不改变结果，只降低「一个慢查询把整机拖住」的概率：
          // 锁等 1.5 秒就放弃（读者宁可拿到 503 也不要等 8 秒），并行工作者一律不派（这台机器只有 2 vCPU）。
          await tx`SELECT set_config('lock_timeout', '1500', true)`;
          await tx`SELECT set_config('max_parallel_workers_per_gather', '0', true)`;
          // The anchor partial index needs actual filter values while sharing this same bounded transaction.
          if (customPlan) await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
          return read(tx);
        }) as Promise<T>;
        // 兜底吞掉迟到的拒绝：abort / 超时 / 回滚之后，被遗弃的事务承诺可能晚到
        // CONNECTION_RESET / ECONNRESET。它已经不影响闸与连接，若不挂 catch 会变成
        // unhandled rejection 把进程拖崩。迟到 settle 不得再触碰槽位。
        void work.catch(() => {});
        return abortPromise ? Promise.race([work, abortPromise]) : work;
      },
      { timeoutMs: timeoutMs + READ_DEADLINE_BUFFER_MS, queueTimeoutMs: READ_QUEUE_TIMEOUT_MS },
    );
  } catch (error) {
    // 57014 = statement_timeout，55P03 = 我们自己设的 lock_timeout（1.5s）——两者对读者是同一件事：
    // 这一次读没抢到，过一会儿再来。漏掉 55P03 会让锁超时变成 500。
    const code = (error as { code?: string }).code;
    // 拆除类连接错误（reset/closed/connect timeout）在被 abort/取消的读里属于同一类降级：
    // 读者拿到 503 + 陈旧回退，而不是把 socket 故障当成 500 抛上去。
    if (error instanceof CapacityExceeded || error instanceof CapacityTimeout || code === "57014" || code === "55P03" || isPostgresTeardown(error)) {
      throw new PublicReadBusyError("Public aggregate reads are temporarily busy");
    }
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Health probe gets its own gate, NOT the reader aggregate gate: a probe must not take a
// reader slot, and two concurrent probes must not both queue behind the pool. (1, 0) means
// exactly one probe may be in flight; the next is rejected immediately.
const healthGate = new CapacityGate(1, 0);

/**
 * Bounded DB probe for /api/health. The old probe was `sql`SELECT 1`` wrapped in a
 * Promise.race that rejected the JS promise at 2 s while the underlying query kept
 * holding — or worse, queueing behind — a pool connection. On a wedged box every probe
 * stacked, so the probe itself became the second leak (after the slow-read leak it was
 * meant to detect).
 *
 * This version does NOT race an orphaned promise:
 *  - The gate (1, 0) rejects a second concurrent probe with CapacityExceeded immediately,
 *    so probes never enqueue behind each other.
 *  - The gate's 2.5 s deadline releases the probe slot even if the SELECT 1 promise never
 *    settles; the late query rejection is swallowed so it cannot become an unhandled
 *    rejection. (We deliberately do not call the driver's query.cancel(): postgres.js
 *    3.4.9 discards that cancel control-socket promise, which turns a peer reset into a
 *    fatal unhandled rejection. A half-open probe connection is reaped by keep_alive.)
 *  - Failures are classified into a coarse reason (gate_busy / query_timeout / conn_error /
 *    db_unavailable) so the route can tell a busy gate apart from a real database outage.
 */
export async function dbHealthProbe(): Promise<{ reason: "ok" }> {
  try {
    await healthGate.run(() => new Promise<void>((resolve, reject) => {
      const query = sql`SELECT 1`;
      // 兜底：探针承诺被闸截止放弃后，这条查询的迟到拒绝不得变成 unhandled rejection。
      void query.catch(() => {});
      query.then(
        () => resolve(),
        (error: unknown) => reject(error),
      );
    }), { timeoutMs: 2_500 });
    return { reason: "ok" };
  } catch (error) {
    throw new HealthProbeError(classifyProbeError(error), "db probe failed", error);
  }
}
