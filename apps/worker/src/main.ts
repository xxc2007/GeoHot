// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets, assertContentExecutorValves, isCollectEnabled, positiveInt } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
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
guardProcessExit(plan.role === "content-executor" ? "content-executor" : "worker");

assertProductionSecrets(plan.coordinator ? [["auth", "IMG_PROXY_SIGN_SECRET"]] : []);
if (!plan.coordinator) assertContentExecutorValves();

if (plan.coordinator) await ensureContentTargets();
const boss = await getBoss();
if (plan.content) await registerContentJobs(boss, plan.coordinator ? undefined : positiveInt(process.env.ANALYZE_CONCURRENCY, "ANALYZE_CONCURRENCY", 4));
if (!plan.coordinator) {
  // COLLECT_ENABLED preserves waitsForPage semantics; this role never registers source polling.
  await registerExtractionJobs(boss, positiveInt(process.env.EXTRACT_CONCURRENCY, "EXTRACT_CONCURRENCY", 2));
} else {
  if (isCollectEnabled()) await registerSourceJobs(boss, { includeExtraction: plan.extraction });
  await registerEventJobs(boss);
  await registerNotifyJobs(boss);
  await registerPublicationJobs(boss);
  await registerSchedules(boss);
}
// A new site has no leaderboard until the first scheduled round: compute one now.
if (plan.coordinator && FEATURES.leaderboard) {
  const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
const heartbeat = startHeartbeat(plan.heartbeat);
console.log(JSON.stringify({ level: "info", msg: "worker started", role: plan.role, pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping", role: plan.role }));
  clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// Windows child.kill() does not reliably deliver these POSIX handlers. A forked local launcher
// can ask this executor to drain over its private IPC channel, then close the SSH tunnel after exit.
if (!plan.coordinator) {
  process.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && Object.keys(message).length === 1
        && "type" in message && message.type === "geohot:shutdown") void shutdown();
  });
  if (process.connected) process.on("disconnect", () => void shutdown());
}
if (process.connected) process.send?.({ type: "geohot:ready", role: plan.role });
