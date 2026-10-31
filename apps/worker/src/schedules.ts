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
import { addDays, beijingDate, isoWeekLabel } from "@aihot/contracts/time";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { submitIndexNow } from "@aihot/backend/operations/indexnow";
import { checkAlerts, sendDigest } from "@aihot/backend/operations/alerts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { forwardPendingFeedback } from "@aihot/backend/operations/feedback";
import { backupConfigured, runBackup } from "@aihot/backend/operations/backup";
import { sourceHealthWeekly } from "@aihot/backend/operations/reports";
import { markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { markStaleDeliveries } from "@aihot/backend/notify/deliver";
import { recoverBudgetBlockedGrouping } from "@aihot/backend/operations/recover-grouping";
import { coalesceTranslationTicks } from "@aihot/backend/operations/coalesce-translation-ticks";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
}

const collecting = isCollectEnabled();

export const SCHEDULES: Scheduled[] = [
  // Revisit minute-budget waits each minute; the single scan consumer keeps the 500-row/archive quota.
  { name: "content.sweep", cron: "* * * * *", run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "* * * * *", run: () => translatePending(balancedResources() ? { limit: 6, budgetMs: 60_000, deadlineAt: Date.now() + 120_000 } : {}) },
  { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
  { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
  { name: "stories.status", cron: "7 * * * *", run: refreshStoryStatuses },
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
    run: async () => ({ backlogAging: await ageStaleLiveJobs(), receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), deliveries: await markStaleDeliveries(), grouping: await recoverBudgetBlockedGrouping(), bodyMedia: await recoverBodyMedia(), reportMedia: await recoverBodyMedia({reportsOnly:true}), workflow: await recoverWorkflowReadiness(), reportReadiness: await recoverWorkflowReadiness({reportsOnly:true,limit:75,budgetMs:1500}), bodyIntegrity: await recoverBodyIntegrity() }),
  },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  // Four upstream checks a day; a new run is published only when the evidence changed. With collection
  // off only the computation runs, over the snapshots already stored.
  ...(FEATURES.leaderboard
    ? [{ name: "leaderboard.round", cron: "5 2,8,14,20 * * *", missed: "once" as const, run: () => (collecting ? refreshLeaderboard() : runLeaderboardRound()) }]
    : []),
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources(balancedResources() ? 12 : undefined) },
        { name: "sources.reserves", cron: "*/5 * * * *", run: maintainReserves },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),

];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
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
