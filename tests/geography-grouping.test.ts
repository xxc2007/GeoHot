// Geography clustering traps (AUDIT-WAVE2 / wave 4 gap b), tested at the layer code actually controls.
// The rules themselves — 同一次地震的多台网震级修订算一次发生、同一次台风的两省登陆算两次发生、同一断裂带
// 一周内的两次地震不算一件事、地名包含不等于同一地点 — are decisions recorded in industry/prompts/group-method.md
// and group-definitions.md. They are model verdicts: no line of events/group.ts or events/relate.ts knows
// what a magnitude, an epicentre or a county boundary is. So every test here states which half it pins: the
// code-side gate (relation, confidence floors, story roots, the history gate), and where the gate plainly
// does not exist it says so and asserts the gap instead of pretending to test the rule.
import { purgeTagged, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { isHistorical, STALE_ON_DISCOVERY_MS, upsertMaterial } from "@aihot/backend/content/materials";
import { consolidate, groupArticle, linkRelatedStories } from "@aihot/backend/events/group";
import { computeHotRanking } from "@aihot/backend/events/hot";
import {
  BATCH_SYSTEM, firmlyTied, lexicalSimilarity, looksLikeRoundup, reportText, sameOccurrence, signalTarget, storyForDevelopment,
  STORY_REVIEW_MIN_CONFIDENCE, TIE_MIN_CONFIDENCE, verdictsByFact, type CandidateView,
} from "@aihot/backend/events/relate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const PREFIX = `test-geo-${T}`;
const SOURCES = [`${PREFIX}-cenc`, `${PREFIX}-usgs`, `${PREFIX}-emsc`, `${PREFIX}-cma`, `${PREFIX}-noaa`, `${PREFIX}-soa`];

type Rel = "SAME_OCCURRENCE" | "SAME_STORY" | "UNRELATED" | "ROUNDUP";
type Answer = { relation: Rel; confidence: number };
const rules: {
  /** What the batch judge says about a candidate, by that fact's title. */
  batch: (factTitle: string) => Answer;
  /** Answers for the pair prompt, consumed in call order (the judge first, then the reviewer). */
  pair: Answer[];
} = { batch: () => ({ relation: "UNRELATED", confidence: 0.5 }), pair: [] };
const DEFAULT_PAIR: Answer = { relation: "SAME_OCCURRENCE", confidence: 0.95 };

const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages.at(-1)!.content;
  const answer = (content: unknown) => ({ id: `stub-${T}`, model: "stub", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  if (user.includes("【报道 A】")) {
    const next = rules.pair.length ? rules.pair.shift()! : DEFAULT_PAIR;
    return answer({ a: "测定", b: "测定", relation: next.relation, difference: "", confidence: next.confidence });
  }
  const decisions = [...user.matchAll(/【候选 (C\d+)】（[^）]*?事实标题：([^）]*)）/g)]
    .map((m) => ({ id: m[1], ...rules.batch(m[2] ?? "") }));
  return answer({ query: "速报", decisions });
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_MODEL = "deepseek-flash";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

before(async () => {
  for (const id of SOURCES) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${id}, ${id}, 'rss', 'T1', 'editorial', '2100-01-01')`;
  }
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE ${`test-geo-${T}%`}`;
  await sql`DELETE FROM sources WHERE id LIKE ${`test-geo-${T}%`}`;
  await purgeTagged(T);
  await provider.close();
  await stopBoss();
  await closeDb();
});

/** A published report of one earthquake bulletin, from one source. */
async function report(sourceId: string, suffix: string, title: string, summary: string, publishedAt = new Date(), discoveredAt = new Date()) {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${PREFIX}-${suffix}`, title, bodyText: `${title} ${summary}`, bodyStatus: "ok", via: "fetch", publishedAt, discoveredAt,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${title}, ${summary}, 80, false, ${sql.json({ fact: { title, subject: "某机构", action: "测定", object: "震级" } })})`;
  await publishArticle(articleId);
  return articleId;
}

/** A story that begins with one fact holding one report. */
async function storyWithRoot(factTitle: string, suffix: string, sourceId = SOURCES[0]!) {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${factTitle}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${suffix}-${T}`}, ${story!.id}, ${factTitle}) RETURNING id`;
  const article = await report(sourceId, suffix, factTitle, factTitle);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${article}, 'report')`;
  return { storyId: Number(story!.id), factId: Number(fact!.id), articleId: article };
}

const factsOf = async (storyId: number) =>
  (await sql<{ id: string }[]>`SELECT id FROM facts WHERE story_id = ${storyId} ORDER BY id`).map((r) => Number(r.id));
const participants = async (storyId: number) =>
  (await sql<{ participant_key: string }[]>`SELECT DISTINCT participant_key FROM story_signals WHERE story_id = ${storyId}`).map((r) => r.participant_key);

test("多台网震级修订 is one occurrence: three outlets measuring one quake share one fact and give that story three participants (the ≤0.5/≤1°/≤2min/≤30km band is prompt-only)", async () => {
  const quake = `甘孜泸定${T}地震`;
  const seed = await storyWithRoot(`${quake}（中国地震台网速报 7.1 级）`, "geo-seed");
  // The band the wave-4 decision records lives in exactly one place: the prompt the judge is sent.
  assert.match(BATCH_SYSTEM, /震级差 ≤0\.5、震中差 ≤1°、发震时刻差 ≤2 分钟、深度差 ≤30 km/, "the tolerance is a prompt rule");
  const inCode = ["../packages/backend/src/events/group.ts", "../packages/backend/src/events/relate.ts"]
    .map((p) => readFileSync(new URL(p, import.meta.url), "utf8"))
    .join("");
  assert.equal(/震级|震中|深度差|烈度圈/.test(inCode), false, "no line of the grouping code mentions magnitude, epicentre or depth: the numbers cannot be checked here");

  rules.batch = (factTitle) => ({ relation: factTitle.includes(quake) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.95 });
  rules.pair = [];
  const revisions = [
    await report(SOURCES[1]!, "geo-usgs", `${quake}（USGS 修订 Mw 7.2）`, `USGS 把 ${quake} 的震级修订为 Mw 7.2，深度 17 千米。`),
    await report(SOURCES[2]!, "geo-emsc", `${quake}（EMSC 测定 7.0 级）`, `EMSC 测定 ${quake} 为 7.0 级，震中差 0.3 度。`),
    await report(SOURCES[0]!, "geo-cenc-final", `${quake}（中国地震台网正式测定 7.1 级）`, `中国地震台网正式测定 ${quake} 7.1 级，深度 10 千米。`),
  ];
  for (const id of revisions) {
    const res = await groupArticle(id);
    assert.equal(res.verdict, "same-fact", "each revision joins the one occurrence");
    assert.equal(res.factId, seed.factId, "into the same fact, not a sibling one");
  }
  assert.deepEqual(await factsOf(seed.storyId), [seed.factId], "one story, one fact: three bulletins are not three occurrences");
  const keys = await participants(seed.storyId);
  assert.equal(new Set(keys).size, 3, `three distinct outlets vote once each: ${keys.join(", ")}`);
  const [stories] = await sql<{ n: string }[]>`SELECT count(DISTINCT story_id) AS n FROM story_signals WHERE article_id = ANY(${revisions}::text[])`;
  assert.equal(Number(stories!.n), 1, "and all of them are heat for the same story");
});

test("the fact merge is not confidence-gated: a 0.51 SAME_OCCURRENCE joins the fact anyway; only cross-story consolidation checks the number (gap, exposed not fixed)", async () => {
  const quake = `雅安宝兴${T}地震`;
  const seed = await storyWithRoot(`${quake}（速报）`, "geo-lowconf-seed");
  rules.batch = (factTitle) => ({ relation: factTitle.includes(quake) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.51 });
  rules.pair = [];
  const weak = await report(SOURCES[1]!, "geo-lowconf", `${quake}（修订测定）`, `${quake} 的修订测定给出新的深度。`);
  const res = await groupArticle(weak);
  assert.equal(res.verdict, "same-fact", "the batch judge's confidence is never consulted before joining a fact");
  assert.equal(res.factId, seed.factId);
  assert.equal(firmlyTied("SAME_OCCURRENCE", 0.51), false, "the same answer does not count as evidence for anything else");
  assert.equal(res.consolidated, undefined, "so no second story is pulled in on the strength of it");
  // The floor is only real where firmlyTied is used: the review gate below.
  assert.equal(firmlyTied("SAME_OCCURRENCE", TIE_MIN_CONFIDENCE), true, `${TIE_MIN_CONFIDENCE} is the bar`);
  assert.equal(firmlyTied("SAME_OCCURRENCE", TIE_MIN_CONFIDENCE - 0.01), false);
  assert.equal(firmlyTied("UNRELATED", 0.99), false, "a relation outside SAME_OCCURRENCE/SAME_STORY never ties, whatever its confidence");
});

test("two stories fuse only when both judges agree, and the reviewer's bar is the lower one: 0.8 for the judge, STORY_REVIEW_MIN_CONFIDENCE for the review", async () => {
  const quake = `阿尔泰${T}地震`;
  const older = await storyWithRoot(`${quake}（一号测定）`, "geo-merge-old", SOURCES[0]!);
  const newer = await storyWithRoot(`${quake}（二号测定）`, "geo-merge-new", SOURCES[1]!);
  const judgePass = TIE_MIN_CONFIDENCE + 0.1;
  // Just above the review bar: the merge stands, even though that answer could not tie anything alone.
  const overBar = STORY_REVIEW_MIN_CONFIDENCE + 0.01;
  assert.ok(overBar < TIE_MIN_CONFIDENCE, `the review bar ${STORY_REVIEW_MIN_CONFIDENCE} must sit under the tie bar ${TIE_MIN_CONFIDENCE} for this case to mean anything`);
  rules.pair = [{ relation: "SAME_OCCURRENCE", confidence: judgePass }, { relation: "SAME_OCCURRENCE", confidence: overBar }];
  const merged = await consolidate([older.storyId, newer.storyId]);
  assert.deepEqual(merged.map((c) => [c.merge, c.second]), [[true, "SAME_OCCURRENCE"]]);
  const [row] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${newer.storyId}`;
  assert.equal(Number(row!.merged_into), older.storyId, "the later story is the one that goes");
});

test("a reviewer one point under its bar stops the merge, and so does the judge under the tie bar (two stories a week apart on one fault stay apart)", async () => {
  const fault = `龙门山断裂带${T}`;
  const first = await storyWithRoot(`${fault} 3.2 级地震`, "geo-fault-a", SOURCES[0]!);
  const second = await storyWithRoot(`${fault} 4.1 级地震`, "geo-fault-b", SOURCES[2]!);
  // The judge passes, the reviewer hesitates just under its own bar.
  rules.pair = [{ relation: "SAME_STORY", confidence: TIE_MIN_CONFIDENCE + 0.1 }, { relation: "SAME_STORY", confidence: STORY_REVIEW_MIN_CONFIDENCE - 0.01 }];
  const refused = await consolidate([first.storyId, second.storyId]);
  assert.deepEqual(refused.map((c) => [c.merge, c.second]), [[false, "SAME_STORY"]], "one step under the review bar and the fuse does not happen");
  const rows = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id IN (${first.storyId}, ${second.storyId})`;
  assert.deepEqual(rows.map((r) => r.merged_into), [null, null], "both quakes keep their own story");

  // Two quakes on the same fault inside a week: the model calls them different happenings, and nothing in
  // the code can second-guess it either way — recall is lexical, so the near-identical titles are each
  // other's best candidate, and a wrong "same occurrence" would have merged them.
  rules.pair = [{ relation: "UNRELATED", confidence: 0.3 }, { relation: "UNRELATED", confidence: 0.3 }];
  const apart = await consolidate([first.storyId, second.storyId]);
  assert.equal(apart[0]!.merge, false, "the first judge stops it before the reviewer is even paid");
  const similarity = lexicalSimilarity(reportText(`${fault} 3.2 级地震`, `${fault} 3.2 级地震`), reportText(`${fault} 4.1 级地震`, `${fault} 4.1 级地震`));
  assert.ok(similarity >= 0.8, `the two events are ${similarity.toFixed(2)} alike to the lexical recall: it cannot tell them apart at all`);
  await linkRelatedStories();
  const links = await sql`SELECT 1 FROM story_links WHERE story_id IN (${first.storyId}, ${second.storyId})`;
  assert.equal(links.length, 0, "and an UNRELATED verdict leaves no related-event link either");
});

test("地名包含不是同一地点：once the model says SAME_OCCURRENCE, code merges 芦山县 and 天全县 without a single geography check (gap, exposed not fixed)", async () => {
  const region = `雅安${T}`;
  const lushan = await storyWithRoot(`${region}芦山县发生 5.8 级地震`, "geo-county-a", SOURCES[0]!);
  const tianquan = await storyWithRoot(`${region}天全县发生 5.8 级地震`, "geo-county-b", SOURCES[1]!);
  // The containment trap in the numbers the code actually works with. Neighbouring counties read as the
  // same event to the lexical recall (0.81); a name inside another name reads as similar too (0.70, 0.86);
  // and the bare pair 石家庄/庄里 reads as 0. The metric can neither confirm nor deny place identity.
  const similar = (a: string, b: string) => lexicalSimilarity(reportText(`${a}测定`, `${a}测定 5.8 级，深度 10 千米`), reportText(`${b}测定`, `${b}测定 5.8 级，深度 10 千米`));
  assert.ok(similar(`${region}芦山县`, `${region}天全县`) >= 0.6, "the two counties are each other's recall candidate (and close to the line where the code skips the second opinion)");
  assert.ok(similar("石家庄庄里镇", "石家庄市区") >= 0.6, "the 庄里 containment is recalled against 石家庄");
  assert.ok(similar("重庆沙坪坝区坪坝街道", "重庆沙坪坝区") >= 0.8, "沙坪坝/坪坝 reads even more alike than two genuinely different events");
  assert.equal(lexicalSimilarity("石家庄", "庄里"), 0, "short names share no bigram: containment is invisible to the metric, and near-identity is not");
  assert.equal(/坐标|adcode|行政区划|经度|纬度/.test(readFileSync(new URL("../packages/backend/src/events/group.ts", import.meta.url), "utf8")), false, "the write path never looks at a coordinate or an administrative code");

  // Nothing between the verdict and the write can overrule it: a confident "same occurrence" fuses them.
  rules.batch = (factTitle) => ({ relation: factTitle.includes(region) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.95 });
  rules.pair = [{ relation: "SAME_OCCURRENCE", confidence: 0.95 }, { relation: "SAME_OCCURRENCE", confidence: 0.95 }];
  const bridge = await report(SOURCES[2]!, "geo-bridge-county", `${region}交界地震（县名待核）`, `${region}芦山县与天全县交界发生 5.8 级地震。`);
  const res = await groupArticle(bridge);
  assert.equal(res.verdict, "same-fact", "the bridge report is gathered onto one county's event…");
  assert.deepEqual((res.consolidated ?? []).map((c) => c.merge), [true], "…and the other county's story is fused into it");
  const [row] = await sql<{ merged_into: number | null }[]>`SELECT merged_into FROM stories WHERE id = ${tianquan.storyId}`;
  assert.equal(Number(row!.merged_into), lushan.storyId, "two different epicentres are now one story: the verdict is all the code gets");
});

test("同一次台风的两次登陆 are two occurrences of one story, while reports of one landfall gather on it", async () => {
  const storm = `台风${T}号`;
  const firstLandfall = await storyWithRoot(`${storm}在浙江温岭登陆`, "geo-typhoon-a", SOURCES[0]!);
  // The second landfall is a development of the same typhoon: a new fact, inside the same story.
  rules.batch = (factTitle) => ({ relation: factTitle.includes("温岭") ? "SAME_STORY" : "UNRELATED", confidence: 0.9 });
  rules.pair = [];
  const second = await report(SOURCES[3]!, "geo-typhoon-b", `${storm}在上海奉贤登陆`, `${storm} 离开浙江后在上海奉贤二次登陆。`);
  const secondRes = await groupArticle(second);
  assert.equal(secondRes.verdict, "new-fact-in-story", "the second landfall is a development, not the same occurrence");
  assert.equal(secondRes.storyId, firstLandfall.storyId, "and it stays in the same story");
  assert.equal(secondRes.factId === firstLandfall.factId, false, "as its own occurrence: two landfalls are two facts");
  const afterTwo = await factsOf(firstLandfall.storyId);
  const secondFact = secondRes.factId!;
  assert.deepEqual(afterTwo, [firstLandfall.factId, secondFact].sort((a, b) => a - b), "one story, two occurrences");

  // Several outlets reporting the second landfall are reports of that occurrence: they gather on its fact,
  // and the first landfall stays a separate fact in the same story.
  rules.batch = (factTitle) => ({ relation: factTitle.includes("奉贤") ? "SAME_OCCURRENCE" : factTitle.includes("温岭") ? "SAME_STORY" : "UNRELATED", confidence: 0.95 });
  const relay = await report(SOURCES[4]!, "geo-typhoon-c", `${storm}在奉贤登陆的风暴潮通报`, `${storm} 奉贤登陆后的风暴潮与风雨影响。`);
  const relayRes = await groupArticle(relay);
  assert.deepEqual([relayRes.verdict, relayRes.factId], ["same-fact", secondRes.factId], "reports of one landfall gather on that landfall");
  assert.equal(relayRes.storyId, firstLandfall.storyId);
  assert.equal((await factsOf(firstLandfall.storyId)).length, 2, "and the story never collapses the two landfalls into one");
});

test("a development hangs off the story's root occurrence: stories do not grow by chaining", async () => {
  const storm = `台风${T}乙`;
  const root = await storyWithRoot(`${storm}生成并发布蓝色预警`, "geo-chain-root", SOURCES[0]!);
  rules.batch = (factTitle) => ({ relation: factTitle.includes("生成") ? "SAME_STORY" : "UNRELATED", confidence: 0.9 });
  rules.pair = [];
  const dev = await report(SOURCES[1]!, "geo-chain-dev", `${storm}加强为超强台风`, `${storm} 在生成后一天加强为超强台风。`);
  const devRes = await groupArticle(dev);
  assert.deepEqual([devRes.verdict, devRes.storyId], ["new-fact-in-story", root.storyId], "the development joins the story through its root fact");
  const laterFact = (await factsOf(root.storyId)).find((id) => id !== root.factId)!;
  assert.ok(laterFact, "the development became the story's second occurrence");

  // The next report is answered SAME_STORY only against that later, non-root fact. Nothing in the code lets
  // it in: developments attach to the fact that opened the event, never to a development of it.
  rules.batch = (factTitle) => ({ relation: factTitle.includes("加强") ? "SAME_STORY" : "UNRELATED", confidence: 0.95 });
  rules.pair = [{ relation: "UNRELATED", confidence: 0.2 }, { relation: "UNRELATED", confidence: 0.2 }];
  const chained = await report(SOURCES[2]!, "geo-chain-later", `${storm}登陆后的风雨影响`, `${storm} 加强后的风雨影响通报。`);
  const chainRes = await groupArticle(chained);
  assert.equal(chainRes.verdict, "new-story", "a SAME_STORY answer naming a non-root fact gives no entry to the story");
  assert.equal(chainRes.storyId === root.storyId, false, "it starts its own event instead");
  assert.deepEqual(await factsOf(root.storyId), [root.factId, laterFact].sort((a, b) => a - b), "the story it could not join is untouched");
});

test("history founds no event: a magnitude revision that arrives 49 hours late is archived but votes for nothing (48h gate, with its boundary)", async () => {
  rules.batch = () => ({ relation: "UNRELATED", confidence: 0.5 });
  rules.pair = [{ relation: "UNRELATED", confidence: 0.5 }];
  const justLate = new Date(Date.now() - STALE_ON_DISCOVERY_MS - 3_600_000);
  const justInside = new Date(Date.now() - STALE_ON_DISCOVERY_MS + 3_600_000);
  const idLate = await report(SOURCES[0]!, "geo-hist-late", `巧家${T}地震正式测定（迟到的修订）`, `正式测定震级 5.1 级。`, justLate);
  const resLate = await groupArticle(idLate);
  assert.equal(resLate.verdict, "historical", "past the stale window it is history");
  assert.equal(resLate.factId, undefined, "no fact");
  assert.equal(resLate.storyId, undefined, "no story");
  const signals = await sql`SELECT 1 FROM story_signals WHERE article_id = ${idLate}`;
  assert.equal(signals.length, 0, "and no heat vote");
  const memberships = await sql`SELECT 1 FROM fact_articles WHERE article_id = ${idLate}`;
  assert.equal(memberships.length, 0);
  const published = await sql`SELECT 1 FROM publications WHERE article_id = ${idLate}`;
  assert.equal(published.length, 1, "it is still published as material, only never as an event");

  // The boundary the other way, decided by the same constant: a revision inside the window is a live event.
  const idFresh = await report(SOURCES[1]!, "geo-hist-fresh", `巧家${T}地震速报（窗口内）`, `速报震级 5.0 级。`, justInside);
  const resFresh = await groupArticle(idFresh);
  assert.notEqual(resFresh.verdict, "historical", "inside the window it is news and founds an event");
  assert.equal(resFresh.factId !== undefined, true);
  const freshSignals = await sql`SELECT 1 FROM story_signals WHERE article_id = ${idFresh}`;
  assert.equal(freshSignals.length, 1, "and it votes");

  // The rule itself, at one hour either side of the constant.
  const now = new Date();
  assert.equal(isHistorical({ backfill: true, published_at: new Date(now.getTime() - STALE_ON_DISCOVERY_MS - 3_600_000), discovered_at: now }), true, "backfill plus a stale source time is history");
  assert.equal(isHistorical({ backfill: true, published_at: new Date(now.getTime() - STALE_ON_DISCOVERY_MS + 3_600_000), discovered_at: now }), false, "a late arrival inside the window is still news");
  assert.equal(isHistorical({ backfill: true, published_at: null, discovered_at: now }), true, "a backfill with no source time at all is history");
  assert.equal(isHistorical({ backfill: false, published_at: new Date(now.getTime() - 30 * 86400_000), discovered_at: now }), false, "and only a flagged backfill can be history");
});

test("the pure gates the grouping code runs on, stated once so the integration cases above rest on them", () => {
  // The numbers every case above turns on, stated as literals so moving one has to be a decision made in
  // `events/relate.ts` / `content/materials.ts` with its evidence, not a silent edit that tests follow.
  assert.equal(TIE_MIN_CONFIDENCE, 0.8, "the tie bar a report needs before it counts as evidence that two stories are one");
  assert.equal(STORY_REVIEW_MIN_CONFIDENCE, 0.75, "the review bar sits 0.05 under the tie bar (relate.ts cites the 370-pair reference run for 0.75)");
  assert.equal(STALE_ON_DISCOVERY_MS, 48 * 3600_000, "history is 48 hours after the source time, the same window heat reads");
  const cand = (factId: number, storyRoot: boolean, score = 0.7): CandidateView => ({
    factId, storyId: 100 + factId, factTitle: `事实 ${factId}`, members: 1, storyRoot, score,
    report: { title: `报道 ${factId}`, source: "s", firstParty: false, at: new Date(), summary: null },
  });
  const cands = [cand(1, true), cand(2, false), cand(3, true)];
  const decided = verdictsByFact([
    { id: "C2", relation: "SAME_STORY", confidence: 0.9 },
    { id: "C3", relation: "SAME_OCCURRENCE", confidence: 0.82 },
    { id: "C9", relation: "SAME_OCCURRENCE", confidence: 1 },
  ], cands);
  assert.equal(decided.get(1)!.relation, "UNRELATED", "a candidate the model skipped counts as unrelated with zero confidence");
  assert.equal(decided.get(9) === undefined, true, "and an id that is not a candidate is ignored, not invented");
  assert.deepEqual(sameOccurrence(cands, decided).map((c) => c.factId), [3], "only SAME_OCCURRENCE answers can gather reports on one fact");
  assert.equal(storyForDevelopment(cands, decided)?.factId, undefined, "SAME_STORY against a non-root fact develops nothing: no chaining through a later occurrence");
  const onRoot = verdictsByFact([{ id: "C1", relation: "SAME_STORY", confidence: 0.9 }], cands);
  assert.equal(storyForDevelopment(cands, onRoot)!.factId, 1, "the same answer against the root does attach");
  assert.equal(looksLikeRoundup(cands, verdictsByFact([{ id: "C1", relation: "ROUNDUP", confidence: 0.9 }, { id: "C2", relation: "ROUNDUP", confidence: 0.9 }, { id: "C3", relation: "ROUNDUP", confidence: 0.9 }], cands)), true, "a digest of everything is a digest only when every candidate says so");
  assert.equal(looksLikeRoundup(cands, decided), false, "one differing answer and it is treated as a report");
  assert.equal(looksLikeRoundup([], decided), false, "no candidates is not a digest");
  // A discussion post reacts to a story only above its own reaction bar.
  const reacted = verdictsByFact([{ id: "C1", relation: "SAME_STORY", confidence: TIE_MIN_CONFIDENCE }], cands);
  assert.equal(signalTarget(cands, reacted)?.factId, 1);
  const unsure = verdictsByFact([{ id: "C1", relation: "SAME_STORY", confidence: TIE_MIN_CONFIDENCE - 0.01 }], cands);
  assert.equal(signalTarget(cands, unsure), null, "one point under the bar and the post attaches to nothing");
  assert.equal(signalTarget(cands, verdictsByFact([{ id: "C2", relation: "SAME_OCCURRENCE", confidence: 0.2 }], cands))!.factId, 2, "an answer naming the same occurrence attaches whatever its confidence");
});

test("heat counts independent participants, not reports: one outlet publishing twice is one vote, and one outlet alone is never 热 (MIN_PARTICIPANTS=2)", async () => {
  // `MIN_PARTICIPANTS` and the grouping that implements "each participant counts once per window" live in
  // events/hot.ts and are not exported, so the rule is read twice: at its definition, and from the evidence
  // block a real ranking run writes. The case below then proves both halves behaviourally.
  const hotSource = readFileSync(new URL("../packages/backend/src/events/hot.ts", import.meta.url), "utf8");
  assert.match(hotSource, /const MIN_PARTICIPANTS = 2;/, "多方独立报道=热 needs at least two participants");
  assert.match(hotSource, /GROUP BY story_id, participant_key/, "a participant's signals collapse to one vote before they are counted");

  const storm = `台风${T}丙`;
  const seed = await storyWithRoot(`${storm}生成并发布蓝色预警`, "geo-heat-root", SOURCES[0]!);
  rules.batch = (factTitle) => ({ relation: factTitle.includes(storm) ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.95 });
  rules.pair = [];
  // The same outlet reports the same occurrence twice more: two signals, one participant.
  for (const suffix of ["geo-heat-relay-a", "geo-heat-relay-b"]) {
    const res = await groupArticle(await report(SOURCES[0]!, suffix, `${storm}预警复核`, `${storm} 同一台网的第二次发布。`));
    assert.equal(res.verdict, "same-fact", "the repeat bulletin joins the one occurrence");
  }
  const votesOf = async () => sql<{ n: string; keys: string }[]>`
    SELECT count(*) AS n, count(DISTINCT participant_key) AS keys FROM story_signals WHERE story_id = ${seed.storyId}`;
  const votesAlone = await votesOf();
  assert.equal(Number(votesAlone[0]!.n), 2, "the outlet put in two signals");
  assert.equal(Number(votesAlone[0]!.keys), 1, "…which are one participant_key: repeat collection adds no heat");

  // Read the ranking at an hour none of the cases above reached: `heatRows` keeps only signals with
  // observed_at <= at, so the stories this file already founded (voted now) cannot crowd the entries out,
  // and this story cannot be rescued by their heat either.
  const observedAt = new Date(Date.now() - 24 * 3600_000);
  await sql`UPDATE story_signals SET observed_at = ${observedAt} WHERE story_id = ${seed.storyId}`;
  const at = new Date(observedAt.getTime() + 3_600_000);

  const alone = await computeHotRanking(at);
  const [aloneRow] = await sql<{ evidence: { minParticipants: number } }[]>`SELECT evidence FROM hot_rankings WHERE id = ${alone.id}`;
  assert.equal(Number(aloneRow!.evidence.minParticipants), 2, "the ranking records the floor it applied");
  const aloneEntries = await sql<{ entries: unknown }[]>`SELECT entries FROM hot_rankings WHERE id = ${alone.id}`;
  const aloneIds = new Set((aloneEntries[0]!.entries as Array<{ storyId: number }>).map((e) => e.storyId));
  assert.equal(aloneIds.has(seed.storyId), false, "two reports from one outlet do not make a hot event");

  // The differential: one more independent outlet, same fact, and the very same story ranks.
  await groupArticle(await report(SOURCES[3]!, "geo-heat-second", `${storm}路径会商`, `${storm} 气象部门会商路径。`));
  await sql`UPDATE story_signals SET observed_at = ${observedAt} WHERE story_id = ${seed.storyId}`;
  const joined = await computeHotRanking(at);
  const [joinedRow] = await sql<{ entries: Array<{ storyId: number; participantCount: number; reportCount: number }> }[]>`SELECT entries FROM hot_rankings WHERE id = ${joined.id}`;  const entry = joinedRow!.entries.find((e) => e.storyId === seed.storyId);
  assert.ok(entry, "a second independent participant makes it 热: the difference was participants, nothing else");
  const votesJoined = await votesOf();
  assert.equal(Number(votesJoined[0]!.n), 3, "the story now carries three signals");
  assert.equal(Number(votesJoined[0]!.keys), 2, "…from two participant_keys");
  assert.equal(Number(entry.participantCount), 2, "and the ranking counts the two, not the three: a repeat from one outlet adds no heat");
  assert.equal(Number(entry.reportCount), 4, "while the reader still sees all four reports of the occurrence");

  // Leave no ranking behind for the next file to read as the current one.
  await sql`DELETE FROM hot_rankings WHERE id IN (${alone.id}, ${joined.id})`;
});
