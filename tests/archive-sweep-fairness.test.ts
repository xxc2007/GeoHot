import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { queueProcessing, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-archive-sweep-${T}`;
const collectBefore = process.env.COLLECT_ENABLED;
process.env.COLLECT_ENABLED = "false";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Sweep fixture', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  if (collectBefore === undefined) delete process.env.COLLECT_ENABLED;
  else process.env.COLLECT_ENABLED = collectBefore;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

async function seed(ordinary: number, archive: number) {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id = ${SOURCE})`.catch(() => {});
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  // Ordinary imports are deliberately older, reproducing the production starvation.
  for (const [band, count, discovered] of [["ordinary", ordinary, "1990-01-01"], ["archive", archive, "2000-01-01"]] as const) {
    if (!count) continue;
    await sql`
      INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, published_at,
        timeline_at, backfill, backfill_reason, body_status, body_text, created_at)
      SELECT ${`${T}-${band}-`} || lpad(n::text, 4, '0'), ${SOURCE}, ${`${T}-${band}-`} || n,
        'https://example.com/' || ${`${T}-${band}-`} || n, 'Sweep fixture', ${discovered}::timestamptz,
        '1980-01-01'::timestamptz, '1980-01-01'::timestamptz, true,
        ${band === "archive" ? "archive" : "first-import"}, 'ok', 'Original body.', now() - interval '1 hour'
      FROM generate_series(1, ${count}::int) AS n`;
  }
}

async function queuedCounts() {
  const rows = await sql<{ band: string; n: number }[]>`
    SELECT CASE WHEN backfill_reason = 'archive' THEN 'archive' ELSE 'ordinary' END AS band, count(*)::int AS n
    FROM articles WHERE source_id = ${SOURCE} AND processing_queued_at IS NOT NULL GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.band, r.n]));
}

test("a saturated older import cannot take the archive's 100 places; the sweep stays at 500", async () => {
  await seed(700, 120);
  const oldSelection = await sql<{ backfill_reason: string }[]>`SELECT backfill_reason FROM articles
    WHERE source_id = ${SOURCE} ORDER BY discovered_at, id LIMIT 500`;
  assert.equal(oldSelection.filter((r) => r.backfill_reason === 'archive').length, 0, "the former oldest-only selection starves this archive backlog");
  assert.equal((await sweepUnprocessed()).enqueued, 500);
  assert.deepEqual(await queuedCounts(), { ordinary: 400, archive: 100 });
  const priorities = await sql<{ reason: string; priority: number }[]>`
    SELECT DISTINCT a.backfill_reason AS reason, j.priority FROM pgboss.job j
    JOIN articles a ON a.id = j.data->>'articleId' WHERE a.source_id = ${SOURCE}`;
  assert.deepEqual(Array.from(priorities).sort((a, b) => a.reason.localeCompare(b.reason)), [
    { reason: "archive", priority: -1 }, { reason: "first-import", priority: -2 },
  ]);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id = ${`${T}-ordinary-0400`} AND processing_queued_at IS NOT NULL`).length, 1);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id = ${`${T}-ordinary-0401`} AND processing_queued_at IS NOT NULL`).length, 0);
});

test("without archive work all 500 places remain available to ordinary work", async () => {
  await seed(600, 0);
  assert.equal((await sweepUnprocessed()).enqueued, 500);
  assert.deepEqual(await queuedCounts(), { ordinary: 500 });
});

test("archives use places left by fewer ordinary candidates, without raising the limit", async () => {
  await seed(20, 600);
  assert.equal((await sweepUnprocessed()).enqueued, 500);
  assert.deepEqual(await queuedCounts(), { ordinary: 20, archive: 480 });
});

test("ordinary work uses the unused archive reservation", async () => {
  await seed(600, 20);
  assert.equal((await sweepUnprocessed()).enqueued, 500);
  assert.deepEqual(await queuedCounts(), { ordinary: 480, archive: 20 });
});

test("the archive slice drains by news date, so a day can actually finish", async () => {
  // 份额对了还不等于日子能过完：档案是"按刊、按月"批量导进来的，`discovered_at` 记的是哪一批插进来，
  // 不是那条新闻是哪天的。按 `discovered_at` 取 100 条 ⇒ 这一百条摊在十个月上，
  // 每一天都差几条，`backfill-papers` 的"等 N 条判完"永远不满足。
  // 生产实测（2026-10-11 19:30）：283 个有档案材料的日子，**已结算 0 个**，最接近结算的那天还等 5 条；
  // 队里那 255 条档案单横跨 2026-01 到 2026-10。
  await seed(700, 120);
  // 让"发现的先后"与"新闻的先后"完全反着：n 越小越先被发现（id 序），但新闻日期越新。
  await sql`UPDATE articles SET timeline_at = TIMESTAMP '2026-01-01' + ((240 - (right(id, 4))::int) * INTERVAL '1 day')
            WHERE source_id = ${SOURCE} AND backfill_reason = 'archive'`;
  const newest = `${T}-archive-0001`; // 最早被发现、新闻日期最新
  const oldest = `${T}-archive-0120`; // 最晚被发现、新闻日期最老
  assert.equal((await sweepUnprocessed()).enqueued, 500);
  const picked = await sql<{ id: string }[]>`
    SELECT id FROM articles WHERE source_id = ${SOURCE} AND backfill_reason = 'archive' AND processing_queued_at IS NOT NULL`;
  const nums = picked.map((r) => Number(r.id.slice(-4))).sort((x, y) => x - y);
  assert.equal(nums.length, 100, "档案那 100 个名额不变（这条不改份额）");
  assert.equal(nums[0], 21, "该取的是新闻日期最早的那 100 条，不是最先入库的 100 条");
  assert.equal(nums.at(-1), 120);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id = ${newest} AND processing_queued_at IS NOT NULL`).length, 0,
    "最新那天的档案材料要排在后面，不然一月永远结不了算");
  assert.equal((await sql`SELECT 1 FROM articles WHERE id = ${oldest} AND processing_queued_at IS NOT NULL`).length, 1);
});

test("retry and pending guards hold; an archive needs its original body before analysis and singleton jobs deduplicate", async () => {
  await seed(0, 5);
  const ids = Array.from({ length: 5 }, (_, i) => `${T}-archive-${String(i + 1).padStart(4, "0")}`);
  await sql`UPDATE articles SET body_text = NULL, body_status = 'pending' WHERE id = ${ids[0]!}`;
  await sql`UPDATE articles SET processing_retry_at = now() + interval '1 hour' WHERE id = ${ids[1]!}`;
  await sql`UPDATE articles SET processing_queued_at = now() WHERE id = ${ids[2]!}`;
  await sql`UPDATE articles SET created_at = now() WHERE id = ${ids[3]!}`;
  await sql`UPDATE articles SET processing_state = 'failed' WHERE id = ${ids[4]!}`;
  process.env.COLLECT_ENABLED = "true"; // Queue only; no worker or network request is started.
  try {
    assert.equal((await sweepUnprocessed()).enqueued, 1);
    assert.equal((await sweepUnprocessed()).enqueued, 0, "a newly queued archive is left alone");
    assert.equal(await queueProcessing(ids[0]!), null, "singleton prevents a duplicate waiting extraction job");
    const jobs = await sql<{ name: string; priority: number }[]>`SELECT name, priority FROM pgboss.job WHERE data->>'articleId' = ${ids[0]!}`;
    assert.deepEqual(Array.from(jobs), [{ name: "content.extract-body", priority: -1 }]);
    await sql`UPDATE pgboss.job SET state = 'completed' WHERE data->>'articleId' = ${ids[0]!}`;
    await sql`UPDATE articles SET body_text = 'Verified original body.', body_status = 'ok' WHERE id = ${ids[0]!}`;
    await queueProcessing(ids[0]!);
    assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId' = ${ids[0]!} AND name = 'content.analyze' AND state = 'created'`).length, 1);
  } finally {
    process.env.COLLECT_ENABLED = "false";
  }
});
