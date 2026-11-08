// Media preparation: body renditions that public pages read on demand. The former content-group push
// (selected cards) was torn out with the whole notify chain — see publication/publish.ts history.
import type { PgBoss } from "pg-boss";
import { prepareArticleMedia } from "../media/prepare.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { balancedResources } from "../operations/resource-budget.ts";

export async function registerNotifyJobs(boss: PgBoss) {
  await registerMediaJobs(boss);
}

/**
 * 只做取图的一路。图片缓存与读者同机（api 的磁盘缓存），所以真正能把图「预热到自己盘上」的
 * 只有跑在网站那台机器上的进程；把这一路单独拆出来，就能在读者机上单开一个小进程慢慢取图，
 * 不和翻译、分析抢并发（站长 2026-11-08：用上所有机器把正文的图都取回来，严格模式）。
 */
export async function registerMediaJobs(boss: PgBoss, localConcurrency = 4) {
  await ensureQueue(QUEUES.prepareMedia);
  await boss.work<{ articleId: string }>(QUEUES.prepareMedia, { localConcurrency, pollingIntervalSeconds: balancedResources() ? 1 : 5 }, async ([job]) => {
    if (!job) return;
    const result = await prepareArticleMedia(job.data.articleId);
    if (!result.ready || result.failed > 0) throw new Error(`Body media not ready: ${result.failed} rendition failure(s)`);
    return result;
  });
}
