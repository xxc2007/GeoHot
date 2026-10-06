// Content pushes: selected items after their release gate, and the images they need prepared first.
import type { PgBoss } from "pg-boss";
import { pushSelected } from "../notify/selected.ts";
import { prepareArticleMedia, warmShareImage } from "../media/prepare.ts";
import { enqueue, ensureQueue, QUEUES } from "./queue.ts";

const MAX_RETRIES = 6;

export async function registerNotifyJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.notifySelected);
  await boss.work<{ articleId: string; attempt?: number }>(QUEUES.notifySelected, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    // The push makes chat apps unfurl the link: have its share image ready (first attempt only).
    if (!job.data.attempt) await warmShareImage(job.data.articleId);
    const outcome = await pushSelected(job.data.articleId);
    const attempt = job.data.attempt ?? 0;
    if (outcome.status === "retry" && attempt < MAX_RETRIES) {
      // A key per attempt: without one, two items retrying in the same window both carry the empty
      // singleton key and pg-boss's short-policy index (job_i1, state='created') silently drops the
      // second send() — that item's card never reaches the group. The warn below is the only signal
      // if a future key scheme starts colliding again.
      const queued = await enqueue(
        QUEUES.notifySelected,
        { articleId: job.data.articleId, attempt: attempt + 1 },
        { singletonKey: `selected:${job.data.articleId}:${attempt + 1}`, startAfter: outcome.after },
      );
      if (queued === null) {
        console.log(JSON.stringify({ level: "warn", msg: "notify.selected retry was dropped by queue dedupe", articleId: job.data.articleId, attempt: attempt + 1 }));
      }
    }
    return outcome;
  });

  await ensureQueue(QUEUES.prepareMedia);
  await boss.work<{ articleId: string }>(QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    return prepareArticleMedia(job.data.articleId);
  });
}
