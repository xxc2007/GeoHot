// Media preparation: body renditions that public pages read on demand. The former content-group push
// (selected cards) was torn out with the whole notify chain — see publication/publish.ts history.
import type { PgBoss } from "pg-boss";
import { prepareArticleMedia } from "../media/prepare.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { balancedResources } from "../operations/resource-budget.ts";

export async function registerNotifyJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.prepareMedia);
  await boss.work<{ articleId: string }>(QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: balancedResources() ? 1 : 5 }, async ([job]) => {
    if (!job) return;
    const result = await prepareArticleMedia(job.data.articleId);
    if (!result.ready || result.failed > 0) throw new Error(`Body media not ready: ${result.failed} rendition failure(s)`);
    return result;
  });
}
