// The two mechanisms that will silently degrade content quality (AUDIT-WAVE2 / wave 4 gap c). Neither one
// reports to a reader or to an editor: `enforceIdentity` throws away a WHOLE summary the moment it names an
// entity the input does not, and `normalizeTags` drops every tag outside the pack's vocabulary. Both are
// deliberate anti-fabrication rules — this file pins that they fire, how far they reach, and what they
// cannot see, all on geography data (台网震级修订、震中县名、机构中文名), because the samples the guard was
// written against are not the ones this site publishes. Two of the cases below pin DEFECTS rather than fix
// them: they are the failures a release gate should be watching, and each one goes red the moment the
// identity lexicon or the vocabulary is repaired.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceIdentity, finalizeCopy, matchEntityIds, type TranslateInput } from "@aihot/backend/editorial/writing";
import { normalizeTags } from "@aihot/backend/editorial/vocabulary";
import {
  CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITY_TAGS, ENTITIES, IDENTITY_LEXICON, ITEM_TYPES, PUBLISHER_DOMAINS, TAG_SYNONYMS, TOPIC_TAGS,
} from "@aihot/industry/taxonomy";

/** Lexicon ids by the name a Chinese editor would write, so these tests never hardcode an id. */
const idOf = (pattern: RegExp) => IDENTITY_LEXICON.find((e) => pattern.test(e.name))?.id;
const USGS = idOf(/USGS/)!;
const CENC = idOf(/地震台网/)!;
const CGS = idOf(/地质调查局(?!.*USGS)/) ?? idOf(/中国地质调查局/)!;
const NOAA = idOf(/^NOAA/)!;
const MEM = idOf(/应急管理部/)!;
const NASA = idOf(/^NASA/)!;
assert.ok(USGS && CENC && CGS && MEM && NASA, "the lexicon still carries the agencies these cases are written against");

const usgsSource = (over: Partial<TranslateInput> = {}): TranslateInput => ({
  title: "USGS issues a revised magnitude for the Lushan earthquake",
  text: "USGS revised the magnitude of the Lushan event to Mw 7.2 after its first automatic bulletin.",
  sourceKind: "rss",
  ...over,
} as TranslateInput);

test("anti-fabrication: a summary naming an agency the input never mentions is discarded whole, not clause by clause", () => {
  // The source is USGS; the model writes the same numbers under China's network's name — a plausible edit
  // for a Chinese readership, and a plain misattribution. Everything goes, including the true sentences.
  const guarded = enforceIdentity(usgsSource(), {
    titleZh: "芦山地震震级修订为 Mw 7.2",
    summaryZh: "中国地震台网中心在速报中给出 7.1 级，震源深度 17 千米，烈度圈覆盖宝兴。",
  });
  assert.deepEqual(guarded.summaryZh, "", "the whole summary is gone, nothing is salvaged sentence by sentence");
  assert.equal(guarded.titleZh, "芦山地震震级修订为 Mw 7.2", "a clean title is untouched");
  assert.deepEqual(guarded.identityGuard, { outcome: "fallback", unsupportedTitleEntityIds: [], unsupportedSummaryEntityIds: [CENC] });

  // A fabrication in the title is answered by the source's own headline when it is already Chinese…
  const zhSource = usgsSource({ title: "芦山地震震级获得修订", text: "震级由自动速报的 7.1 修订为 Mw 7.2。" });
  const substituted = enforceIdentity(zhSource, { titleZh: "应急管理部启动四级响应", summaryZh: "震级获得修订。" });
  assert.deepEqual([substituted.titleZh, substituted.identityGuard.unsupportedTitleEntityIds], ["芦山地震震级获得修订", [MEM]]);
  // …and by nothing at all when the original is in another language, so the item cannot be published.
  const empty = enforceIdentity(usgsSource(), { titleZh: "中国地震台网中心修订震级", summaryZh: "中国地震台网中心给出 7.1 级。" });
  assert.deepEqual([empty.titleZh, empty.summaryZh, empty.identityGuard.outcome], ["", "", "fallback"]);
  assert.deepEqual([empty.identityGuard.unsupportedTitleEntityIds, empty.identityGuard.unsupportedSummaryEntityIds], [[CENC], [CENC]]);

  // Two agencies in one summary is one discard: the guard reports both, and cannot keep the true half.
  const two = enforceIdentity(usgsSource(), { titleZh: "芦山地震震级修订", summaryZh: "美国国家海洋和大气管理局发布海温异常，中国地震台网中心给出 7.1 级。" });
  assert.deepEqual(two.identityGuard.unsupportedSummaryEntityIds, [CENC, NOAA], "an agency absent from the input in any position fails the whole field");
  assert.equal(two.summaryZh, "");
});

test("anti-fabrication: what the guard reads as 'the input named it' — publisher domain, source name and owner", () => {
  // The publishing domain counts as that agency naming itself, with the name never spelled out in the text…
  const onNasaDotGov = enforceIdentity({ title: "Ice-sheet elevation change", text: "The updated map covers Greenland.", sourceKind: "rss", documentUrl: "https://www.nasa.gov/ice/" } as TranslateInput,
    { titleZh: "美国宇航局发布格陵兰冰盖高程图", summaryZh: "冰盖高程图已更新。" });
  assert.equal(onNasaDotGov.identityGuard.outcome, "pass", "the publisher of the document is an allowed subject");
  // …and without it the same copy is a fallback, so the grant is the domain and nothing else.
  const noDomain = enforceIdentity({ title: "Ice-sheet elevation change", text: "The updated map covers Greenland.", sourceKind: "rss" } as TranslateInput,
    { titleZh: "美国宇航局发布格陵兰冰盖高程图", summaryZh: "冰盖高程图已更新。" });
  assert.deepEqual([noDomain.identityGuard.outcome, noDomain.identityGuard.unsupportedTitleEntityIds], ["fallback", [NASA]]);
  // A source's own name counts (an agency account relaying its bulletin), as does a registered owner.
  const byOwner = enforceIdentity(usgsSource({ title: "Bulletin", text: "Mw 7.2.", sourceName: "NASA Scientific Visualization Studio" }),
    { titleZh: "美国宇航局发布影像", summaryZh: "卫星影像已公布。" });
  assert.equal(byOwner.identityGuard.outcome, "pass");
  const declared = enforceIdentity({ title: "Ice-sheet map", text: "Elevation change mapped.", sourceKind: "rss", sourceOwnerEntityId: NASA } as TranslateInput,
    { titleZh: "美国宇航局发布冰盖高程图", summaryZh: "高程图已更新。" });
  assert.equal(declared.identityGuard.outcome, "pass");
  assert.deepEqual(matchEntityIds(["美国宇航局"]), [NASA], "the Chinese name resolves to the same id");
  // Every display tag the entity roster advertises must resolve to its own id first, or the guard rejects
  // copy that is faithful, and every publisher domain must name an agency the lexicon knows.
  for (const [id, entity] of Object.entries(ENTITIES)) {
    if (!entity.displayTag) continue;
    assert.equal(matchEntityIds([entity.displayTag])[0], id, `${entity.displayTag} resolves to ${id}`);
  }
  for (const entry of PUBLISHER_DOMAINS) assert.ok(IDENTITY_LEXICON.some((e) => e.id === entry.entityId), `${entry.entityId} is a domain owner the lexicon can name`);
});

test("DEFECT, pinned not fixed: the lexicon's 地质调查局 pattern makes 美国地质调查局 look like a fabrication, so correct USGS copy is discarded (identity guard fires on the truth)", () => {
  // The source says USGS in English. The faithful Chinese title names it 美国地质调查局 — and the guard sees
  // 中国地质调查局 inside it (that entry's pattern is the bare substring 地质调查局), so it drops the copy.
  const faithful = enforceIdentity(usgsSource(), { titleZh: "美国地质调查局修订芦山地震震级", summaryZh: "美国地质调查局在自动速报之后把震级修订为 Mw 7.2。" });
  assert.deepEqual(matchEntityIds(["美国地质调查局"]).slice().sort(), [CGS, USGS].sort(), "one name resolves to two agencies");
  assert.deepEqual([faithful.titleZh, faithful.summaryZh, faithful.identityGuard.outcome], ["", "", "fallback"], "the guard discards a faithful translation: this is the silent content kill");
  assert.deepEqual(faithful.identityGuard.unsupportedTitleEntityIds, [CGS], "the agency it invents is 中国地质调查局, which the copy never claims");
  // The mirror of the same substring: when the input does name the American survey, the Chinese one is
  // treated as already named, so a real misattribution between the two passes unseen.
  const chineseForAmerican = usgsSource({ title: "美国地质调查局发布芦山地震修订测定", text: "美国地质调查局把震级修订为 Mw 7.2。" });
  const misattributed = enforceIdentity(chineseForAmerican, { titleZh: "中国地质调查局发布芦山地震专项报告", summaryZh: "中国地质调查局派出工作组开展震区地质调查。" });
  assert.equal(misattributed.identityGuard.outcome, "pass", "the guard cannot tell the two survey agencies apart: this misattribution is invisible");
  // Even a genuine USGS page does not rescue it: the domain grants usgs, and the copy still names cgs.
  const fromTheAgency = enforceIdentity({ title: "Magnitude 7.2 revision", text: "Epicentre 30.3N 103.0E, depth 17 km.", sourceKind: "rss", documentUrl: "https://earthquake.usgs.gov/earthquakes/event/p1/" } as TranslateInput,
    { titleZh: "美国地质调查局修订芦山地震震级", summaryZh: "美国地质调查局给出修订后的震级。" });
  assert.deepEqual([fromTheAgency.identityGuard.outcome, fromTheAgency.identityGuard.unsupportedTitleEntityIds], ["fallback", [CGS]], "the page that really published it is not enough");
  // The collision set the release gate should watch. A fix to industry/taxonomy.ts must empty it, and then
  // this assertion is the one that tells you the two cases above can be inverted into real guarantees.
  const collisions = IDENTITY_LEXICON
    .flatMap((entry) => matchEntityIds([entry.name]).filter((id) => id !== entry.id).map((id) => `${entry.id}->${id}`))
    .sort();
  assert.deepEqual(collisions, ["usgs->cgs"], `identity lexicon substring collisions: ${collisions.join(", ") || "none"}`);
});

test("anti-fabrication: the guard runs last, after the paid call and after compaction, so a discarded summary is a spent call", () => {
  const filler = "补充说明这一段仍然只讲测定参数与烈度圈。";
  const long = `震级修订为 Mw 7.2，震源深度 17 千米，震中位于宝兴境内，烈度圈已绘制。${filler.repeat(12)}`;
  const compacted = finalizeCopy(usgsSource(), { titleZh: "芦山地震震级修订", summaryZh: long });
  assert.ok(compacted.summaryZh.length <= 190 && compacted.summaryZh.length < long.length, "length is compacted first, without another call");
  assert.equal(compacted.identityGuard.outcome, "pass", "nothing invented, so the compacted copy stands");

  // A fabricated agency in the opening sentences is caught after the compaction: the paid call's entire
  // output is thrown away, and the only record of that is the guard object.
  const early = finalizeCopy(usgsSource(), { titleZh: "芦山地震震级修订", summaryZh: `应急管理部决定启动救灾响应。${long}` });
  assert.deepEqual([early.summaryZh, early.identityGuard.outcome], ["", "fallback"]);
  assert.deepEqual(early.identityGuard.unsupportedSummaryEntityIds, [MEM]);
  assert.deepEqual(Object.keys(early).sort(), ["identityGuard", "summaryZh", "titleZh"], "no repaired text is offered, and no second call is made");

  // The same claim past the cut is never examined: compaction runs on the copy before the guard reads it,
  // so the verdict depends on where the length cut lands. Today the cut also removes the words, but the
  // check itself is skipped, and any future change to the cut rule changes what the guard ever sees.
  const tail = finalizeCopy(usgsSource(), { titleZh: "芦山地震震级修订", summaryZh: `${long}应急管理部决定启动救灾响应。` });
  assert.equal(tail.identityGuard.outcome, "pass", "the guard never saw the agency, because it was trimmed away first");
  assert.equal(tail.summaryZh.includes("应急管理部"), false);
  assert.equal(enforceIdentity(usgsSource(), { titleZh: "芦山地震震级修订", summaryZh: `${long}应急管理部决定启动救灾响应。` }).identityGuard.outcome, "fallback", "unedited, the same copy is a fallback: the order of the two steps is load-bearing");
});

test("tag vocabulary: every out-of-vocabulary tag is dropped in silence, and the county names are out of vocabulary", () => {
  // A model that tags an occurrence by where it happened — the most natural move for a geography site.
  const fallback = CATEGORY_BY_ITEM_TYPE.disaster_event;
  const dropped = normalizeTags(["地震", "芦山县", "天全县", "宝兴", "龙门山断裂带", "Mw7.2"], { fallbackCategory: fallback });
  assert.deepEqual(dropped, [fallback, "地震"], "place and fault names are not vocabulary tags, so all four vanish without a trace");
  for (const place of ["芦山县", "天全县", "宝兴", "龙门山断裂带"]) {
    assert.equal((TOPIC_TAGS as readonly string[]).includes(place), false, `${place} is not a topic tag: the vocabulary carries no place granularity, so the geography traps cannot be caught by tags`);
  }
  // The same silence for an empty or unusable answer: what the audit found as tags=["其他"] on the wire.
  assert.deepEqual(normalizeTags([]), [CATEGORY_TAGS.at(-1)], "no tags at all becomes 其他");
  assert.deepEqual(normalizeTags(["不存在的类"]), [CATEGORY_TAGS.at(-1)]);
  assert.deepEqual(normalizeTags(null), [CATEGORY_TAGS.at(-1)]);
  assert.deepEqual(normalizeTags("灾害事件,预警/响应"), ["灾害事件", "预警/响应"], "a comma-separated string is accepted");
  assert.deepEqual(normalizeTags(["#震情", "震情", "余震"]), [CATEGORY_TAGS.at(-1), "地震"], "a leading # is stripped, synonyms mapped, duplicates folded; with no category the catch-all still takes the first slot");
  // The fallback category is trusted without checking it: only the table's coverage keeps it valid.
  assert.deepEqual(normalizeTags(["地震"], { fallbackCategory: "手写分类" }), ["手写分类", "地震"], "fallbackCategory is used verbatim, validated only by its caller");
  for (const type of ITEM_TYPES) assert.ok((CATEGORY_TAGS as readonly string[]).includes(CATEGORY_BY_ITEM_TYPE[type]!), `${type} falls back to a real category tag`);
  // The list is capped silently, and the cap counts the category: the seventh tag is lost.
  const many = normalizeTags(["遥感影像", "卫星导航", "GIS与空间数据", "地图与制图", "高原", "海洋", "冰川与冻土"]);
  assert.equal(many.length, 6, "at most six tags");
  assert.equal(many.includes("冰川与冻土"), false, "and the overflow is dropped without an error");
});

test("tag vocabulary: a synonym that no longer points at a real tag would drop silently, so the table is checked verbatim", () => {
  const vocabulary = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
  for (const [from, to] of Object.entries(TAG_SYNONYMS)) {
    assert.ok(vocabulary.has(to), `${from} maps to "${to}", which is not in the vocabulary`);
    const isCategory = (CATEGORY_TAGS as readonly string[]).includes(to);
    assert.deepEqual(normalizeTags([from]), isCategory ? [to] : [CATEGORY_TAGS.at(-1), to], `${from} → ${to}`);
  }
  const displayTags = Object.values(ENTITIES).filter((e) => e.displayTag).map((e) => e.displayTag!);
  assert.deepEqual(ENTITY_TAGS.slice().sort(), displayTags.slice().sort(), "entity tags and the entity roster are one list");
  assert.equal(new Set(displayTags).size, ENTITY_TAGS.length, "and no two agencies share a tag");
});
