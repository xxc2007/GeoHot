// 英文覆盖率：按 scope / 类型打印 publications、正文、事件、事实、报刊与引用快照的覆盖与缺口。
// 只读库、不发模型、不入队；发布卡口用它回答「这一批到底有没有英文版」。
//
//   node --env-file=.env scripts/english-coverage.ts --scope parity --window 30d
//   node --env-file=.env scripts/english-coverage.ts --scope english --window all
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";

const { values } = parseArgs({
  options: {
    scope: { type: "string", default: "parity" },
    window: { type: "string", default: "30d" },
  },
});

if (values.scope !== "parity" && values.scope !== "english") {
  console.error("--scope 必须是 parity 或 english");
  process.exit(2);
}
const windowDays = values.window === "all" ? null : values.window === "7d" ? 7 : values.window === "30d" ? 30 : NaN;
if (values.window !== "all" && !Number.isInteger(windowDays)) {
  console.error("--window 必须是 7d、30d 或 all");
  process.exit(2);
}
const scope = values.scope as "parity" | "english";
const englishOnly = scope === "english";
const withinWindow = windowDays === null ? sql`true` : sql`p.timeline_at >= now() - ${`${windowDays} days`}::interval`;

interface Coverage {
  total: number;
  covered: number;
  missing: number;
  ratio: number;
}
const coverage = (total: number, covered: number): Coverage => ({
  total,
  covered,
  missing: total - covered,
  ratio: total ? Number((covered / total).toFixed(3)) : 0,
});

const [copy] = await sql<{ total: number; covered: number }[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (
           WHERE p.english_source_revision = p.revision
             AND coalesce(p.title_en, '') <> '' AND coalesce(p.summary_en, '') <> ''
         )::int AS covered
    FROM publications p JOIN articles a ON a.id = p.article_id
   WHERE p.visibility = 'public' AND ${withinWindow} AND (${englishOnly} IS NOT TRUE OR a.language = 'en')`;

const [body] = await sql<{ total: number; covered: number }[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE tr.complete AND tr.revision = a.revision AND coalesce(tr.body_text, '') <> '')::int AS covered
    FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'en'
   WHERE p.visibility = 'public' AND p.body_mode = 'full' AND ${withinWindow}`;

const [stories] = await sql<{ total: number; covered: number }[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE s.english_source_version = s.version AND coalesce(s.title_en, '') <> '')::int AS covered
    FROM stories s
   WHERE s.merged_into IS NULL AND coalesce(s.digest, '') <> ''`;

const [facts] = await sql<{ total: number; covered: number }[]>`
  SELECT count(*)::int AS total, count(*) FILTER (WHERE coalesce(f.title_en, '') <> '')::int AS covered
    FROM facts f JOIN stories s ON s.id = f.story_id AND s.merged_into IS NULL`;

const [reports] = await sql<{ total: number; covered: number }[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE r.revision_en = r.revision AND r.content_en IS NOT NULL)::int AS covered
    FROM reports r`;

const [citations] = await sql<{ editions: number; snapshots: number }[]>`
  SELECT count(*) FILTER (WHERE r.content_en ? 'citations')::int AS editions,
         coalesce(sum(jsonb_array_length(coalesce(r.content_en->'citations', '[]'::jsonb))), 0)::int AS snapshots
    FROM reports r`;

const [quotes] = await sql<{ total: number; covered: number }[]>`
  WITH quoted AS (
    SELECT DISTINCT ON (q.tweet_id) q.tweet_id,
           encode(sha256(convert_to(a.x_post->'quoted'->>'text', 'UTF8')), 'hex') AS text_hash
      FROM publications p JOIN articles a ON a.id = p.article_id
      CROSS JOIN LATERAL (SELECT substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)') AS tweet_id) q
     WHERE p.channel = 'x' AND p.visibility = 'public' AND q.tweet_id IS NOT NULL
       AND coalesce(a.x_post->'quoted'->>'text', '') <> ''
     ORDER BY q.tweet_id, p.discovered_at DESC, p.article_id
  )
  SELECT count(*)::int AS total, count(*) FILTER (WHERE qt.text_hash = quoted.text_hash)::int AS covered
    FROM quoted LEFT JOIN quote_translations_en qt ON qt.tweet_id = quoted.tweet_id`;

console.log(JSON.stringify({
  scope,
  window: values.window,
  publications: coverage(copy!.total, copy!.covered),
  body: coverage(body!.total, body!.covered),
  stories: coverage(stories!.total, stories!.covered),
  facts: coverage(facts!.total, facts!.covered),
  reports: coverage(reports!.total, reports!.covered),
  quotes: coverage(quotes!.total, quotes!.covered),
  citations: { editionsWithSnapshot: citations!.editions, snapshots: citations!.snapshots },
  note: scope === "english"
    ? "scope=english 只收窄 publications/body；stories/facts/reports 是跨语言聚合"
    : undefined,
}, null, 2));

await closeDb();