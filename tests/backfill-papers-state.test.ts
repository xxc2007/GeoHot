import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const source = `test-paper-cli-${T}`;
const day = "2018-04-02";
const inside = new Date("2018-04-01T12:00:00Z");
const dir = mkdtempSync(path.join(tmpdir(), "geohot-paper-state-"));
const summaryFile = path.join(dir, "summary.json");
let articleId = "";
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${source}, 'CLI test', 'rss', 'T1', 'editorial')`;
  const item = await upsertMaterial({ sourceId: source, url: `https://example.com/${T}`, title: 'Archive bulletin', publishedAt: inside,
    discoveredAt: new Date(), via: 'import', backfill: 'archive', bodyStatus: 'ok', bodyText: 'A geographic bulletin.' });
  articleId = item.articleId;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind='daily' AND key=${day}`;
  await sql`DELETE FROM reports WHERE kind='daily' AND key='2018-04-01'`;
  await sql`DELETE FROM publications WHERE article_id=${articleId}`;
  await sql`DELETE FROM analyses WHERE article_id=${articleId}`;
  await sql`DELETE FROM article_discoveries WHERE article_id=${articleId}`;
  await sql`DELETE FROM article_revisions WHERE article_id=${articleId}`;
  await sql`DELETE FROM articles WHERE id=${articleId}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});
function run(apply = false, refresh = true, verify = false, targetDay = day) {
  const args = ['scripts/backfill-papers.ts', '--kinds=daily', `--from=${targetDay}`, `--to=${targetDay}`, `--summary-file=${summaryFile}`];
  if (refresh) args.push('--refresh');
  if (verify) args.push('--verify-complete');
  if (apply) args.push('--apply', '--database-url-env=DATABASE_URL');
  const result = spawnSync(process.execPath, args, { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, MODEL_CALLS_ENABLED: 'false', COLLECT_ENABLED: 'false' } });
  assert.equal(result.error, undefined, String(result.error));
  return { result, summary: JSON.parse(readFileSync(summaryFile, 'utf8')) };
}
test('zero candidates with pending archive material is waiting, not an empty settled period', () => {
  const { result, summary } = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summary.plan[0].items, 0);
  assert.match(summary.plan[0].note, /等 \d+ 条判完/);
});
test('an existing empty issue still exposes pending and is not reported as published', async () => {
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,origin)
    VALUES ('daily',${day},${new Date('2018-04-01T00:00:00Z')},${new Date('2018-04-02T00:00:00Z')},${sql.json({sections:[],flashes:[]} as never)},now(),'manual')`;
  const pending = run(false, false);
  assert.match(pending.summary.plan[0].note, /等 \d+ 条判完/);
  assert.equal(pending.summary.plan[0].exists, true);
  assert.equal(pending.summary.plan[0].readable, false);
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${articleId}`;
  const settled = run(false, false);
  assert.equal(settled.summary.plan[0].note, '已有不可读刊期（需 --refresh 复核）');
  assert.equal(settled.summary.plan[0].waiting, 0);
  assert.doesNotMatch(settled.result.stdout, /已出刊/);
  await sql`UPDATE articles SET processing_state='new' WHERE id=${articleId}`;
});
test('a compose failure returns exit 1 and is persisted without endpoint credentials', async () => {
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','physical','河流地貌监测发布新结果','河流地貌监测研究发布新的中文结果。',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 1000) });
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  const { result, summary } = run(true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.plan[0].note, '这一期失败');
  assert.doesNotMatch(JSON.stringify(summary), /postgres:\/\/|DATABASE_URL|MODEL_CALLS_ENABLED/);
});
test('a readable existing issue exposes later pending work and only says readable after settlement', async () => {
  await sql`UPDATE reports SET content=${sql.json({sections:[{label:'学科',items:[{itemId:articleId,title:'河流地貌监测发布新结果',summary:'中文监测摘要。'}]}],flashes:[]} as never)}
    WHERE kind='daily' AND key=${day}`;
  await sql`UPDATE articles SET processing_state='new' WHERE id=${articleId}`;
  const pending = run(false, false);
  assert.equal(pending.summary.plan[0].readable, true);
  assert.match(pending.summary.plan[0].note, /等 \d+ 条判完/);
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  const settled = run(false, false);
  assert.equal(settled.summary.plan[0].waiting, 0);
  assert.equal(settled.summary.plan[0].readable, true);
  assert.equal(settled.summary.plan[0].note, '已有可读刊期（未重排）');
});
test('successful apply rechecks an empty issue after real previous-issue deduplication', async () => {
  // The pre-dedupe candidate is real and publishable, but an earlier issue already carried it.
  // With model calls disabled, a successful composition also proves the empty edition bought no lead.
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('daily','2018-04-01',${new Date('2018-03-31T00:00:00Z')},${new Date('2018-04-01T00:00:00Z')},
      ${sql.json({sections:[{label:'学科',items:[{itemId:articleId,title:'前期已刊监测结果'}]}],flashes:[]} as never)},now(),'manual')`;
  const { result, summary } = run(true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(summary.failures.length, 0);
  const period = summary.plan[0];
  assert.equal(period.items, 1, 'the planner counts the actual candidate before repeat suppression');
  assert.equal(period.waiting, 0);
  assert.equal(period.exists, true);
  assert.equal(period.entries, 0);
  assert.equal(period.readable, false);
  assert.equal(period.note, '已保存空刊或不可读刊期');
  const [saved] = await sql`SELECT content FROM reports WHERE kind='daily' AND key=${day}`;
  assert.deepEqual(saved!.content.sections, []);
  assert.equal(saved!.content.generator.repeatsSuppressed, 1);
});

test('verify-complete distinguishes missing, pending, readable and genuine deduplicated emptiness without writes', async () => {
  async function snapshot() {
    const [row] = await sql`SELECT (SELECT count(*)::int FROM reports) reports,
      (SELECT count(*)::int FROM report_revisions) revisions,(SELECT count(*)::int FROM receipts) receipts`;
    return row;
  }
  const before = await snapshot();
  const deduplicated = run(false, false, true);
  assert.equal(deduplicated.result.status, 1);
  assert.equal(deduplicated.summary.plan[0].status, 'empty-not-published');
  assert.equal(deduplicated.summary.plan[0].items, 1);
  assert.equal(deduplicated.summary.plan[0].entries, 0);
  assert.equal(deduplicated.summary.verification.passed, false);
  assert.ok(deduplicated.summary.verification.notEvaluated.includes('unknown-analysis-disposition'));
  assert.ok(deduplicated.summary.verification.notEvaluated.includes('refresh-freshness'));

  const zero = run(false, false, true, '2018-05-02');
  assert.equal(zero.result.status, 0);
  assert.equal(zero.summary.plan[0].status, 'zero-material');
  assert.equal(zero.summary.plan[0].exists, false);
  assert.equal(zero.summary.verification.scope, 'closed-report-periods');

  await sql`UPDATE articles SET processing_state='new' WHERE id=${articleId}`;
  const pending = run(false, false, true);
  assert.equal(pending.result.status, 1);
  assert.equal(pending.summary.plan[0].status, 'waiting');
  assert.equal(pending.summary.verification.blockers[0].code, 'waiting');
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  await sql`DELETE FROM reports WHERE kind='daily' AND key=${day}`;
  const missing = run(false, false, true);
  assert.equal(missing.result.status, 1);
  assert.equal(missing.summary.plan[0].status, 'missing-readable-report');
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('daily',${day},${new Date('2018-04-01T00:00:00Z')},${new Date('2018-04-02T00:00:00Z')},
      ${sql.json({sections:[{label:'学科',items:[{itemId:articleId,title:'监测结果'}]}],flashes:[{itemId:articleId,title:'监测快讯'}]} as never)},now(),'manual')`;
  const readable = run(false, false, true);
  assert.equal(readable.result.status, 0);
  assert.equal(readable.summary.plan[0].status, 'readable');
  assert.equal(readable.summary.plan[0].entries, 2, 'saved sections and flashes are both counted');
  assert.equal(readable.summary.plan[0].readable, true);
  await sql`UPDATE articles SET processing_state='new' WHERE id=${articleId}`;
  const readablePending = run(false, false, true);
  assert.equal(readablePending.result.status, 1);
  assert.equal(readablePending.summary.plan[0].readable, true);
  assert.equal(readablePending.summary.plan[0].status, 'waiting');
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  // The only changes above are explicit fixture mutations, not the verify CLI.
  assert.equal((await snapshot()).receipts, before.receipts);
});

test('flash-only and withdrawn/future citations reuse the real public readability gate', async () => {
  await sql`UPDATE reports SET content=${sql.json({sections:[],flashes:[{itemId:articleId,title:'真实快讯'}]} as never)} WHERE kind='daily' AND key=${day}`;
  const flash = run(false, false, true);
  assert.equal(flash.result.status, 1);
  assert.equal(flash.summary.plan[0].entries, 1);
  assert.equal(flash.summary.plan[0].readable, false, 'the public gate explicitly excludes flashes');
  assert.equal(flash.summary.plan[0].status, 'empty-not-published');
  await sql`UPDATE reports SET content=${sql.json({sections:[{label:'学科',items:[{itemId:articleId,title:'监测结果'}]}],flashes:[]} as never)} WHERE kind='daily' AND key=${day}`;
  await sql`UPDATE publications SET visible_after=now()+interval '1 hour' WHERE article_id=${articleId}`;
  assert.equal(run(false, false, true).summary.plan[0].status, 'empty-not-published');
  await sql`UPDATE publications SET visible_after=now()-interval '1 hour',visibility='withdrawn' WHERE article_id=${articleId}`;
  assert.equal(run(false, false, true).summary.plan[0].status, 'empty-not-published');
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${articleId}`;
});
