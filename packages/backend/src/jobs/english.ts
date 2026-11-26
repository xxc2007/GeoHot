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
}

/**
 * Every ten minutes: five bounded reads, one enqueue each for rows that still need English. Ordering is
 * newest-first (the same order readers see), so a fresh site's visible items are covered first.
 *
 * 2026-11-27：五条读放进**一个只读事务**，每条都有 `statement_timeout` 预算。执行器连的库在读者机上
 * （2 vCPU / 250 IOPS / 891MB），实测「缺英文正文」那条查询挂了 156 秒，读者页当场 503。
 * 预算用完就跳过这一轮：回填慢一轮，好过换读者一次超时。
 */
const SWEEP_STATEMENT_TIMEOUT = "6s";

export async function sweepEnglish(): Promise<SweepReport> {
  const empty: SweepReport = { copy: 0, body: 0, story: 0, fact: 0, report: 0 };
  const [backlog] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pgboss.job
     WHERE name = ${QUEUES.english} AND state IN ('created', 'retry', 'active')`;
  if ((backlog?.n ?? 0) >= MAX_ENGLISH_BACKLOG) {
    return { ...empty, deferred: true, reason: `english backlog ${backlog?.n}` };
  }

  let found: {
    copies: { article_id: string }[];
    bodies: { id: string }[];
    stories: { id: string }[];
    facts: { id: string }[];
    reports: { kind: "daily" | "weekly" | "monthly"; key: string }[];
  };
  try {
    found = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('statement_timeout', ${SWEEP_STATEMENT_TIMEOUT}, true), set_config('lock_timeout', '250ms', true)`;

      const copies = await tx<{ article_id: string }[]>`
        SELECT p.article_id
          FROM publications p
          LEFT JOIN english_attempts ea
            ON ea.kind = 'copy' AND ea.subject = p.article_id AND ea.source_revision = p.revision::text
         WHERE p.visibility = 'public'
           AND p.english_source_revision IS DISTINCT FROM p.revision
           AND coalesce(p.title, '') <> '' AND coalesce(p.summary, '') <> ''
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY p.timeline_at DESC, p.article_id
         LIMIT ${SWEEP_LIMIT}`;

      const bodies = await tx<{ id: string }[]>`
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
         LIMIT ${SWEEP_LIMIT}`;

      const stories = await tx<{ id: string }[]>`
        SELECT s.id::text AS id
          FROM stories s
          LEFT JOIN english_attempts ea
            ON ea.kind = 'story' AND ea.subject = s.id::text AND ea.source_revision = s.version::text
         WHERE s.merged_into IS NULL AND coalesce(s.digest, '') <> ''
           AND s.english_source_version IS DISTINCT FROM s.version
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY s.latest_at DESC NULLS LAST, s.id
         LIMIT ${SWEEP_LIMIT}`;

      // facts 没有可用的版本列：用 `f<条数>:<最大 id>` 作为这批事实的 revision，写回与 sweep 同一个公式。
      const facts = await tx<{ id: string }[]>`
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
         LIMIT ${SWEEP_LIMIT}`;

      const reports = await tx<{ kind: "daily" | "weekly" | "monthly"; key: string }[]>`
        SELECT r.kind, r.key
          FROM reports r
          LEFT JOIN english_attempts ea
            ON ea.kind = 'report' AND ea.subject = r.kind || ':' || r.key AND ea.source_revision = r.revision::text
         WHERE (r.revision_en IS DISTINCT FROM r.revision OR r.content_en IS NULL)
           AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
         ORDER BY r.generated_at DESC, r.kind, r.key
         LIMIT ${SWEEP_LIMIT}`;

      return { copies, bodies, stories, facts, reports };
    });
  } catch (error) {
    // 57014 = statement_timeout。回填让路，别把读者的查询一起拖死。
    if ((error as { code?: string }).code === "57014") return { ...empty, deferred: true, reason: "sweep budget exhausted" };
    throw error;
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

  return {
    copy: found.copies.length,
    body: found.bodies.length,
    story: found.stories.length,
    fact: found.facts.length,
    report: found.reports.length,
  };
}