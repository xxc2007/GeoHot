// 中文稿门槛与发布闸门，按出口逐条验。两道门各只有一个写法（items.ts 的 `chineseCopyCondition` 与
// `releasedCondition`，行级读规则是 rules.ts 的 `itemHasPage`/`isReleased`），这条测试钉住它们在每个出口上的
// 效果：首页时间线、精选 RSS、主题页与主题计数、v1 精选/全部、条目自己的页面、分享卡、收藏可用性、事件页的
// 收录承诺与 sitemap.xml。
// 两个真实的坑：`listedCondition` 带门槛而并列的 `selectedCondition` 不带，于是 /all 藏住的英文卡片照样上首页；
// 发布闸门只管列表不管单条读，于是 embargo 里的条目页面 200、已经可索引、og 卡照发、sitemap 照列。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { isIndexable } from "@aihot/backend/publication/rules";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { loadItemShare } from "@aihot/backend/publication/og";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { sitemapXml } from "@aihot/backend/publication/sitemap";
import { loadStoryDetail } from "@aihot/backend/publication/stories";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadTopicPage, topicPageCounts } from "@aihot/backend/publication/topics";
import { v1Items } from "@aihot/backend/publication/v1";
import { loadPool } from "@aihot/backend/publication/pool";
import { beijingDate } from "@aihot/contracts/time";
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
  if (made.length) {
    await sql`DELETE FROM fact_articles WHERE fact_id IN (SELECT id FROM facts WHERE story_id IN ${sql(made)})`;
    await sql`DELETE FROM facts WHERE story_id IN ${sql(made)}`;
    await sql`DELETE FROM stories WHERE id IN ${sql(made)}`;
  }
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
/**
 * The home-timeline reads are scoped to the fixture's own tag. The shared test database keeps other files'
 * selected rows — some anchored in the future on purpose (the translate fixtures are discovered "later"
 * because `translatePending` picks newest first) — and an unscoped page of 40 is then a statement about
 * pool composition, not about the gate under test. 2026-10-03: after a day of runs this item fell off page
 * one. The Chinese-copy gate, which is what these assertions are about, is untouched by a tag filter.
 */
const mine = { ...filters, tag: TAG };

/** Test 2 reads the released item's sitemap entry as its control, so the two share these ids. */
let chinese = "";
/** The same edition's item without Chinese copy — the last test checks it against the group expansion. */
let english = "";
/** The events the last test builds, so its teardown can take them out (rows of this run, keyed by `T`). */
const made: number[] = [];

test("an item no one has written up in Chinese is on no list, and keeps its own page", async () => {
  chinese = await selected(`赣江上游出现洪水，沿岸水文站发布预警 ${T}`);
  english = await selected(`Gan river flood warning issued for four hydrological stations ${T}`);
  const now = new Date();

  // The front page: the item with Chinese copy is a card, the one without is not, and the absence is not
  // because the page is empty.
  const timeline = await loadTimeline({ ...mine, limit: 40, now });
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

  // 收录承诺问的是同一件事：列表里不出现的页面，不该在 sitemap 里向爬虫作承诺（2026-10-05 生产库里
  // 有 11 条精选英文标题条目是这种状态，其中 `science-L5` 真在发出的 sitemap 里）。
  assert.equal((await sql<{ indexable: boolean }[]>`SELECT indexable FROM publications WHERE article_id = ${english}`)[0].indexable, false, "英文标题的精选条目存下来就是不可索引");
  assert.equal((await sql<{ indexable: boolean }[]>`SELECT indexable FROM publications WHERE article_id = ${chinese}`)[0].indexable, true, "有中文稿的那条照旧");

  // And with the Chinese written, it lists itself: the same row, no other change.
  await sql`UPDATE analyses SET title_zh = ${`赣江上游洪水与沿岸预警 ${T}`} WHERE article_id = ${english}`;
  await sql`UPDATE publications SET title = ${`赣江上游洪水与沿岸预警 ${T}`} WHERE article_id = ${english}`;
  const relisted = await loadTimeline({ ...mine, limit: 40, now: new Date() });
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
  assert.ok(!(await loadTimeline({ ...mine, limit: 40, now })).cards.some((c) => c.item.id === held), "not on the front page");
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
  assert.ok((await loadTimeline({ ...mine, limit: 40, now: at })).cards.some((c) => c.item.id === held), "and the front page");
  assert.ok((await itemFeed("selected", null, at)).includes(held), "and the feed");
});

test("收录承诺：自动那一支跟着中文稿门槛走，手工那一支听人的", () => {  // 纯函数，不用库：这条规则只有一个写法（`publication/rules.ts`），出口是 `publish.ts` 存下的
  // `publications.indexable`，上一条测试钉的是它在真实行上的效果。
  const base = { visibility: "public", hasSummary: true, seoExcludedAt: null, seoIndexedAt: null as Date | null };
  assert.equal(isIndexable({ ...base, title: "赣江上游出现洪水", selected: true }), true, "有中文稿的精选条目自动可索引");
  assert.equal(isIndexable({ ...base, title: "Anthropogenic warming is projected to divert", selected: true }), false, "列表里不出现的页面不向爬虫作承诺");
  assert.equal(isIndexable({ ...base, title: "Anthropogenic warming is projected", selected: false, seoIndexedAt: new Date() }), true, "编辑手工标了就要被索引：标记本身是人的判断");
  assert.equal(isIndexable({ ...base, title: "赣江上游出现洪水", selected: true, seoExcludedAt: new Date() }), false, "手工排除照样有效");
  assert.equal(isIndexable({ ...base, title: null, hasSummary: false, selected: true }), false, "没有摘要也没有标题：不发");
});

test("存量把机器标签当标题的条目，页面上退回原文；没有标签的主题不给整池", async () => {
  const id = await selected(`赣江 patrol ${T}`);
  // 10-03 之前写下的形状：标题与摘要都只剩模型的标签。写入侧现在拒收这种稿子，这一条钉的是读取层
  // 遇到存量时怎么办——页面自己说「以下标题与提要是原文」，那就真的给原文，而不是给一句 `title_zh:`。
  await sql`UPDATE publications SET title = ${"title_zh:"}, summary = ${"summary_zh:"}, original_title = ${`Gan river patrol ${T}`} WHERE article_id = ${id}`;
  const found = await loadItemDetail(id, new Date());
  assert.equal(found.kind, "found", "条目页照样打得开");
  if (found.kind === "found") {
    assert.equal(found.detail.title, `Gan river patrol ${T}`, "标题位是来源自己的原标题");
    assert.equal(found.detail.summary, null, "只剩标签的摘要不是摘要");
  }

  const now = new Date();
  const plain = await loadPool({ channel: "all", category: null, tag: null, topic: null, page: 1, now });
  assert.ok(plain.total > 0, "这个文件确实有可看的条目，否则下面的零是个空测试");
  const tagless = await loadPool({ channel: "all", category: null, tag: null, topic: null, topicTags: [], page: 1, now });
  assert.equal(tagless.total, 0, "问了主题但主题没有标签 = 零条（主题页自己一直回答零条）");
  assert.ok((await loadPool({ channel: "all", category: null, tag: null, topic: null, topicTags: [TAG], page: 1, now })).total > 0, "有标签时照旧筛得出来");
});

/**
 * The event page: the other half of the same rule. An event whose own title has no Chinese keeps its page —
 * the reports under it are the record of who said what — but it makes no promise to a crawler, which is how
 * the item pages already split "打得开" from "可索引" (`itemHasPage` vs `indexable`). 474 of the 4023
 * openable events on the production site were in that state on 2026-10-05, and only 2 had a Chinese report
 * title to borrow, so this is the shape the page has to be honest about rather than hide.
 */
test("事件页：没有中文标题的事件照样打开，但不对爬虫作承诺", async () => {
  const story = async (title: string) => {
    const publicId = randomUUID();
    const [s] = await sql<{ id: number }[]>`
      INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
    made.push(Number(s!.id));
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO facts (public_id, story_id, title) VALUES (${`cg-${T}-${n++}`}, ${s!.id}, ${title}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.id}, ${chinese}, 'primary')`;
    return { id: Number(s!.id), publicId };
  };
  const written = await story(`赣江上游出现洪水，沿岸水文站发布预警 ${T}`);
  const untranslated = await story(`Gan river flood warning issued for four stations ${T}`);

  assert.equal((await loadStoryDetail(written.id))?.indexable, true, "有中文标题的事件页可以被收录");
  const detail = await loadStoryDetail(untranslated.id);
  assert.ok(detail, "没有中文标题的事件页照样打得开（报道本身就是记录）");
  assert.equal(detail!.indexable, false, "但它不对爬虫作承诺：标题还是原文");
  assert.match(detail!.title, /^Gan river/, "页面带着它自己的原文标题打开，而不是被改名或清空");
  assert.ok(detail!.timeline.some((r) => r.id === chinese), "时间线里那条中文报道照旧列着");

  const res = await app.inject({ method: "GET", url: `/api/site/stories/${untranslated.publicId}` });
  assert.equal(res.statusCode, 200, "the route stays open");
  assert.equal(res.json().indexable, false, "and says so, which is what the page's robots tag reads");

  // The same row answers "can a reader open it?" two ways: this page listed reports with
  // `visibility = 'public'` while `rules.itemHasPage` (and the paper's citations) accept anything not
  // withdrawn — so a report the admin set to `summary-only` was readable on its own page, citable by the
  // daily, and missing from this timeline, with 报道数 and 来源数 reading low and the 综述 unable to cite it.
  await sql`INSERT INTO fact_articles (fact_id, article_id, role)
            SELECT id, ${english}, 'report' FROM facts WHERE story_id = ${untranslated.id}`;
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${english}`;
  const withSummaryOnly = await loadStoryDetail(untranslated.id);
  assert.equal(withSummaryOnly?.reportCount, 2, "summary-only 的报道仍在这个事件的页面与报道数里");
  assert.ok(withSummaryOnly?.timeline.some((r) => r.id === english), "时间线也列它");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${english}`;
  const afterWithdrawal = await loadStoryDetail(untranslated.id);
  assert.equal(afterWithdrawal?.reportCount, 1, "撤回的那条仍然消失——这道门只管 withdrawn，不是只管 public");
});

/**
 * 「另有 N 家信源报道」的展开列表 — the outlet the 2026-10-04 review found uncovered by any test. It reads
 * `groups.ts`, which carries the gate; the number on the card reads `timeline.ts`'s `groupPool`, which
 * gained the same one on 2026-10-05 so the two cannot disagree (a card that promises three and opens two is
 * the same defect wearing a different hat).
 */
test("「另有 N 家」点开的那个列表也不发没有中文稿的成员", async () => {
  // A fresh item without Chinese copy: `english` above is the second test's control and gets its Chinese
  // title later in this file, so reading it here would test nothing.
  const noChinese = await selected(`Gan river tributary mapping released by the survey office ${T}`);
  const factPublicId = `cg-grp-${T}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${factPublicId}, NULL, ${`两组读数 ${T}`}) RETURNING id`;
  for (const article of [chinese, noChinese]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  }
  const body = await loadGroupReports({ factPublicId, channel: "all", category: null, tag: null, topicTags: null, cursor: null, take: 10, revision: null });
  assert.equal(body.kind, "ok", "这一组有可读的成员，列表不是空");
  const shown = (body.kind === "ok" ? body.body.reports : []).map((r) => r.id);
  assert.deepEqual(shown, [chinese], `没有中文稿的那篇不该出现在读者展开的列表里（两组读数 = ${shown.join(", ")}）`);
  await sql`DELETE FROM fact_articles WHERE fact_id = ${fact!.id}`;
  await sql`DELETE FROM facts WHERE id = ${fact!.id}`;
});

/**
 * 详情页那句「另有 N 家信源报道」的 N 与它点开的列表（`detail.ts` 的分组计数 → `groups.ts` 的展开）
 * 必须是同一批报道。两边现在写的是同一道中文门槛（`chineseCopyCondition`）。
 *
 * **说清楚这条测试钉住了什么、没钉住什么**：它钉的是不变式"数字 = 点开的条数"。本轮反复试过让
 * 那条英文报道 public + eligible + 过了释放时间 + 已归组，把 `detail.ts` 改回旧写法后数字仍然是 1，
 * 也就是说我没能造出一行使旧写法真的多算一条——所以 `detail.ts` 那一处是**口径对齐**，
 * 不是一次已证实的错账修复（生产库里有 936 条 public 但 non-eligible 的行，要判它到底能不能显现，
 * 得到那份数据上比；记在 `docs/known-issues.md`）。
 */
test("条目详情页的 N 与「另有 N 家」点开的那张列表，是同一批报道", async () => {
  const noChinese = await selected(`Yangtze delta sediment monitoring network expands ${T}`);
  const factPublicId = `cg-detail-${T}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${factPublicId}, NULL, ${`三角洲两组读数 ${T}`}) RETURNING id`;
  for (const article of [chinese, noChinese]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  }
  // 详情页读的是 publications.fact_id，入组之后重投影一次才是读者看到的状态（归组作业做的正是这步）。
  await publishArticle(chinese);
  await publishArticle(noChinese);
  // 让它真的过了释放闸门，同时把可见性/精选状态保持成投影算出来的样子。
  await sql`UPDATE publications SET visible_after = now() - interval '1 hour' WHERE article_id = ${noChinese}`;
  const body = await loadGroupReports({ factPublicId, channel: "all", category: null, tag: TAG, topicTags: null, cursor: null, take: 10, revision: null });
  // 前提钉住：那条英文报道确实是 public + eligible + 已过释放时间，唯一挡住它的理由只能是中文门槛。
  const [extra] = await sql<{ visibility: string; eligible: boolean; fact_id: number | null; visible_after: Date }[]>`
    SELECT visibility, eligible, fact_id, visible_after FROM publications WHERE article_id = ${noChinese}`;
  assert.equal(extra!.visibility, "public", "没有中文稿的那条在库里是 public");
  assert.equal(extra!.eligible, true, "而且 eligible");
  assert.ok(extra!.fact_id !== null, "而且已经归到某个事实下（计数就是按事实数成员的）");
  assert.ok(extra!.visible_after.getTime() < Date.now(), "而且过了释放时间");
  const shown = body.kind === "ok" ? body.body.reports.map((r) => r.id) : [];
  const found = await loadItemDetail(chinese, new Date());
  if (found.kind !== "found") throw new Error("详情页读不到这条已发布的条目");
  assert.ok(found.detail.group, "这个事实有成员，页面会印出那句「另有 N 家」");
  assert.deepEqual(shown, [chinese], "点开看到的列表里没有那条英文报道");
  assert.equal(found.detail.group.reportCount, shown.length, `数字 ${found.detail.group.reportCount} 必须等于点开看到的 ${shown.length} 条`);
  await sql`DELETE FROM fact_articles WHERE fact_id = ${fact!.id}`;
  await sql`DELETE FROM facts WHERE id = ${fact!.id}`;
});

/**
 * /all 表头的「今日 N 条」与它下面真的排成「今天」那一组，必须是同一批条目。
 * 原来两头各一套条件：计数排除了 `backfill`（补录条目按发现时间确实排在今天）、又没有排除
 * `published_at IS NULL`（读侧把那些挪进「无发布日期」）。一少一多正好抵消，所以本机一直没被发现——
 * 这里同时放两条补录与一条无发布时间，让两个方向都能各自暴露。
 */
test("「今日 N 条」那个数字，等于今天这一组真的排出来的条数", async () => {
  const now = new Date();
  const plain = await selected(`柴达木盆地季节性盐湖面积继续缩小 ${T}`);
  const first = await selected(`历史地震目录补录完成，新增目录两千条 ${T}`);
  const second = await selected(`上世纪水文站年鉴数字化入库 ${T}`);
  const noDate = await selected(`南海岛礁验潮站恢复连续观测 ${T}`);
  for (const id of [first, second]) await sql`UPDATE publications SET backfill = true WHERE article_id = ${id}`;
  await sql`UPDATE publications SET published_at = NULL WHERE article_id = ${noDate}`;

  const pool = await loadPool({ channel: "all", category: null, tag: TAG, topicTags: null, q: null, page: 1, now });
  // 读侧的分日规则（`DayList.tsx`）：按 timelineAt 分日，没有 publishedAt 的行另放一组。
  const today = beijingDate(now);
  const inToday = pool.items.filter((i) => i.publishedAt && beijingDate(i.timelineAt) === today).map((i) => i.id);
  assert.ok(inToday.includes(plain), "正常条目在今天的组里");
  assert.ok(inToday.includes(first) && inToday.includes(second), "按发现时间补录的条目也在今天的组里——所以它必须被计入");
  assert.ok(!inToday.includes(noDate), "没有发布时间的另成一组，不算今天");
  assert.equal(pool.todayCount, inToday.length, `表头的 ${pool.todayCount} 条 = 这一组实际排出的 ${inToday.length} 条`);
});
