// 中文稿门槛与发布闸门，按出口逐条验。两道门各只有一个写法（items.ts 的 `chineseCopyCondition` 与
// `releasedCondition`，行级读规则是 rules.ts 的 `itemHasPage`/`isReleased`），这条测试钉住它们在每个出口上的
// 效果：首页时间线、精选 RSS、主题页与主题计数、v1 精选/全部、条目自己的页面、分享卡、收藏可用性与 sitemap.xml。
// 两个真实的坑：`listedCondition` 带门槛而并列的 `selectedCondition` 不带，于是 /all 藏住的英文卡片照样上首页；
// 发布闸门只管列表不管单条读，于是 embargo 里的条目页面 200、已经可索引、og 卡照发、sitemap 照列。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { loadItemShare } from "@aihot/backend/publication/og";
import { sitemapXml } from "@aihot/backend/publication/sitemap";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadTopicPage, topicPageCounts } from "@aihot/backend/publication/topics";
import { v1Items } from "@aihot/backend/publication/v1";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-copy-gate-${T}`;
/** The one tag both items carry, so the topic page and the topic counts have something to match. */
const TAG = `copy-gate-${T}`;
const TOPIC = `copy-gate-${T}`;
const BODY = `BODY-${T} `.repeat(40);
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Copy gate test', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  // The topic goes in before anything is read: the topic directory is held for a minute per process, and
  // writing it after the first read would leave this file unable to see its own topic.
  await sql`INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position)
            VALUES (${TOPIC}, ${`水情测试主题 ${T}`}, 'field', NULL, ${[TAG]}, '一条有中文稿、一条没有。', '{}', 4000)`;
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM topics WHERE slug = ${TOPIC}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/**
 * A selected item with a summary and a reason, released unless `gated` leaves it behind the release gate.
 * `title` is what the reader would see: Chinese copy or none.
 */
async function selected(title: string, opts: { gated?: boolean } = {}): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-${n}`, title, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 'natural', ${[TAG]}, ${title}, ${`内容提要 ${T}-${n}`}, '两家信源同时报道', 90, true)`;
  // No `releasedAt`: the item waits behind the gate like any first release (config's ~180 s).
  await publishArticle(articleId, opts.gated ? {} : { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

const filters = { channel: "all" as const, category: null, tag: null, topic: null };

/** Test 2 reads the released item's sitemap entry as its control, so the two share these ids. */
let chinese = "";

test("an item no one has written up in Chinese is on no list, and keeps its own page", async () => {
  chinese = await selected(`赣江上游出现洪水，沿岸水文站发布预警 ${T}`);
  const english = await selected(`Gan river flood warning issued for four hydrological stations ${T}`);
  const now = new Date();

  // The front page: the item with Chinese copy is a card, the one without is not, and the absence is not
  // because the page is empty.
  const timeline = await loadTimeline({ ...filters, limit: 40, now });
  const cards = timeline.cards.map((c) => c.item.id);
  assert.ok(cards.includes(chinese), "the Chinese item is on the home timeline");
  assert.ok(!cards.includes(english), "an item with no Chinese title is not on the home timeline");

  // The selected RSS (and the 全部动态 feed, which read the other predicate).
  const feed = await itemFeed("selected", null, now);
  assert.ok(feed.includes(chinese) && !feed.includes(english), "the selected feed carries one, not the other");
  const allFeed = await itemFeed("all", null, now);
  assert.ok(!allFeed.includes(english), "the pool feed hides it too — the two predicates are one rule now");

  // A topic page and the counts that decide whether a topic is listed and indexed at all.
  const page = await loadTopicPage(TOPIC, 1, now);
  assert.ok(page, "the topic page exists");
  assert.deepEqual(page!.items.map((i) => i.id), [chinese], "the topic page lists only the item with Chinese copy");
  const counts = (await topicPageCounts(now)).find((c) => c.slug === TOPIC);
  assert.equal(counts?.total, 1, "topic counts cover exactly the items a topic page can list");

  // v1: both modes, and the site's own pool page.
  const query = { window: "7d" as const, by: "timeline" as const, category: null, q: null, limit: 100, cursor: null };
  const sel = await v1Items({ ...query, mode: "selected" }, now);
  const all = await v1Items({ ...query, mode: "all" }, now);
  assert.ok(sel.items.some((i) => i.id === chinese) && !sel.items.some((i) => i.id === english), "v1 mode=selected");
  assert.ok(!all.items.some((i) => i.id === english), "v1 mode=all");

  // What the finding says must NOT change: the item keeps its page and its row, and lists itself again once
  // someone writes the Chinese. docs/known-issues.md: 藏起真内容比少几条更糟.
  assert.equal((await loadItemDetail(english, now)).kind, "found", "its own detail read still answers");
  const res = await app.inject({ method: "GET", url: `/api/site/items/${english}` });
  assert.equal(res.statusCode, 200, "the item page stays open for an item no list shows");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${chinese}` })).statusCode, 200);

  // And with the Chinese written, it lists itself: the same row, no other change.
  await sql`UPDATE analyses SET title_zh = ${`赣江上游洪水与沿岸预警 ${T}`} WHERE article_id = ${english}`;
  await sql`UPDATE publications SET title = ${`赣江上游洪水与沿岸预警 ${T}`} WHERE article_id = ${english}`;
  const relisted = await loadTimeline({ ...filters, limit: 40, now: new Date() });
  assert.ok(relisted.cards.some((c) => c.item.id === english), "the item joins the front page once its Chinese copy exists");
});

test("an item behind the release gate has no page, no share card and no sitemap entry either", async () => {
  const held = await selected(`待发布的中文标题 ${T}`, { gated: true });
  const [row] = await sql<{ visible_after: Date }[]>`SELECT visible_after FROM publications WHERE article_id = ${held}`;
  assert.ok(row!.visible_after.getTime() > Date.now(), "the item really is inside the embargo window");
  const now = new Date();

  // Every list already hid it. The reads must hide it too, or the embargo leaks through the side doors.
  assert.equal((await loadItemDetail(held, now)).kind, "not_found", "the detail read refuses it until its release");
  assert.equal((await loadItemShare(held, now)), null, "no share card title or summary for a hidden item");
  assert.deepEqual(await itemAvailability([held], now), { [held]: "unavailable" }, "收藏 cannot open it either");
  assert.ok(!(await loadTimeline({ ...filters, limit: 40, now })).cards.some((c) => c.item.id === held), "not on the front page");
  assert.ok(!(await itemFeed("selected", null, now)).includes(held), "not in the selected feed");

  for (const url of [`/api/site/items/${held}`, `/items/${held}/markdown`, `/og/items/${held}.png`]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404, `${url} answers while the gate is shut`);
  }
  // The sitemap is held for ~5 minutes per process, so this is the one build this run sees: it must not
  // advertise a URL that answers 404 for its first minutes. Asserted as an invariant over every item loc
  // rather than over one fixture, because whether a test item earns `indexable` depends on its source's
  // full-text permission — and a control that silently never qualifies would prove nothing either way.
  const xml = await sitemapXml();
  const locs = [...xml.matchAll(/<loc>[^<]*\/items\/([A-Za-z0-9]+)<\/loc>/g)].map((m) => m[1]!);
  assert.ok(locs.length > 0, "the build advertised item pages at all");
  const bad = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications WHERE article_id IN ${sql(locs)}
      AND NOT (visibility = 'public' AND indexable AND (NOT selected OR visible_after <= now()))`;
  assert.equal(bad.length, 0, `advertised but not servable: ${bad.map((b) => b.id).join(", ")}`);
  assert.ok(!locs.includes(held), "the embargoed item is not in sitemap.xml");

  // Open the gate on one instant and the same reads answer for the same row.
  const released = new Date(Date.now() - 1_000);
  await sql`UPDATE publications SET visible_after = ${released} WHERE article_id = ${held}`;
  const at = new Date();
  assert.equal((await loadItemDetail(held, at)).kind, "found", "the page opens with the release");
  assert.ok((await loadItemShare(held, at))?.title, "so does its share card");
  assert.equal((await itemAvailability([held], at))[held], "public", "and 收藏 can open it");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${held}` })).statusCode, 200, "the route follows");
  assert.ok((await loadTimeline({ ...filters, limit: 40, now: at })).cards.some((c) => c.item.id === held), "and the front page");
  assert.ok((await itemFeed("selected", null, at)).includes(held), "and the feed");
});
