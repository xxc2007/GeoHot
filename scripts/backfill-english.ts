// 英文腿回填：只入队，不直接调模型。
//
// 与 content.english-sweep 用同一套「还缺英文」判据（0128/0129 的新鲜度列 + english_attempts 的终态），
// 所以重复跑不会重复买同一份答复：written/translated/skipped 的 (kind, subject, source_revision) 不再入队，
// failed/stale 最多重排 3 次。真正花钱的是 content.english 队列；本脚本在任何机器上都可以跑。
//
//   node --env-file=.env scripts/backfill-english.ts --kind all --scope parity --window 30d --dry-run
//   node --env-file=.env scripts/backfill-english.ts --kind copy,body --window 7d --limit 200
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { englishConcurrency } from "@aihot/backend/editorial/english";
import type { EnglishJob } from "@aihot/backend/jobs/english";

const KINDS = ["copy", "body", "story", "fact", "report", "quote"] as const;
type Kind = (typeof KINDS)[number];

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "all" },
    scope: { type: "string", default: "parity" },
    window: { type: "string", default: "30d" },
    limit: { type: "string", default: "500" },
    "dry-run": { type: "boolean", default: false },
  },
});

const requested = values.kind!.split(",").map((k) => k.trim()).filter(Boolean);
if (!requested.length || requested.some((k) => !(k === "all" || (KINDS as readonly string[]).includes(k)))) {
  console.error(`--kind 必须是 ${KINDS.join("/")}/all 的逗号分隔列表（收到 ${values.kind}）`);
  process.exit(2);
}
const kinds: Kind[] = requested.includes("all") ? [...KINDS] : ([...new Set(requested)] as Kind[]);
if (values.scope !== "parity" && values.scope !== "english") {
  console.error("--scope 必须是 parity（与中文同一批）或 english（只补英文源）");
  process.exit(2);
}
const windowDays = values.window === "all" ? null : values.window === "7d" ? 7 : values.window === "30d" ? 30 : NaN;
if (values.window !== "all" && !Number.isInteger(windowDays)) {
  console.error("--window 必须是 7d、30d 或 all");
  process.exit(2);
}
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
  console.error(`--limit 必须是 1-5000 的整数（收到 ${values.limit}）`);
  process.exit(2);
}

const scope = values.scope as "parity" | "english";
const englishOnly = scope === "english";
const withinWindow = windowDays === null ? sql`true` : sql`p.timeline_at >= now() - ${`${windowDays} days`}::interval`;

/** 终态（written/translated/skipped）不再排；failed/stale 最多 3 次。 */
const retryable = sql`(ea.outcome IS NULL OR ea.outcome = 'stale' OR (ea.outcome = 'failed' AND ea.attempts < 3))`;

async function copyJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT p.article_id AS id
      FROM publications p JOIN articles a ON a.id = p.article_id
      LEFT JOIN english_attempts ea ON ea.kind = 'copy' AND ea.subject = p.article_id AND ea.source_revision = p.revision::text
     WHERE p.visibility = 'public' AND p.english_source_revision IS DISTINCT FROM p.revision
       AND coalesce(p.title, '') <> '' AND coalesce(p.summary, '') <> ''
       AND ${withinWindow} AND (${englishOnly} IS NOT TRUE OR a.language = 'en')
       AND ${retryable}
     ORDER BY p.timeline_at DESC, p.article_id
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "copy", articleId: r.id }));
}

async function bodyJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT a.id
      FROM articles a JOIN publications p ON p.article_id = a.id
      LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'en' AND tr.revision = a.revision
      LEFT JOIN english_attempts ea ON ea.kind = 'body' AND ea.subject = a.id AND ea.source_revision = a.revision::text
     WHERE p.visibility = 'public' AND p.body_mode = 'full'
       AND (tr.article_id IS NULL OR tr.complete IS NOT TRUE)
       AND ${withinWindow} AND (${englishOnly} IS NOT TRUE OR a.language = 'en')
       AND ${retryable}
     ORDER BY p.timeline_at DESC, a.id
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "body", articleId: r.id }));
}

async function storyJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT s.id::text AS id
      FROM stories s
      LEFT JOIN english_attempts ea ON ea.kind = 'story' AND ea.subject = s.id::text AND ea.source_revision = s.version::text
     WHERE s.merged_into IS NULL AND coalesce(s.digest, '') <> ''
       AND s.english_source_version IS DISTINCT FROM s.version
       AND ${retryable}
     ORDER BY s.latest_at DESC NULLS LAST, s.id
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "story", storyId: Number(r.id) }));
}

async function factJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ id: string }[]>`
    WITH factsets AS (
      SELECT story_id, count(*)::int AS n, max(id)::text AS max_id FROM facts WHERE story_id IS NOT NULL GROUP BY story_id
    )
    SELECT fs.story_id::text AS id
      FROM factsets fs JOIN stories s ON s.id = fs.story_id AND s.merged_into IS NULL
      LEFT JOIN english_attempts ea ON ea.kind = 'fact' AND ea.subject = fs.story_id::text
        AND ea.source_revision = 'f' || fs.n::text || ':' || coalesce(fs.max_id, '0')
     WHERE EXISTS (SELECT 1 FROM facts f WHERE f.story_id = fs.story_id AND f.title_en IS NULL)
       AND ${retryable}
     ORDER BY s.latest_at DESC NULLS LAST, fs.story_id
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "fact-titles", storyId: Number(r.id) }));
}

async function reportJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ kind: "daily" | "weekly" | "monthly"; key: string }[]>`
    SELECT r.kind, r.key
      FROM reports r
      LEFT JOIN english_attempts ea ON ea.kind = 'report' AND ea.subject = r.kind || ':' || r.key AND ea.source_revision = r.revision::text
     WHERE (r.revision_en IS DISTINCT FROM r.revision OR r.content_en IS NULL) AND ${retryable}
     ORDER BY r.generated_at DESC, r.kind, r.key
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "report", reportKind: r.kind, key: r.key }));
}

async function quoteJobs(): Promise<EnglishJob[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT DISTINCT ON (q.tweet_id) q.tweet_id AS id
      FROM publications p JOIN articles a ON a.id = p.article_id
      CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
      LEFT JOIN quote_translations_en qt ON qt.tweet_id = q.tweet_id
      LEFT JOIN english_attempts ea ON ea.kind = 'quote' AND ea.subject = q.tweet_id
        AND ea.source_revision = encode(sha256(convert_to(a.x_post->'quoted'->>'text', 'UTF8')), 'hex')
     WHERE p.channel = 'x' AND p.visibility = 'public' AND q.tweet_id IS NOT NULL
       AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
       AND qt.text_hash IS DISTINCT FROM encode(sha256(convert_to(a.x_post->'quoted'->>'text', 'UTF8')), 'hex')
       AND ${retryable}
     ORDER BY q.tweet_id, p.discovered_at DESC, p.article_id
     LIMIT ${limit}`;
  return rows.map((r) => ({ kind: "quote", tweetId: r.id }));
}

const loaders: Record<Kind, () => Promise<EnglishJob[]>> = {
  copy: copyJobs,
  body: bodyJobs,
  story: storyJobs,
  fact: factJobs,
  report: reportJobs,
  quote: quoteJobs,
};

const singletonKeys: Record<EnglishJob["kind"], (job: EnglishJob) => string> = {
  copy: (job) => `en-copy:${(job as { articleId: string }).articleId}`,
  body: (job) => `en-body:${(job as { articleId: string }).articleId}`,
  story: (job) => `en-story:${(job as { storyId: number }).storyId}`,
  "fact-titles": (job) => `en-facts:${(job as { storyId: number }).storyId}`,
  report: (job) => {
    const r = job as { reportKind: string; key: string };
    return `en-report:${r.reportKind}:${r.key}`;
  },
  quote: (job) => `en-quote:${(job as { tweetId: string }).tweetId}`,
};

const planned: Record<string, number> = {};
const enqueued: Record<string, number> = {};
for (const kind of kinds) {
  const jobs = await loaders[kind]();
  planned[kind] = jobs.length;
  enqueued[kind] = 0;
  if (values["dry-run"]) continue;
  for (const job of jobs) {
    await enqueue(QUEUES.english, job, { singletonKey: singletonKeys[job.kind](job) });
    enqueued[kind] += 1;
  }
}

console.log(JSON.stringify({
  scope,
  window: values.window,
  limit,
  dryRun: !!values["dry-run"],
  planned,
  enqueued,
  englishConcurrency: englishConcurrency(),
  note: englishConcurrency() === 0
    ? "ENGLISH_CONCURRENCY=0 on this node: jobs wait for a backfill node with ENGLISH_CONCURRENCY>=1 and GEOHOT_INTAKE_ENGLISH_SLOTS>=1"
    : "jobs will be consumed by this node if GEOHOT_INTAKE_ENGLISH_SLOTS>=1",
  scopeNote: scope === "english" ? "scope=english only narrows copy/body rows; stories/facts/reports aggregate both languages" : undefined,
}, null, 2));

await stopBoss();
await closeDb();