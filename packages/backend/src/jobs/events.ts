// Event jobs: serial grouping, debounced digests. Both handlers let their errors reach pg-boss: the
// group queue's own failure path (events/group.ts) records the report as waiting for a regroup.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { settleNonEditorial } from "./content.ts";
import { ensureQueue, enqueue, QUEUES } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; signalOnly?: boolean; force?: boolean }>(QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
    if (!job) return;
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (job.data.signalOnly && !job.data.force && !(await settleNonEditorial(job.data.articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(job.data.articleId, { signalOnly: job.data.signalOnly, force: job.data.force });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  });
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean; force?: boolean; requestId?: string }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    // `force` travels: an operator who queued a rewrite through the queue means it, and without the field
    // the job silently returns {updated:false} (the inputs hash matches) exactly like "nothing to fix".
    // `requestId` travels with it, or the second rewrite replays the first one's receipt (see digest.ts).
    return composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection, force: job.data.force, requestId: job.data.requestId });
  });
}
