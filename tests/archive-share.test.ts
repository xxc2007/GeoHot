// The archive pump: a bounded, opt-in slice of the analysis door for backfilled papers. Three promises
// need a gate — the door gives nothing away unless the owner asks (`ARCHIVE_BACKFILL_SHARE`), what it gives
// is *jobs sitting in the live band at once* (not a one-off batch that runs ahead of what the door finishes),
// and only the scholarly record gets the slice: late news and live work keep the bands they had.
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { advanceArchiveBackfill, queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SRC = `test-share-${T}`;

async function seed(label: string, opts: { archive: boolean; daysAgo: number }): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: SRC,
    url: `https://example.com/share-${T}-${label}`,
    title: `${opts.archive ? "档案论文" : "迟到的新闻"} ${label} ${T}`,
    bodyText: "Abstract text for the pump test.",
    bodyStatus: "ok",
    publishedAt: new Date(Date.now() - opts.daysAgo * 86_400_000),
    discoveredAt: new Date(),
    via: opts.archive ? "import" : "fetch",
    backfill: opts.archive ? "archive" : null,
  });
  await queueProcessing(articleId);
  return articleId;
}

async function band(articleId: string): Promise<number | null> {
  const [j] = await sql<{ priority: number }[]>`SELECT priority FROM pgboss.job WHERE singleton_key = ${articleId}`;
  return j?.priority ?? null;
}

/** How many archive analyses the live band already holds — other files' leftovers included, so a test must
 *  buy room above this number rather than assume the band starts empty. */
async function inBand(): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pgboss.job j
     WHERE j.name = ${QUEUES.analyze} AND j.state = 'created' AND j.priority = 0
       AND EXISTS (SELECT 1 FROM articles a WHERE a.id = j.data ->> 'articleId' AND a.backfill_reason = 'archive')`;
  return r!.n;
}

/** Every archive analysis waiting in the record band, in the order the door reaches them. Not only this
 *  file's: the pump serves the whole queue, and another writer's older paper is genuinely next in line. */
async function waitingArchive(): Promise<string[]> {
  return (await sql<{ id: string }[]>`
    SELECT j.id FROM pgboss.job j
      JOIN articles a ON a.id = j.data ->> 'articleId'
     WHERE j.name = ${QUEUES.analyze} AND j.state = 'created' AND j.priority = -1
       AND a.backfill_reason = 'archive'
     ORDER BY j.created_on`).map((r) => r.id);
}

async function bandOfJob(id: string): Promise<number | null> {
  const [j] = await sql<{ priority: number }[]>`SELECT priority FROM pgboss.job WHERE id = ${id}`;
  return j?.priority ?? null;
}

before(async () => {
  delete process.env.ARCHIVE_BACKFILL_SHARE;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC}, 'Archive share test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  const ids = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${SRC}`;
  for (const { id } of ids) await sql`DELETE FROM pgboss.job WHERE singleton_key = ${id}`;
  await sql`DELETE FROM articles WHERE source_id = ${SRC}`;
  await sql`DELETE FROM sources WHERE id = ${SRC}`;
  await purgeTagged(T);
  await stopBoss();
  await closeDb();
});

test("the backfill takes no slot at the door unless the owner buys one", async () => {
  const ids = [await seed("parked-a", { archive: true, daysAgo: 200 }), await seed("parked-b", { archive: true, daysAgo: 199 })];
  assert.deepEqual(await advanceArchiveBackfill(), { promoted: 0, liveWaiting: 0, share: 0 }, "unset share means the pump does not run at all");
  assert.deepEqual(await Promise.all(ids.map(band)), [-1, -1], "…and leaves every paper in the band it was queued at");
});

test("a bought share is jobs in the band at once, oldest first, and it is not refilled while full", async () => {
  for (const [label, days] of [["oldest", 220], ["older", 210], ["newer", 205], ["newest", 200]] as const) {
    await seed(label, { archive: true, daysAgo: days });
  }
  const already = await inBand();
  const queued = await waitingArchive();

  const first = await advanceArchiveBackfill({ share: already + 2, ceiling: 100_000 });
  assert.equal(first.promoted, 2, "only the room left in the bought band gets filled");
  assert.deepEqual(await Promise.all(queued.slice(0, 2).map(bandOfJob)), [0, 0], "the papers that have waited longest take the slots");
  assert.deepEqual(await Promise.all(queued.slice(2).map(bandOfJob)), queued.slice(2).map(() => -1), "…and nothing behind them moves");
  assert.equal(await inBand(), already + 2);

  const again = await advanceArchiveBackfill({ share: already + 2, ceiling: 100_000 });
  assert.equal(again.promoted, 0, "no refill while the bought band is still full — the backfill cannot run ahead of the door");
});

test("a news burst takes the capacity straight back, and only the record is promoted", async () => {
  const paper = await seed("stand-aside", { archive: true, daysAgo: 180 });
  const late = await seed("late-news", { archive: false, daysAgo: 10 });
  const live = await seed("live-news", { archive: false, daysAgo: 0 });
  assert.deepEqual([await band(late), await band(live)], [-2, 0], "queued as they always were: late news behind, live work in front");

  // Every live arrival in the shared test database counts, so a ceiling of zero cannot be undercut.
  const out = await advanceArchiveBackfill({ share: 5, ceiling: 0 });
  assert.equal(out.promoted, 0, "the pump stands aside while the live band's own backlog is over the ceiling");
  assert.equal(out.liveWaiting > 0, true);
  assert.deepEqual([await band(paper), await band(late), await band(live)], [-1, -2, 0], "…and touches no band, not even the record's");
});
