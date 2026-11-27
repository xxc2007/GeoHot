// The English leg's worker registration and its sweep.
//
// Registration is separate from `registerContentJobs` on purpose: that function owns `ANALYZE_CONCURRENCY`
// and one queue, and folding the English handler into it would make `content.english` inherit the analysis
// lane's concurrency and admission. Here the worker is registered only when `ENGLISH_CONCURRENCY >= 1`
// (0 on reader machines), and the intake lane (`operations/resource-intake.ts`) is the second valve.
//
// The sweep is the safety net for work that was never enqueued, lost, failed, or became stale: a publication
// whose Chinese revision moved, a body without an English translation, a story whose version moved, a fact
// without `title_en`, a report whose revision moved. It only enqueues; it never calls a model.
import type { PgBoss } from "pg-boss";
import { sql } from "../db.ts";
import { balancedResources } from "../operations/resource-budget.ts";
import { ensureQueue, enqueue, QUEUES, shutdownSignal } from "./queue.ts";
import {
  englishConcurrency,
  translateArticleBodyEn,
  translateQuotedPostEn,
  writeArticleEnglish,
  writeFactTitlesEn,
  writeReportEnglish,
  writeStoryEnglish,
  type EnglishWriteResult,
} from "../editorial/english.ts";

export type EnglishJob =
  | { kind: "copy"; articleId: string }
  | { kind: "body"; articleId: string }
  | { kind: "story"; storyId: number }
  | { kind: "fact-titles"; storyId: number }
  | { kind: "report"; reportKind: "daily" | "weekly" | "monthly"; key: string }
  | { kind: "quote"; tweetId: string };

/** 队列积压上限：没有英文节点消费时，sweep 不能无限往队里堆作业。 */
const MAX_ENGLISH_BACKLOG = 2_000;
const SWEEP_LIMIT = 40;
/** 失败答案最多重排几次；正文另有自己的尝试上限（见 {@link MAX_BODY_ATTEMPTS}）。 */
const MAX_SWEEP_ATTEMPTS = 3;
/**
 * 正文的尝试上限：60k 正文按 6k/批最少 10 轮，部分成功每轮也计一次 attempts；30 轮给模型异常
 * 留 3 倍余量。达到上限就停排——块结构对不上时 priorBlocks 会让整篇重新进 missing，不设上限
 * 等于每 10 分钟无限付费重试。正文的 failed 与 stale 共用这个预算，其余 kind 仍是 3 次。
 */
const MAX_BODY_ATTEMPTS = 30;

async function run(job: EnglishJob): Promise<EnglishWriteResult> {
  switch (job.kind) {
    case "copy": return writeArticleEnglish(job.articleId);
    case "body": return translateArticleBodyEn(job.articleId);
    case "story": return writeStoryEnglish(job.storyId);
    case "fact-titles": return writeFactTitlesEn(job.storyId);
    case "report": return writeReportEnglish(job.reportKind, job.key);
    case "quote": return translateQuotedPostEn(job.tweetId);
    default: {
      const never: never = job;
      return { outcome: "skipped", reason: `unknown-kind:${String(never)}` };
    }
  }
}

export async function registerEnglishJobs(boss: PgBoss, concurrency = englishConcurrency()) {
  if (concurrency < 1) {
    console.log(JSON.stringify({ level: "info", msg: "english leg is off on this node (ENGLISH_CONCURRENCY=0); jobs wait for a backfill node" }));
    return;
  }
  await ensureQueue(QUEUES.english);
  await boss.work<EnglishJob>(QUEUES.english, { localConcurrency: concurrency, pollingIntervalSeconds: balancedResources() ? 5 : 2 }, async ([job]) => {
    if (!job) return;
    if (shutdownSignal.signal.aborted) return { state: "shutdown" };
    // Content failures are already recorded in `english_attempts`; infrastructure failures (budget,
    // receipt in flight/unknown, database) throw and let pg-boss retry after `retryDelay`.
    return run(job.data);
  });
}

interface SweepReport {
  copy: number;
  body: number;
  story: number;
  fact: number;
  report: number;
  deferred?: true;
  reason?: string;
  /**
   * 这一轮因为 6 秒预算被 57014 打断的组名。`deferred:true` 只会把 job_runs 记成 status='skipped'
   * （jobs/queue.ts:181），detail 里每组的数字看起来和「本来没活」一模一样；把组名放进返回值，
   * 运维才能在 /admin/runs 里分清「这组超时了」和「这组本来就没活」。
   */
  skippedGroups?: string[];
}

/**
 * Every ten minutes: five bounded reads, one enqueue each for rows that still need English. Ordering is
 * newest-first (the same order readers see), so a fresh site's visible items are covered first.
 *
 * 2026-11-27：每条读各自一个**只读事务**、各自一份 `statement_timeout` 预算。执行器连的库在读者机上
 * （2 vCPU / 250 IOPS / 891MB），实测「缺英文正文」那条查询挂了 156 秒，读者页当场 503——所以要有预算。
 *
 * 但五条读共用一个事务也不行：只要其中一条撞上预算，57014 会把已经查出来的另外四组一起回滚。
 * 生产现场正是这样——`content.english` 从 08:09 起 4.5 小时里 30 多轮 sweep 全部
 * `{"deferred":true,"reason":"sweep budget exhausted"}`，`created` 只涨不消，失败作业也一次都没被重排。
 * 五组互不依赖，所以改成「一组超时只丢这一组」：本轮仍然把其它组入队，报告里写明被跳过的组。
 */
const SWEEP_STATEMENT_TIMEOUT = "6s";

/**
 * 一组读 = 一个只读事务 = 一份预算。超时（57014）就把这一组的名字记进 `skipped` 并返回 null，
 * 让调用方跳过它、继续跑其余几组。
 */
async function sweepGroup<T>(name: string, read: (db: typeof sql) => Promise<T>, skipped: string[]): Promise<T | null> {
  try {
    return await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('statement_timeout', ${SWEEP_STATEMENT_TIMEOUT}, true), set_config('lock_timeout', '250ms', true)`;
      return read(tx as unknown as typeof sql) as Promise<T>;
    }) as T;
  } catch (error) {
    // 57014 = statement_timeout。回填让路，别把读者的查询一起拖死；这一组下一轮再来。
    if ((error as { code?: string }).code === "57014") {
      skipped.push(name);
      return null;
    }
    throw error;
  }
}

export async function sweepEnglish(): Promise<SweepReport> {
  const empty: SweepReport = { copy: 0, body: 0, story: 0, fact: 0, report: 0 };
  const [backlog] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pgboss.job
     WHERE name = ${QUEUES.english} AND state IN ('created', 'retry', 'active')`;
  if ((backlog?.n ?? 0) >= MAX_ENGLISH_BACKLOG) {
    return { ...empty, deferred: true, reason: `english backlog ${backlog?.n}` };
  }

  const skipped: string[] = [];
  const copies = await sweepGroup<{ article_id: string }[]>("copy", (db) => db`
        SELECT p.article_id
          FROM publications p
          LEFT JOIN english_attempts ea
            ON ea.kind = 'copy' AND ea.subject = p.article_id AND ea.source_revision = p.revision::text
         WHERE p.visibility = 'public'
           AND p.english_source_revision IS DISTINCT FROM p.revision
           AND coalesce(p.title, '') <> '' AND coalesce(p.summary, '') <> ''
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY p.timeline_at DESC, p.article_id
         LIMIT ${SWEEP_LIMIT}`, skipped) ?? [];

  const bodies = await sweepGroup<{ id: string }[]>("body", (db) => db`
        SELECT a.id
          FROM articles a JOIN publications p ON p.article_id = a.id
          LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'en' AND tr.revision = a.revision
          LEFT JOIN english_attempts ea
            ON ea.kind = 'body' AND ea.subject = a.id AND ea.source_revision = a.revision::text
         WHERE p.visibility = 'public' AND p.body_mode = 'full'
           AND (tr.article_id IS NULL OR tr.complete IS NOT TRUE)
           AND (ea.outcome IS NULL
             OR (ea.outcome = 'stale' AND ea.attempts < ${MAX_BODY_ATTEMPTS})
             OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_BODY_ATTEMPTS}))
         ORDER BY p.timeline_at DESC, a.id
         LIMIT ${SWEEP_LIMIT}`, skipped) ?? [];

  const stories = await sweepGroup<{ id: string }[]>("story", (db) => db`
        SELECT s.id::text AS id
          FROM stories s
          LEFT JOIN english_attempts ea
            ON ea.kind = 'story' AND ea.subject = s.id::text AND ea.source_revision = s.version::text
         WHERE s.merged_into IS NULL AND coalesce(s.digest, '') <> ''
           AND s.english_source_version IS DISTINCT FROM s.version
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY s.latest_at DESC NULLS LAST, s.id
         LIMIT ${SWEEP_LIMIT}`, skipped) ?? [];

  // facts 没有可用的版本列：用 `f<条数>:<最大 id>` 作为这批事实的 revision，写回与 sweep 同一个公式。
  const facts = await sweepGroup<{ id: string }[]>("fact-titles", (db) => db`
        WITH factsets AS (
          SELECT story_id, count(*)::int AS n, max(id)::text AS max_id
            FROM facts WHERE story_id IS NOT NULL GROUP BY story_id
        )
        SELECT fs.story_id::text AS id
          FROM factsets fs
          JOIN stories s ON s.id = fs.story_id AND s.merged_into IS NULL
          LEFT JOIN english_attempts ea
            ON ea.kind = 'fact' AND ea.subject = fs.story_id::text
           AND ea.source_revision = 'f' || fs.n::text || ':' || coalesce(fs.max_id, '0')
         WHERE EXISTS (SELECT 1 FROM facts f WHERE f.story_id = fs.story_id AND f.title_en IS NULL)
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY s.latest_at DESC NULLS LAST, fs.story_id
         LIMIT ${SWEEP_LIMIT}`, skipped) ?? [];

  const reports = await sweepGroup<{ kind: "daily" | "weekly" | "monthly"; key: string }[]>("report", (db) => db`
        SELECT r.kind, r.key
          FROM reports r
          LEFT JOIN english_attempts ea
            ON ea.kind = 'report' AND ea.subject = r.kind || ':' || r.key AND ea.source_revision = r.revision::text
         WHERE (r.revision_en IS DISTINCT FROM r.revision OR r.content_en IS NULL)
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY r.generated_at DESC, r.kind, r.key
         LIMIT ${SWEEP_LIMIT}`, skipped) ?? [];

  // 五组各自结算：超时的那几组这一轮没有结果，其余照常入队。
  const found = { copies, bodies, stories, facts, reports };
  if (skipped.length > 0) {
    console.log(JSON.stringify({
      level: "warn",
      msg: "english sweep groups skipped: budget exhausted",
      groups: skipped,
      budget: SWEEP_STATEMENT_TIMEOUT,
    }));
  }

  // 入队放在事务外：读有预算，写不该被同一份预算截断。
  for (const row of found.copies) {
    await enqueue(QUEUES.english, { kind: "copy", articleId: row.article_id }, { singletonKey: `en-copy:${row.article_id}` });
  }
  for (const row of found.bodies) {
    await enqueue(QUEUES.english, { kind: "body", articleId: row.id }, { singletonKey: `en-body:${row.id}` });
  }
  for (const row of found.stories) {
    await enqueue(QUEUES.english, { kind: "story", storyId: Number(row.id) }, { singletonKey: `en-story:${row.id}` });
  }
  for (const row of found.facts) {
    await enqueue(QUEUES.english, { kind: "fact-titles", storyId: Number(row.id) }, { singletonKey: `en-facts:${row.id}` });
  }
  for (const row of found.reports) {
    await enqueue(QUEUES.english, { kind: "report", reportKind: row.kind, key: row.key }, { singletonKey: `en-report:${row.kind}:${row.key}` });
  }

  const counts = {
    copy: found.copies.length,
    body: found.bodies.length,
    story: found.stories.length,
    fact: found.facts.length,
    report: found.reports.length,
  };
  // 有组被跳过时仍然让这一轮在 job_runs 里显示成 skipped（operator 才知道该看下一轮），
  // 但已经入队的那几组照常生效——这是这次改动与「整轮回滚」的唯一区别。
  // `skippedGroups` 一起进 detail：否则 detail 里被跳过的组显示 0，和「本来没活」分不开。
  if (skipped.length === 0) return { ...counts, skippedGroups: [] };
  return { ...counts, deferred: true, reason: "sweep budget exhausted", skippedGroups: skipped };
}
