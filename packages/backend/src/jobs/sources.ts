import { balancedResources } from "../operations/resource-budget.ts";
// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { positiveInt } from "../config.ts";
import { collectSource, collectXShard } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";

/** Read once at startup: a typo here must not reach pg-boss as `localConcurrency: NaN` (config.positiveInt). */
const FETCH_CONCURRENCY = positiveInt(process.env.FETCH_CONCURRENCY, "FETCH_CONCURRENCY", 8);

export async function registerSourceJobs(boss: PgBoss, opts: { includeExtraction?: boolean } = {}) {
  await ensureQueue(QUEUES.fetchSource);
  await boss.work<{ sourceId: string; force?: boolean }>(QUEUES.fetchSource, { localConcurrency: FETCH_CONCURRENCY, pollingIntervalSeconds: balancedResources() ? 5 : 2 }, async ([job]) => {
    if (!job) return;
    return collectSource(job.data.sourceId, { force: job.data.force });
  });
  await ensureQueue(QUEUES.fetchXShard);
  // One search per shard of X accounts; the SocialData per-minute budget is shared with the reset monitor.
  await boss.work<{ key: string; sourceIds: string[] }>(QUEUES.fetchXShard, { localConcurrency: balancedResources() ? 1 : 2, pollingIntervalSeconds: balancedResources() ? 5 : 2 }, async ([job]) => {
    if (!job) return;
    return collectXShard(job.data.key, job.data.sourceIds);
  });
  await ensureQueue(QUEUES.mpCheck);
  // Dajiala allows a few requests per second; two accounts at a time stays well under it.
  await boss.work<{ sourceId: string; reason?: "schedule" | "manual" }>(QUEUES.mpCheck, { localConcurrency: balancedResources() ? 1 : 2, pollingIntervalSeconds: balancedResources() ? 5 : 2 }, async ([job]) => {
    if (!job) return;
    return checkMpAccount(job.data.sourceId, job.data.reason ?? "schedule");
  });
  if (opts.includeExtraction !== false) await registerExtractionJobs(boss);
}
