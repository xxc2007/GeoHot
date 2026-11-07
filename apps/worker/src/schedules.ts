import {recoverBodyIntegrity} from "@aihot/backend/operations/recover-body-integrity";
import { recoverBodyMedia } from "@aihot/backend/operations/recover-body-media";
import { recoverWorkflowReadiness } from "@aihot/backend/operations/recover-workflow-readiness";
import { balancedResources, resourceCron, runScheduledWithResources } from "@aihot/backend/operations/resource-budget";
// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { FEATURES } from "@aihot/industry/features";
import { isCollectEnabled } from "@aihot/backend/config";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { ageStaleLiveJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { maintainReserves } from "@aihot/backend/sources/reserves";
import { scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { refreshStoryStatuses } from "@aihot/backend/events/digest";
import { linkRelatedStories } from "@aihot/backend/events/group";
import { catchUpReports, composeDaily, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { repairReportWorkflow } from "@aihot/backend/reports/repair";
import { assignTopicsAndReport } from "@aihot/backend/publication/topic-assign";
import { proposeTopics, rotateTopics } from "@aihot/backend/publication/topic-rotate";
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { auditTopicFreshness } from "@aihot/backend/publication/topics";
import { reconcileReadiness } from "@aihot/backend/publication/readiness-reconcile";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { readRunsOverview } from "@aihot/backend/admin/runs";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { recoverBudgetBlockedGrouping, recoverStalledGrouping } from "@aihot/backend/operations/recover-grouping";
import { coalesceTranslationTicks } from "@aihot/backend/operations/coalesce-translation-ticks";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  /** 一次跑多久算「死了」。默认一小时太宽：每小时级的活挂住以后，singleton 会让它一小时不再跑。 */
  expire?: number;
}

const collecting = isCollectEnabled();

/**
 * 一次调度跑多久算「死了」。3600 秒对分钟级的活是灾难：接管它的 worker 一重启，
 * singleton 会让这条 cron 整整一小时不再跑（2026-11-07 01:0x 实测 `cron.sources.schedule`
 * 卡了 57 分钟、`cron.sources.reserves` 55 分钟，期间没有任何新信源被排期）。
 * 默认压到 900 秒，快的活各自显式给更小的值。
 */
const DEFAULT_SCHEDULE_EXPIRE = 900;

export const SCHEDULES: Scheduled[] = [
  // Revisit minute-budget waits each minute; the single scan consumer keeps the 500-row/archive quota.
  { name: "content.sweep", cron: "* * * * *", expire: 240, run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "* * * * *", expire: 300, run: () => translatePending(balancedResources() ? { limit: 6, budgetMs: 60_000, deadlineAt: Date.now() + 120_000 } : {}) },
  { name: "hot.rank", cron: "*/5 * * * *", expire: 300, run: () => computeHotRanking() },
  // 就绪行自愈：缺行的公开文章对读者永远不可见，而且页面上看不出异常（2026-11-07 丢了 404 篇）。
  // 每十分钟挑最新 40 篇重算一次，幂等、只写事实表、不发模型调用。
  // 后台「运行」页的聚合快照过去只由页面访问顺手触发；主库 worker 停掉（readers-only）后没人触发，
  // 快照永远建不出来，页面就长期显示 unavailable。这里给它一个常驻的生产者，5 分钟一次。
  { name: "runs.snapshot", cron: "*/5 * * * *", expire: 240, run: () => readRunsOverview() },
  { name: "content.readiness", cron: "*/10 * * * *", expire: 300, run: () => reconcileReadiness() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.status", cron: "7 * * * *", expire: 600, run: refreshStoryStatuses },
  { name: "stories.links", cron: "12 * * * *", run: linkRelatedStories },
  {
    name: "reports.daily", cron: "0 8 * * *", missed: "once",
    // A restart between midnight and 08:00 re-runs this schedule's missed occurrence immediately — but
    // "today" has not closed yet then (the window runs to today 08:00), and composing it early opens
    // an edition whose window is still going, exactly what catch-up refuses ("an issue keyed ahead of
    // the reader's clock"). The closed day the missed slot was for is composed by reports.catch-up
    // minutes later; the guard only skips, it never composes anything itself.
    run: async () => {
      const day = beijingDate(Date.now());
      if (Date.parse(`${day}T08:00:00+08:00`) > Date.now()) return;
      await composeDaily(day);
    },
  },
  { name: "reports.weekly", cron: "0 10 * * 1", missed: "once", run: () => composeWeekly(isoWeekLabel(addDays(beijingDate(Date.now()), -7))) },
  {
    name: "reports.monthly",
    cron: "30 10 1 * *",
    missed: "once",
    run: () => {
      const [y, m] = beijingDate(Date.now()).split("-").map(Number) as [number, number];
      return composeMonthly(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
    },
  },
  { name: "reports.catch-up", cron: "15 * * * *", run: () => catchUpReports() },
  { name: "reports.repair", cron: "9-59/15 * * * *", run: repairReportWorkflow },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  { name: "sources.icons", cron: "40 4 * * *", missed: "once", run: () => refreshSourceIcons() },
  // IndexNow for new indexable pages (off unless INDEXNOW_SUBMIT_ENABLED).
  { name: "seo.indexnow", cron: "50 5 * * *", missed: "once", run: () => submitIndexNow() },
  // Work a stopped process left half way becomes visible, unknown paid requests get their one
  // automatic release, and the starved tail of the created backlog is lifted back to the priority
  // water line, before the alerts look.
  {
    name: "ops.recover",
    cron: "*/10 * * * *",
    run: async () => ({ backlogAging: await ageStaleLiveJobs(), receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), grouping: await recoverBudgetBlockedGrouping(), stalledGrouping: await recoverStalledGrouping(), bodyMedia: await recoverBodyMedia(), reportMedia: await recoverBodyMedia({reportsOnly:true}), workflow: await recoverWorkflowReadiness(), reportReadiness: await recoverWorkflowReadiness({reportsOnly:true,limit:75,budgetMs:1500}), bodyIntegrity: await recoverBodyIntegrity() }),
  },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  // 主题跟没跟上最近的新闻：每天一次，只读一次库、只写一行日志（不建收据、不发模型）。
  // 有主题连续两周没有新条目时，站长会在日报里看到 slug 列表，而不是等到读者发现那一页停在上个月。
  { name: "topics.audit", cron: "20 6 * * *", missed: "once", run: () => auditTopicFreshness() },
  // 主题归类：每十分钟把最近三天的分配复算一次（实时跟上门票），每天凌晨再把 45 天全量校一遍。
  { name: "topics.assign", cron: "*/10 * * * *", missed: "once", expire: 300, run: () => assignTopicsAndReport(3) },
  { name: "topics.assign-backfill", cron: "40 3 * * *", missed: "once", run: () => assignTopicsAndReport(45) },
  // 轮换：每月 1 号 04:10 检查归档/复活，每天 04:30 把「热起来但没主题认领」的标签记成候选。
  { name: "topics.rotate", cron: "10 4 1 * *", missed: "once", run: () => rotateTopics() },
  { name: "topics.proposals", cron: "30 4 * * *", missed: "once", run: () => proposeTopics() },
  // Four upstream checks a day; a new run is published only when the evidence changed. With collection
  // off only the computation runs, over the snapshots already stored.
  ...(FEATURES.leaderboard
    ? [{ name: "leaderboard.round", cron: "5 2,8,14,20 * * *", missed: "once" as const, run: () => (collecting ? refreshLeaderboard() : runLeaderboardRound()) }]
    : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", expire: 240, run: () => scheduleDueSources(balancedResources() ? 12 : undefined) },
        { name: "sources.reserves", cron: "*/5 * * * *", expire: 300, run: maintainReserves },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),

];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: s.expire ?? DEFAULT_SCHEDULE_EXPIRE });
    await boss.schedule(queue, resourceCron(s.name, s.cron), {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    const admittedTranslation = balancedResources() && s.name === "content.translate";
    await boss.work(queue, { pollingIntervalSeconds: admittedTranslation ? 5 : balancedResources() ? 30 : 15 },
      async () => {
        if (admittedTranslation) {
          // Coalescing failure must not prevent the actual workflow scan.
          await coalesceTranslationTicks().catch(error => console.warn("translation tick coalescing deferred", String(error)));
        }
        return recordRun(s.name, () => runScheduledWithResources(s.name, s.run, admittedTranslation));
      });
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (existing.name.startsWith("cron.") && !names.has(existing.name)) await boss.unschedule(existing.name);
  }
}
