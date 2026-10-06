// `COLLECT_SKIP_JINA=true` is a documented development valve: it leaves out the listings a Jina render is
// bought for, and schedules everything else. This file exists because the valve did neither, in two ways at
// once (both measured 2026-10-05, `tests/fetch-schedule-jina.test.ts` is the repro):
//  · the predicate named its column through an interpolated string, so postgres sent `$1 ->> 'url'` and the
//    server refused to guess a type — every scheduled run threw `operator is not unique`, which with it
//    went nothing at all. An earlier read of the same lines predicted a quiet blackout instead.
//  · "everything else" is a negation over two jsonb keys, and most RSS sources set only `feedUrl`, so a
//    missing `coalesce` turns `NULL OR FALSE` into NULL and `AND NOT (…)` drops those rows. 53 of the 79
//    collectable sources in `industry/sources.json` are that shape: the valve would have switched off two
//    thirds of the feeds without a line in the log.
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { scheduleDueSources } from "@aihot/backend/sources/collect";

const T = tag();
// The three shapes a source config can have, only one of which is paid.
const FEED_ONLY = `test-jina-feedonly-${T}`;
const PAID = `test-jina-paid-${T}`;
const PLAIN_URL = `test-jina-plainurl-${T}`;
const IDS = [FEED_ONLY, PAID, PLAIN_URL];

let parked: Array<{ id: string; next_fetch_at: Date | null }> = [];
const savedEnv = { kinds: process.env.COLLECT_KINDS, skip: process.env.COLLECT_SKIP_JINA };

/** The test sources the scheduler has *not* picked up: `scheduleDueSources` moves a due row 10 minutes ahead. */
async function stillDue(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources WHERE id IN ${sql(IDS)} AND enabled AND next_fetch_at IS NOT NULL AND next_fetch_at <= now()`;
  return rows.map((r) => r.id).sort();
}

before(async () => {
  // Only rss competes for the batch, and every other rss row is parked in the future, so the limit cannot
  // decide this test — the predicate does.
  parked = await sql`SELECT id, next_fetch_at FROM sources WHERE kind = 'rss'`;
  await sql`UPDATE sources SET next_fetch_at = '2100-01-01' WHERE kind = 'rss'`;
  for (const [id, config] of [
    [FEED_ONLY, { feedUrl: `https://example.org/${T}-a.xml` }],
    [PAID, { url: `https://r.jina.ai/https://example.org/${T}-b.xml` }],
    [PLAIN_URL, { url: `https://example.org/${T}-c.rss` }],
  ] as const) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
              VALUES (${id}, ${id}, 'rss', ${sql.json(config)}, 'T2', 'editorial', '2020-01-01')`;
  }
  process.env.COLLECT_KINDS = "rss";
});

after(async () => {
  for (const p of parked) await sql`UPDATE sources SET next_fetch_at = ${p.next_fetch_at} WHERE id = ${p.id}`;
  if (savedEnv.kinds === undefined) delete process.env.COLLECT_KINDS;
  else process.env.COLLECT_KINDS = savedEnv.kinds;
  if (savedEnv.skip === undefined) delete process.env.COLLECT_SKIP_JINA;
  else process.env.COLLECT_SKIP_JINA = savedEnv.skip;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

test("不跳 Jina 时三种配置都排得上", async () => {
  delete process.env.COLLECT_SKIP_JINA;
  await scheduleDueSources(40);
  assert.deepEqual(await stillDue(), [], "跳过的和不该跳的都排班了，没有一条留在到期状态");
});

test("跳 Jina 只排除真走 Jina 渲染的那一条：只写 feedUrl 的 RSS 源不能因为 NULL 被顺手排除", async () => {
  process.env.COLLECT_SKIP_JINA = "true";
  // Put the three back into due: the previous test scheduled them.
  await sql`UPDATE sources SET next_fetch_at = '2020-01-01' WHERE id IN ${sql(IDS)}`;
  // A broken predicate used to throw here (`operator is not unique: unknown ->> unknown`), which took the
  // whole minute's scheduling with it; reaching the assertions at all is part of what this pins.
  await scheduleDueSources(40);
  const left = await stillDue();
  assert.ok(!left.includes(FEED_ONLY), `${FEED_ONLY} 没有被排班——只写 feedUrl 的源被 AND NOT (…) 的 NULL 吃掉了，paidListingSql 少了 coalesce`);
  assert.ok(!left.includes(PLAIN_URL), "带非 Jina url 的源也该排上");
  assert.ok(left.includes(PAID), "只有真买了 Jina 渲染的那一条才被留下不排");
});
