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
/** 失败答案最多重排几次；正文的“部分成功”（stale + 已写入若干块）另按 {@link MAX_PARTIAL_SWEEPS} 计。 */
const MAX_SWEEP_ATTEMPTS = 3;
/**
 * 正文没译完但每轮都有块落库时的上限。60k 正文按 6k/批最少 10 轮；30 轮给模型异常留 3 倍余量。
 * 超过就停排：块结构对不上时 priorBlocks 会让整篇重新进 missing，不设上限等于无限付费重试。
 */
const MAX_PARTIAL_SWEEPS = 30;

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
 */
export async function sweepEnglish(): Promise<SweepReport> {
  const empty: SweepReport = { copy: 0, body: 0, story: 0, fact: 0, report: 0 };
  const [backlog] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pgboss.job
     WHERE name = ${QUEUES.english} AND state IN ('created', 'retry', 'active')`;
  if ((backlog?.n ?? 0) >= MAX_ENGLISH_BACKLOG) {
    return { ...empty, deferred: true, reason: `english backlog ${backlog?.n}` };
  }

  const copies = await sql<{ article_id: string }[]>`
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
  for (const row of copies) {
    await enqueue(QUEUES.english, { kind: "copy", articleId: row.article_id }, { singletonKey: `en-copy:${row.article_id}` });
  }

  const bodies = await sql<{ id: string }[]>`
    SELECT a.id
      FROM articles a JOIN publications p ON p.article_id = a.id
      LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'en' AND tr.revision = a.revision
      LEFT JOIN english_attempts ea
        ON ea.kind = 'body' AND ea.subject = a.id AND ea.source_revision = a.revision::text
     WHERE p.visibility = 'public' AND p.body_mode = 'full'
       AND (tr.article_id IS NULL OR tr.complete IS NOT TRUE)
       AND (ea.outcome IS NULL
         OR (ea.outcome = 'stale' AND ea.partial_attempts < ${MAX_PARTIAL_SWEEPS})
         OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
     ORDER BY p.timeline_at DESC, a.id
     LIMIT ${SWEEP_LIMIT}`;
  for (const row of bodies) {
    await enqueue(QUEUES.english, { kind: "body", articleId: row.id }, { singletonKey: `en-body:${row.id}` });
  }

  const stories = await sql<{ id: string }[]>`
    SELECT s.id::text AS id
      FROM stories s
      LEFT JOIN english_attempts ea
        ON ea.kind = 'story' AND ea.subject = s.id::text AND ea.source_revision = s.version::text
     WHERE s.merged_into IS NULL AND coalesce(s.digest, '') <> ''
       AND s.english_source_version IS DISTINCT FROM s.version
       AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
     ORDER BY s.latest_at DESC NULLS LAST, s.id
     LIMIT ${SWEEP_LIMIT}`;
  for (const row of stories) {
    await enqueue(QUEUES.english, { kind: "story", storyId: Number(row.id) }, { singletonKey: `en-story:${row.id}` });
  }

  // facts 没有可用的版本列：用 `f<条数>:<最大 id>` 作为这批事实的 revision，写回与 sweep 同一个公式。
  const facts = await sql<{ id: string }[]>`
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
  for (const row of facts) {
    await enqueue(QUEUES.english, { kind: "fact-titles", storyId: Number(row.id) }, { singletonKey: `en-facts:${row.id}` });
  }

  const reports = await sql<{ kind: "daily" | "weekly" | "monthly"; key: string }[]>`
    SELECT r.kind, r.key
      FROM reports r
      LEFT JOIN english_attempts ea
        ON ea.kind = 'report' AND ea.subject = r.kind || ':' || r.key AND ea.source_revision = r.revision::text
     WHERE (r.revision_en IS DISTINCT FROM r.revision OR r.content_en IS NULL)
       AND (ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < ${MAX_SWEEP_ATTEMPTS}))
     ORDER BY r.generated_at DESC, r.kind, r.key
     LIMIT ${SWEEP_LIMIT}`;
  for (const row of reports) {
    await enqueue(QUEUES.english, { kind: "report", reportKind: row.kind, key: row.key }, { singletonKey: `en-report:${row.kind}:${row.key}` });
  }

  return { copy: copies.length, body: bodies.length, story: stories.length, fact: facts.length, report: reports.length };
}