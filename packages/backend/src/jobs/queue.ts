// Job queue on PostgreSQL (pg-boss). Business code enqueues by name; the worker process owns handlers.
import { PgBoss, type SendOptions } from "pg-boss";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export const QUEUES = {
  analyze: "content.analyze",
  extractBody: "content.extract-body",
  group: "events.group",
  digest: "events.digest",
  fetchSource: "sources.fetch",
  fetchXShard: "sources.fetch-x",
  mpCheck: "sources.mp",

  notifySelected: "notify.selected",
  republishSource: "publication.republish-source",

  prepareMedia: "media.prepare",
} as const;

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/** Queue definitions in one place; created on first use by any process. */
export const QUEUE_OPTIONS: Record<string, QueueOptions> = {
  // 一篇条目的分析是 5 次串行付费调用（预筛 + 两次评分 + 写作 + 结构），开了思考的调用单次上限 240 秒
  // （providers/llm.ts），所以这一格的过期时间必须按最坏情况给：5 × 240 + 余量。
  // 原先是 600 秒——pg-boss 会在调用还在跑的时候把任务判死，而 policy:"short" 的去重只挡 `created` 状态，
  // 于是同一条目可能被再跑一遍（钱花两次），或者干脆留在"分析过但没有投影"的缝里。
  [QUEUES.analyze]: { policy: "short", retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 1500 },
  [QUEUES.extractBody]: { policy: "short", retryLimit: 2, retryDelay: 120, expireInSeconds: 300 },
  [QUEUES.group]: { policy: "short", retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.digest]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  [QUEUES.fetchSource]: { policy: "short", retryLimit: 0, expireInSeconds: 600 },
  [QUEUES.fetchXShard]: { policy: "short", retryLimit: 0, expireInSeconds: 900 },
  [QUEUES.mpCheck]: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.notifySelected]: { policy: "short", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.republishSource]: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 3600 },

  [QUEUES.prepareMedia]: { policy: "short", retryLimit: 1, retryDelay: 120, expireInSeconds: 600 },
};

const ensured = new Set<string>();
/** `updateQueue` throws on these two, so they are filtered out of the patch and only reported. */
const NOT_UPDATABLE = new Set(["policy", "partition"]);

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    // A failed `start()` must not be remembered. pg-boss can fail to start on a transient database blip,
    // and callers enqueue inside business transactions — `publishArticle` puts the selected-notify and
    // media-preparation jobs in the same tx (publish.ts:300-303) — so a permanently rejected promise meant
    // every later publish rolled back on the *first* failure, with no way back except restarting the
    // process. Clear it so the next call tries again; the awaiting caller still receives this error.
    starting = (async () => {
      const b = new PgBoss({ connectionString: config.databaseUrl, max: 4, schema: "pgboss", application_name: "aihot-jobs" });
      b.on("error", (err) => console.error("[pg-boss]", err));
      try {
        await b.start();
      } catch (error) {
        // The failed client holds a pooled connection attempt; leaving it alive makes a retry stack
        // sockets on a corpse.
        await b.stop({ graceful: false }).catch(() => {});
        throw error;
      }
      boss = b;
      return b;
    })();
    starting.catch(() => {
      starting = null;
    });
  }
  return starting;
}

/**
 * Aborted when the process starts shutting down: long loops stop between items, and a paid call
 * already in flight is allowed to finish, so a deploy does not leave "outcome unknown" receipts.
 */
export const shutdownSignal = new AbortController();
/**
 * 停止窗口必须比**一次**付费调用还长：开了思考的调用上限 240 秒（`providers/llm.ts`，实测 52–82 秒是常态，
 * 长稿能顶到上限）。原先写 195 秒、注释说"最长付费调用 180 秒"——那是接入 agnes-3.0-flash 之前的世界。
 * 窗口比调用短，部署就会在调用中途收手，留下一张 outcome-unknown 的回执：那条条目要等 ops 释放（第三十四轮
 * 修好之前连释放都不会排回），而这一单的钱已经花出去了。systemd 的 TimeoutStopSec 还要比这里再宽一些。
 */
export const STOP_TIMEOUT_MS = 255_000;

export async function stopBoss(): Promise<void> {
  shutdownSignal.abort();
  if (boss) await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  boss = null;
  starting = null;
}

export async function ensureQueue(name: string, options: QueueOptions = QUEUE_OPTIONS[name] ?? {}): Promise<void> {
  if (ensured.has(name)) return;
  const b = await getBoss();
  const existing = await b.getQueue(name);
  if (!existing) {
    await b.createQueue(name, options);
    ensured.add(name);
    return;
  }
  // `createQueue` is a no-op for a queue that already exists — measured 2026-10-05 against a migrated
  // database: creating `probe.queue` with retryLimit 4 and then again with retryLimit 9 leaves the stored
  // row at 4, `updatedOn` unchanged. So editing QUEUE_OPTIONS changed nothing on a deployed site, silently,
  // and "why is this job still retrying 0 times" had no answer in the code. pg-boss does have `updateQueue`:
  // it COALESCEs the option columns in place (`retry_limit`, `expire_seconds`, …) and never drops the queue,
  // so jobs already waiting in it survive — that is the fix below. Two keys it refuses to change after
  // creation, `policy` and `partition`, stay a warning: the only way to change them is to drop the queue,
  // which is what would throw away the jobs in it.
  const drift = Object.entries(options).filter(([key, want]) => want !== undefined && (existing as unknown as Record<string, unknown>)[key] !== want);
  if (drift.length) {
    const stored = (entries: [string, unknown][]): Record<string, unknown> =>
      Object.fromEntries(entries.map(([key]) => [key, (existing as unknown as Record<string, unknown>)[key]]));
    const [fixable, stuck] = [drift.filter(([key]) => !NOT_UPDATABLE.has(key)), drift.filter(([key]) => NOT_UPDATABLE.has(key))];
    if (fixable.length) {
      const wanted = Object.fromEntries(fixable);
      // 对齐失败不能让入队路径跟着塌：`enqueue` 是在业务事务里被 await 的（`publishArticle` 把精选通知与
      // 媒体准备放进同一条 tx），这里抛出去就等于那条事务回滚。上一版刚修掉一类「一次失败让之后每一次
      // 发布都回滚」的错（`getBoss` 不再缓存失败的 promise），不重犯同一个形状。
      // 库里的值维持原样，任务照常跑，只是这一格还是旧的——所以必须报出来。
      try {
        await b.updateQueue(name, wanted as Parameters<PgBoss["updateQueue"]>[1]);
        console.log(JSON.stringify({ level: "info", msg: `queue ${name}: stored options did not match QUEUE_OPTIONS, applied`, wanted, stored: stored(fixable) }));
      } catch (error) {
        console.log(JSON.stringify({ level: "warn", msg: `queue ${name}: could not apply QUEUE_OPTIONS to the stored queue — it keeps running with the old values`, wanted, stored: stored(fixable), reason: String(error instanceof Error ? error.message : error).slice(0, 300) }));
      }
    }
    if (stuck.length) {
      console.log(JSON.stringify({
        level: "warn",
        msg: `queue ${name}: ${stuck.map(([key]) => key).join(", ")} cannot be changed after creation — the only way is to drop the queue, which discards the jobs waiting in it, so a human decides`,
        wanted: Object.fromEntries(stuck),
        stored: stored(stuck),
      }));
    }
  }
  ensured.add(name);
}

/** Enqueues a job. With `tx`, the job commits atomically with the caller's business write. */
export async function enqueue(name: string, data: object, options: SendOptions = {}, tx?: Db): Promise<string | null> {
  await ensureQueue(name);
  const b = await getBoss();
  if (tx) {
    const db = { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
    return b.send(name, data, { ...options, db });
  }
  return b.send(name, data, options);
}

// ---------------------------------------------------------------------------
// Scheduled task bookkeeping: every run leaves a row, so operators see the latest result.
// ---------------------------------------------------------------------------

export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = await fn();
    const detail = result && typeof result === "object" ? result : { result };
    // The work is finished at this point; writing the log line must not be able to downgrade it.
    // `sql.json` throws on anything JSON cannot hold, and until 2026-10-05 such a result made this run
    // land in the `catch` below — `/admin/runs` then showed a completed job as failed, and the operator
    // re-ran work that had already succeeded. Fall back to a detail that always serialises.
    try {
      await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json(detail as never)} WHERE id = ${row!.id}`;
    } catch {
      await sql`UPDATE job_runs SET status = 'ok', finished_at = now(), detail = ${sql.json({ result: "ok", detailUnloggable: true } as never)} WHERE id = ${row!.id}`.catch(() => {});
    }
    return result;
  } catch (error) {
    await sql`UPDATE job_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 4000)} WHERE id = ${row!.id}`;
    throw error;
  }
}
