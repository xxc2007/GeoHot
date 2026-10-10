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
function run(apply = false) {
  const args = ['scripts/backfill-papers.ts', '--kinds=daily', `--from=${day}`, `--to=${day}`, '--refresh', `--summary-file=${summaryFile}`];
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
test('a compose failure returns exit 1 and is persisted without endpoint credentials', async () => {
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','physical','河流地貌监测发布新结果','河流地貌监测研究发布新的中文结果。',90,true)`;
  await publishArticle(articleId);
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  const { result, summary } = run(true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.plan[0].note, '这一期失败');
  assert.doesNotMatch(JSON.stringify(summary), /postgres:\/\/|DATABASE_URL|MODEL_CALLS_ENABLED/);
});
