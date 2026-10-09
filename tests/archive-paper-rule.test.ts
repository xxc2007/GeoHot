// The archive rule: material ingested from the scholarly record belongs to the issue of the day it was
// published — and to no other issue. Both halves need a gate. Recomposing a January edition is the point of
// the backfill, but 20,000 January papers surfacing in tonight's daily because they were *released* tonight
// would be a silent rewrite of what "today's paper" means.
import { tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { candidates } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `test-archive-paper-${T}`;
// A private six-day window in the past, so a rerun or another writer's leftovers cannot move these edges.
let windowSeed = 0;
for (const ch of T) windowSeed = (windowSeed * 31 + ch.charCodeAt(0)) % 1461;
const DAY0 = Date.UTC(2020, 0, 1 + windowSeed);
const at = (day: number, h = 12) => new Date(DAY0 + day * 86_400_000 + h * 3_600_000);
/** The archive arrives on day 5; its own day is day 0. */
const ARCHIVE_DAY = at(0);
const ARRIVED_DAY = at(5);

interface Seeded {
  articleId: string;
  backfill: boolean;
  reason: string | null;
  timeline: Date;
  visibleAfter: Date;
}

async function seed(label: string, publishedAt: Date | null, discoveredAt: Date, explicit: string | null): Promise<Seeded> {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/archive-paper-${T}-${label}`,
    title: `Archive paper rule ${label}`,
    bodyText: `Abstract text for ${label}. `.repeat(6),
    bodyStatus: "ok",
    publishedAt,
    discoveredAt,
    via: "import",
    backfill: explicit,
  });
  const [row] = await sql<{ backfill_reason: string | null; timeline_at: Date }[]>`
    SELECT backfill_reason, timeline_at FROM articles WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'geotech', ${`标题 ${label}`}, ${`摘要 ${label} 的中文提要。`}, 90, true)`;
  const published = await publishArticle(articleId, { now: ARRIVED_DAY, releasedAt: ARRIVED_DAY });
  assert.equal(published?.selected, true, `${label} should have been selected`);
  const [pub] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${articleId}`;
  return { articleId, backfill, reason: row!.backfill_reason, timeline: row!.timeline_at, visibleAfter: pub!.visible_after };
}

before(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE ${"test-archive-paper-%"}`;
  await sql`DELETE FROM sources WHERE id LIKE ${"test-archive-paper-%"}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Archive paper test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await stopBoss();
  await closeDb();
});

test("archive material is filed under its own day, and never under the day it arrived", async () => {
  const archive = await seed("archive", ARCHIVE_DAY, ARRIVED_DAY, "archive");
  assert.equal(archive.backfill, true);
  assert.equal(archive.reason, "archive");
  assert.equal(archive.timeline.toISOString(), ARCHIVE_DAY.toISOString(), "an archive item keeps its own publication moment");
  assert.equal(archive.visibleAfter.toISOString(), ARRIVED_DAY.toISOString(), "…while being released only now");

  const own = (await candidates(at(0), at(1))).map((c) => c.itemId);
  assert.ok(own.includes(archive.articleId), "the January issue is made of January material");

  const arrival = (await candidates(at(5), at(6))).map((c) => c.itemId);
  assert.ok(!arrival.includes(archive.articleId), "tonight's issue must not fill up with backdated papers");
});

test("ordinary late arrivals keep the attribution they had before the archive existed", async () => {
  // More than 48 h between source time and discovery is `stale-on-discovery`, not an archive import, and it
  // stays out of both windows — that is how today's paper has always behaved, and it must not change.
  const stale = await seed("stale", at(0), at(5), null);
  assert.equal(stale.reason, "stale-on-discovery");
  assert.ok(!(await candidates(at(0), at(1))).some((c) => c.itemId === stale.articleId), "stale material does not join the old issue");
  assert.ok(!(await candidates(at(5), at(6))).some((c) => c.itemId === stale.articleId), "…nor the issue of the day it was found");

  // Live news, found on its own day: unchanged by any of this.
  const live = await seed("live", at(5), at(5), null);
  assert.equal(live.backfill, false);
  assert.ok((await candidates(at(5), at(6))).some((c) => c.itemId === live.articleId), "today's news is still today's paper");
  assert.ok(!(await candidates(at(0), at(1))).some((c) => c.itemId === live.articleId));
});
