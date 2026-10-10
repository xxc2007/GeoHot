// Two properties this repository's test suite depends on and nothing used to check.
//
// (1) `tests/setup.ts` is what stops the invariant tests writing into a real database — it refuses any
// `DATABASE_URL` whose name does not end in `_test` or `_ci`, and it is where the stubbed credentials and
// the "push nothing" valves come from. That only holds for a file that imports it, and it has to be
// *before* the first `@aihot/backend/db` import (ESM evaluates a module's imports in source order, so
// `db.ts` reading `process.env.DATABASE_URL` at import time happens first if it is listed first). Four
// files imported the database and not the guard; one of them (`queue-options-drift`) sends real queue
// work. The scan below is the rule, so a fifth file cannot appear.
//
// (2) A test that enqueues work and then deletes the rows it was about leaves the job behind: pg-boss's
// `data->>'articleId'` is the child side of a link our schema cannot cascade across. Measured 2026-10-10
// in `geohot_test`: 9,940 rows in state `created`, 9,800 naming a subject that no longer exists. The
// second test drives the real enqueue path and pins that `purgeTagged` now takes those rows with it —
// and leaves alone a job whose article is still there, which is what a shutdown or retry test relies on.
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const TAG = tag();
/** A tag this run never purges, so one job keeps its subject: the sweep must be selective, not global. */
const KEEP = tag();
const GONE_SOURCE = `test-hygiene-gone-${TAG}`;
const KEEP_SOURCE = `test-hygiene-keep-${KEEP}`;

/** A comment-free copy: a comment may name the database module without importing it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const waitingJob = async (articleId: string) =>
  (await sql<{ id: string }[]>`
    SELECT id FROM "pgboss"."job" WHERE state = 'created' AND data ->> 'articleId' = ${articleId} LIMIT 1`)[0]?.id ?? null;

/** Create one source + one article and put it through the normal queueing path. */
async function seed(sourceId: string): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/hygiene-${sourceId}`, title: `Hygiene ${sourceId}`, bodyText: "Body.",
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await queueProcessing(articleId);
  assert.notEqual(await waitingJob(articleId), null, `${sourceId}: the queueing path stored no waiting job`);
  return articleId;
}

before(async () => {
  for (const id of [GONE_SOURCE, KEEP_SOURCE]) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
              VALUES (${id}, ${id}, 'rss', 'T2', 'editorial', '2100-01-01')`;
  }
});
after(async () => {
  await purgeTagged(TAG, KEEP);
  await stopBoss();
  await closeDb();
});

test("每个碰数据库的测试文件都先走 setup 的废库闸门", () => {
  const dir = path.join(REPO_ROOT, "tests");
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort()) {
    const src = code(readFileSync(path.join(dir, file), "utf8"));
    const dbAt = src.search(/["']@aihot\/backend\/db["']/);
    if (dbAt < 0) continue;
    const setupAt = src.search(/["']\.\/setup\.ts["']/);
    if (setupAt < 0) offenders.push(`${file} 导入了 @aihot/backend/db，却没有导入 ./setup.ts`);
    else if (setupAt > dbAt) offenders.push(`${file} 的 ./setup.ts 排在 db 之后，闸门来不及拦`);
  }
  assert.deepEqual(offenders, [], "上面的文件会绕过「测试库必须以 _test/_ci 结尾」这道闸门");
});

test("purgeTagged 带走条目已消失的等待任务，留下条目还在的那一条", async () => {
  const gone = await seed(GONE_SOURCE);
  const kept = await seed(KEEP_SOURCE);

  await purgeTagged(TAG);

  const left = await sql`SELECT 1 FROM articles WHERE id = ${gone}`;
  assert.equal(left.length, 0, "夹具条目应被收走");
  assert.equal(await waitingJob(gone), null, "条目没了，等着它的任务也不该留在队列里");
  assert.notEqual(await waitingJob(kept), null, "条目还在，别人的在飞任务不该被这个文件收走");
});
