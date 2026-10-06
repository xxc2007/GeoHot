// A video source (the official channels of USGS / NASA / NOAA on YouTube, added 2026-10-05) has no article
// body: what it lends is a title, the platform's own description, and the still the platform uses for that
// video. This pins the read layer down to the item page's payload — the still arrives, and a text source's
// photographs still do not (the site republishes summaries, not pictures).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const VIDEO = `${T}-video`;
const ids: string[] = [];

async function publishMaterial(sourceId: string, url: string, media: unknown[], title: string) {
  const { articleId } = await upsertMaterial({
    sourceId, url, title, bodyText: null, excerpt: "频道里这条视频的说明文字。", bodyStatus: "pending", media: media as never, via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${`本站标题 ${T}`}, ${`${T} 的提要。`}, 60, true, ${sql.json({ fact: null })})`;
  // releasedAt: an ungrouped new item waits out the release gate; this fixture is "already public".
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  ids.push(articleId);
  return articleId;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
            (${VIDEO}, ${`视频频道源 ${T}`}, 'rss', 'T2', 'editorial', true, '2100-01-01')`;
});

after(async () => {
  await sql`DELETE FROM editorial_overrides WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM publications WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM analyses WHERE article_id = ANY(${ids})`;
  await sql`DELETE FROM articles WHERE id = ANY(${ids})`;
  await sql`DELETE FROM sources WHERE id = ${VIDEO}`;
  await stopBoss();
  await closeDb();
});

test("a video item reaches the page with the platform's own still", async () => {
  const id = await publishMaterial(VIDEO, "https://www.youtube.com/watch?v=pKJDW8oOXuU", [
    { kind: "video", url: "https://www.youtube.com/watch?v=pKJDW8oOXuU", poster: "https://i1.ytimg.com/vi/pKJDW8oOXuU/hqdefault.jpg", width: 480, height: 360 },
    { kind: "image", url: "https://example.org/a-photo.jpg", width: 1200, height: 800 },
  ], "What stinks in Yellowstone?");
  const res = await loadItemDetail(id);
  if (res.kind !== "found") assert.fail("a selected item from a video source has a page");
  const media = res.detail.media!;
  assert.equal(media.length, 1, "only the video's still; the item lends no photographs");
  assert.equal(media[0]!.kind, "video");
  assert.equal(media[0]!.url, "https://www.youtube.com/watch?v=pKJDW8oOXuU", "the tile opens the platform, not a proxied image");
  assert.match(media[0]!.poster!, /img-proxy\?u=https%3A%2F%2Fi1\.ytimg\.com/);
});

test("an item without video media reaches the page with an empty list, not a missing field", async () => {
  const id = await publishMaterial(VIDEO, "https://www.youtube.com/watch?v=RR6gEobXVHA", [], "NASA without a still");
  const res = await loadItemDetail(id);
  if (res.kind !== "found") assert.fail("the second sample also has a page");
  assert.deepEqual(res.detail.media, []);
});
