import { assertProductionSecrets, config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { startWorkerWatchdog } from "@aihot/backend/operations/watch";
import { guardProcessExit } from "@aihot/backend/operations/process-exit";
import { modelCooldown } from "@aihot/backend/operations/model-cooldown";
import { primeRunsSnapshot } from "@aihot/backend/admin/runs";
import { primeUsageSnapshots } from "@aihot/backend/admin/usage";
import { buildApp } from "./app.ts";

guardProcessExit("api");

assertProductionSecrets([
  ["auth", "SESSION_SECRET"],
  ["auth", "IMG_PROXY_SIGN_SECRET"],
]);
// Somebody must be able to sign in to the admin.
if (config.environmentName === "production" && !(config.adminPassword && config.adminPassword.length >= 9) && !process.env.FEISHU_LOGIN_APP_ID) {
  throw new Error("Refusing to start in production: set ADMIN_PASSWORD (at least 9 characters) or configure Feishu sign-in");
}

await modelCooldown.load();
const app = await buildApp();
await app.listen({ port: config.apiPort, host: process.env.API_HOST || "127.0.0.1" });
startHeartbeat(`api:${config.apiPort}`);
startWorkerWatchdog();

// Admin snapshots are lazy, so after every deploy the first operator visit paid for a 12s
// runs aggregate and a slow usage scan. Build them once in the background, after startup has
// settled. `snapshotReader` already serialises aggregates, so chain rather than race them.
setTimeout(() => {
  void primeRunsSnapshot().finally(() => primeUsageSnapshots());
}, 20_000).unref();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();

  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
