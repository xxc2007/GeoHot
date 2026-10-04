// Share cards and how long a CDN may hold them. An article card got a one-hour bound on purpose
// (apps/api/src/routes/og.ts: after a withdrawal or a correction they are gone from any cache within the
// hour). An event card and a report card print the same kind of withdrawable editorial text, and until
// 2026-10-04 they inherited `send()`'s default instead: `s-maxage = 7 × max-age` plus 24 hours of
// serve-stale, i.e. the better part of two days for an event (and eight for a report) after the origin
// already answers 404 — a merged story keeps showing its old heading and "N 个来源 · M 篇报道" to every
// social crawler that asks the edge. Static cards (the site, a terms page, a topic) may keep the week.
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { EDITORIAL_IMAGE_CACHE, STATIC_IMAGE_CACHE } from "../apps/api/src/routes/og.ts";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `og-cache-${T}`;
const DAILY = "2097-01-05";
let itemId = "";
let storyPublicId = "";
const app = await buildApp();

/** The seconds of each directive, so the test says "not longer than" rather than comparing strings. */
function cacheSeconds(header: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of header.split(",")) {
    const m = /^\s*([a-z-]+)=(\d+)\s*$/.exec(part);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
             VALUES (${SOURCE}, 'OG cache test', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}-og-item`, title: `Source ${T} bulletin`,
    bodyText: "A field bulletin.", bodyStatus: "ok", via: "fetch",
  });
  const title = `测试事件${T}：一台站测定 5.2 级`;
  const summary = `测试事件${T} 一台站测定 5.2 级，震源深度 32 千米。`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${title}, ${summary}, 80, false, ${sql.json({ fact: { title } })})`;
  await publishArticle(articleId);
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`测试事件${T}`}, now(), now()) RETURNING id`;
  await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${'fogcache' + T}, ${story!.id}, ${title})`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES ((SELECT id FROM facts WHERE public_id = ${'fogcache' + T}), ${articleId}, 'primary')`;
  itemId = articleId;
  const [row] = await sql<{ public_id: string }[]>`SELECT public_id::text AS public_id FROM stories WHERE id = ${story!.id}`;
  storyPublicId = row!.public_id;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${DAILY}, now() - interval '10 days', now() - interval '9 days',
            ${sql.json({ kind: "daily", title: `地理热点 日报 · ${DAILY}`, overview: `OGCACHE-${T} 一天的动态汇总。`, sections: [], flashes: [] } as never)}, now(), 'manual')`;
});

after(async () => {
  await sql`DELETE FROM reports WHERE key = ${DAILY}`;
  await sql`DELETE FROM fact_articles WHERE article_id = ${itemId}`;
  await sql`DELETE FROM facts WHERE public_id = ${'fogcache' + T}`;
  await sql`DELETE FROM stories WHERE public_id = ${storyPublicId}`;
  await purgeTagged(T);
  await app.close();
  await stopBoss();
  await closeDb();
});

async function cardCacheControl(url: string): Promise<Record<string, number>> {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `${url} must answer a card, not ${res.statusCode}`);
  const header = res.headers["cache-control"];
  assert.equal(typeof header, "string", `${url} must state a Cache-Control`);
  return cacheSeconds(String(header));
}

test("the cards carrying editorial text are bounded by the article card's hour", async () => {
  const article = await cardCacheControl(`/og/items/${itemId}.png`);
  const story = await cardCacheControl(`/og/stories/${storyPublicId}.png`);
  const report = await cardCacheControl(`/og/reports/daily/${DAILY}.png`);
  for (const [name, card] of [["事件卡", story], ["日报卡", report]] as const) {
    assert.equal(card["s-maxage"] ?? 0, article["s-maxage"], `${name} 的共享缓存上限必须与文章卡一致`);
    assert.ok((card["max-age"] ?? 0) <= 3600, `${name} 的源站缓存不该超过一小时`);
    assert.ok((card["s-maxage"] ?? 0) <= 3600, `${name} 在 CDN 上不该滞留超过一小时（撤回后读者还在社交平台上看到旧事件）`);
    assert.ok((card["stale-while-revalidate"] ?? 0) <= 600, `${name} 的过期仍可返回窗口不该超过十分钟`);
  }
  // The bound is one constant, not three numbers written by hand.
  assert.equal(story["s-maxage"], cacheSeconds(EDITORIAL_IMAGE_CACHE)["s-maxage"]);
});

test("the site's own cards keep the long cache, and no route inherits it by forgetting an argument", async () => {
  const page = await cardCacheControl("/og/pages/terms.png");
  assert.deepEqual(page, cacheSeconds(STATIC_IMAGE_CACHE), "纯站点文案仍然是七天");
  assert.ok((page["s-maxage"] ?? 0) > (await cardCacheControl(`/og/stories/${storyPublicId}.png`))["s-maxage"]!);
  // Every card route passes a policy: `send()` has no default left to fall through to.
  const ogSource = await import("node:fs").then((fs) => fs.readFileSync(new URL("../apps/api/src/routes/og.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(ogSource, /cacheControl\s*=/, "send() 不接受默认策略，新增的路由必须自己选一个");
  assert.equal((await app.inject({ method: "GET", url: "/og/stories/00000000-0000-4000-8000-000000000000.png" })).statusCode, 404);
});
