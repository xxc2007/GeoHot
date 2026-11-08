// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets, assertContentExecutorValves, assertExtractionExecutorValves, assertFetcherValves, isCollectEnabled, positiveInt } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, shutdownSignal, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { workerPlan } from "@aihot/backend/jobs/worker-role";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { guardProcessExit } from "@aihot/backend/operations/process-exit";
import { modelCooldown } from "@aihot/backend/operations/model-cooldown";

const plan = workerPlan();
guardProcessExit(plan.coordinator ? "worker" : plan.role);

let stopping = false;
let startupDone = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let finishing: Promise<void> | undefined;
function finishShutdown(): Promise<void> {
  return finishing ??= (async () => {
    console.log(JSON.stringify({ level: "info", msg: "worker stopping", role: plan.role }));
    if (heartbeat) clearInterval(heartbeat);
    // stopBoss 抛错时不能连带跳过下面两步（2026-11-05 复核：原先没有 try/finally，
    // boss 停不下来就直接 stack 冒出去，冷却没落库、连接池没关，而被缓存的 rejected promise
    // 再被 await 一次就是 unhandledRejection —— process-exit 500ms 后 exit(1)，看起来像崩溃）。
    try {
      await stopBoss();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", msg: "queue did not stop cleanly; finishing shutdown anyway", error: String(error) }));
    } finally {
      // 冷却表还留在内存里的那几秒，必须在关库之前写下去：否则最后一次 reject()
      // 跟着进程一起消失，重启后又被放回轮转——这正是落库这张表要解决的事。
      await modelCooldown.flushNow().catch(() => {});
      await closeDb().catch(() => {});
    }
    process.exit(0);
  })();
}
function shutdown() {
  stopping = true;
  shutdownSignal.abort();
  if (startupDone) void finishShutdown();
}
// Capture a managed channel before any asynchronous initialization. A disconnect that already
// happened during module loading still leaves process.send defined, but connected is false.
if (!plan.coordinator && typeof process.send === "function") {
  process.on("disconnect", shutdown);
  process.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && Object.keys(message).length === 1
        && "type" in message && message.type === "geohot:shutdown") shutdown();
  });
  if (!process.connected) shutdown();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
async function initialized<T>(operation: Promise<T>): Promise<T> {
  const result = await operation;
  if (stopping) await finishShutdown();
  return result;
}

assertProductionSecrets(plan.coordinator ? [["auth", "IMG_PROXY_SIGN_SECRET"]] : []);
if (plan.role === "extraction-executor") assertExtractionExecutorValves();
else if (plan.role === "fetcher") assertFetcherValves();
else if (!plan.coordinator) assertContentExecutorValves();

if (stopping) await finishShutdown();
await modelCooldown.load();
// 数据库饱和时 pg-boss 的 start 会以 `Connection terminated due to connection timeout` 抛出。一个
// 瞬时超时就让整台执行器退出，恢复期几台机器跟着起落，重启风暴又反过来加重 I/O —— 2026-11-08
// 14:07 box 就是这样死的（journalctl 里 fatal 的栈顶正是 PgBoss.start）。这里退避重试到停机信号，
// systemd 的 Restart=always 仍然是最后一层兜底。
async function startQueue() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getBoss();
    } catch (error) {
      if (stopping || attempt >= 8) throw error;
      const wait = Math.min(60_000, 5_000 * attempt);
      console.error(JSON.stringify({ level: "warn", msg: "queue start failed, retrying", attempt, wait, error: String(error) }));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
const boss = await initialized(startQueue());
if (plan.content) await initialized(registerContentJobs(boss, plan.coordinator ? undefined : positiveInt(process.env.ANALYZE_CONCURRENCY, "ANALYZE_CONCURRENCY", 4)));
if (plan.extraction) {
  // COLLECT_ENABLED preserves waitsForPage semantics; this role never registers source polling.
  await initialized(registerExtractionJobs(boss, positiveInt(process.env.EXTRACT_CONCURRENCY, "EXTRACT_CONCURRENCY", 2)));
} else if (plan.role === "fetcher") {
  // 采集专用节点：只领取 sources.fetch / fetchXShard / mpCheck，不注册任何定时任务。
  // 2026-11-08 现场：站点可达性受出口影响——杭州到 BBC / The Conversation 等常年 CONNECT_TIMEOUT，
  // 而这两家正是「允许站内全文」的 260 个信源里的主力，海外出口的机器（box）抓它们才快。
  if (isCollectEnabled()) await initialized(registerSourceJobs(boss, { includeExtraction: false }));
} else {
  if (isCollectEnabled()) await initialized(registerSourceJobs(boss, { includeExtraction: plan.extraction }));
  await initialized(registerEventJobs(boss));
  await initialized(registerNotifyJobs(boss));
  await initialized(registerPublicationJobs(boss));
  await initialized(registerSchedules(boss));
}
// A new site has no leaderboard until the first scheduled round: compute one now.
if (plan.coordinator && FEATURES.leaderboard) {
  const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
heartbeat = startHeartbeat(plan.heartbeat);
startupDone = true;
if (stopping) await finishShutdown();
console.log(JSON.stringify({ level: "info", msg: "worker started", role: plan.role, pid: process.pid }));
if (process.connected) process.send?.({ type: "geohot:ready", role: plan.role });
