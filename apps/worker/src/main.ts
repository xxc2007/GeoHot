// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets, assertContentExecutorValves, assertExtractionExecutorValves, isCollectEnabled, positiveInt } from "@aihot/backend/config";
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
import { ensureContentTargets } from "@aihot/backend/notify/deliver";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { guardProcessExit } from "@aihot/backend/operations/process-exit";

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
    await stopBoss();
    await closeDb();
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
else if (!plan.coordinator) assertContentExecutorValves();

if (stopping) await finishShutdown();
if (plan.coordinator) await initialized(ensureContentTargets());
const boss = await initialized(getBoss());
if (plan.content) await initialized(registerContentJobs(boss, plan.coordinator ? undefined : positiveInt(process.env.ANALYZE_CONCURRENCY, "ANALYZE_CONCURRENCY", 4)));
if (!plan.coordinator) {
  // COLLECT_ENABLED preserves waitsForPage semantics; this role never registers source polling.
  await initialized(registerExtractionJobs(boss, positiveInt(process.env.EXTRACT_CONCURRENCY, "EXTRACT_CONCURRENCY", 2)));
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
