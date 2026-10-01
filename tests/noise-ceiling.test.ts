// W2-M1, made visible. The five scoring axes (selection-score.md's sig/nov/cred/reson/act and its hard
// caps for 营销软文、景区宣传稿、盘点稿) never reach the runtime: `ScoreSchema` validates one number in
// 0-100 and drops everything else the model returns, so no ceiling written in a prompt is enforceable in
// code. What IS enforced is one arithmetic comparison — `sum >= threshold * SCORE_CALLS`
// (editorial/analyze.ts) — and it is enforced completely. This file pins both halves: the rule that runs,
// and the rule that does not. Every threshold is read from `@aihot/industry/selection`, so re-calibrating
// the ladder re-runs these assertions instead of breaking them; if a real clamp is ever added and exported
// from the industry pack, the "no clamp exists" test is the one that starts failing, which is the point.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnalysis, SCORE_CALLS, ScoreSchema, tierThreshold, type AnalysisRun } from "@aihot/backend/editorial/analyze";
import { SELECTION } from "@aihot/industry/selection";
import { CATEGORY_BY_ITEM_TYPE, ITEM_TYPES } from "@aihot/industry/taxonomy";

const TIERS = Object.keys(SELECTION.thresholds);
const minThreshold = Math.min(...Object.values(SELECTION.thresholds));
const maxThreshold = Math.max(...Object.values(SELECTION.thresholds));

/** A complete run, so only the fields under test ever vary. */
function run(input: {
  label?: "PASS" | "BLOCK" | "UNKNOWN";
  values?: number[];
  threshold?: number;
  unscored?: boolean;
  refused?: boolean;
  itemType?: string;
  tags?: string[];
  category?: string | null;
  titleZh?: string;
  summaryZh?: string;
} = {}): AnalysisRun {
  const threshold = input.threshold ?? SELECTION.thresholds.T1;
  return {
    prefilter: { label: input.label ?? "PASS", reason: "测试", model: "stub", receiptId: 1, reused: false },
    scores: input.unscored
      ? null
      : { model: "stub", threshold, values: input.values ?? [threshold, threshold], receiptIds: [2, 3], reused: false, ...(input.refused ? { refused: true } : {}) },
    writing: {
      kind: "understand", model: "stub", titleZh: input.titleZh ?? "标题", summaryZh: input.summaryZh ?? "摘要。第二句。",
      reasonZh: "理由", tags: input.tags ?? null, itemType: input.itemType ?? "opinion_analysis", authorRole: "relayer", receiptIds: [4], reused: false,
    },
    structure: { model: "stub", category: input.category ?? null, tags: input.tags ?? [], subjects: [], fact: null, receiptId: 5, reused: false },
  };
}

test("the score step validates one number: the five axes and every prompt ceiling are discarded at the boundary (W2-M1)", () => {
  // The whole answer the scoring prompt asks for, reduced to what the runtime can see.
  const answer = ScoreSchema.parse({ attentionScore: 92, significance: 2, novelty: 3, credibility: 3, resonance: 10, actionability: 3 });
  assert.deepEqual(Object.keys(answer), ["attentionScore"], "the axes are not in the parsed result at all");
  assert.deepEqual(answer, { attentionScore: 92 });
  // The only bound is the range: 0 and 100 pass, anything outside them fails. Nothing about the item's
  // type or noise marking can lower it, because nothing else arrives.
  for (const value of [0, 2, 50, 70, 92, 100]) assert.deepEqual(ScoreSchema.parse({ attentionScore: value }), { attentionScore: value }, `${value} accepted`);
  for (const value of [101, -1, 70.5]) assert.throws(() => ScoreSchema.parse({ attentionScore: value }), `only integers in 0-100 refused: ${value}`);
  // A refusal to score is not a low score: the field is required, so a model that declines yields no value.
  assert.throws(() => ScoreSchema.parse({}));
  // Nothing in the industry pack exports an axis ceiling to clamp with — the gap is structural, not a
  // missing constant. `SELECTION` carries the threshold ladder and the writing floor, and nothing else.
  assert.deepEqual(Object.keys(SELECTION).sort(), ["thresholds", "understandFloor"]);
  assert.equal(Object.hasOwn(SELECTION, "scoreCaps"), false, "no clamp is exported, so analyze.ts cannot consult one");
  // The axes the prompt caps are named per content type; the types the runtime does know about are these.
  assert.equal(ITEM_TYPES.length, 7, "the type set the weight table is written against");
  for (const type of ITEM_TYPES) assert.ok(CATEGORY_BY_ITEM_TYPE[type], `${type} has a fallback category tag`);
});

test("selection is exactly sum >= SCORE_CALLS x tier threshold, and the card shows the floored mean", () => {
  assert.equal(SCORE_CALLS, 2, "two independent scores decide");
  for (const tier of TIERS) {
    const threshold = SELECTION.thresholds[tier]!;
    assert.equal(tierThreshold(tier), threshold, `${tier} reads the industry pack`);
    const atLine = normalizeAnalysis(run({ threshold, values: [threshold, threshold] }));
    assert.equal(atLine.selected, true, `${tier}: 2x${threshold} is on the line and gets in (>=, not >)`);
    const justUnder = normalizeAnalysis(run({ threshold, values: [threshold, threshold - 1] }));
    assert.equal(justUnder.selected, false, `${tier}: one point under 2x${threshold} is out`);
    assert.deepEqual([atLine.score, justUnder.score], [threshold, threshold - 1], "the shown score is the floored mean");
  }
  // The ladder is ordered and non-degenerate; Tiers outside the pack are not scored for 精选 at all.
  assert.ok(SELECTION.thresholds.T1 <= SELECTION.thresholds.T1_5 && SELECTION.thresholds.T1_5 < SELECTION.thresholds.T2, "T1 <= T1_5 < T2");
  for (const tier of ["EXCLUDE_MP", "T3", ""]) assert.equal(tierThreshold(tier), null, `${tier} is not scored`);
  assert.equal(normalizeAnalysis(run({ unscored: true, values: [92, 92] })).selected, false, "a tier with no threshold is never scored for 精选");
});

test("a marketing piece scored at the letter of its own prompt caps clears every tier: the caps bind nothing (W2-M1, exposed not fixed)", () => {
  // selection-score.md caps 旅游软文/景区宣传稿 at sig <= 2 and nothing else by its own words; cred/reson/act
  // are free to go to the top of their anchors. Reading only those literal caps, the audit's arithmetic puts
  // such a piece anywhere in 70-92. Take the top of that band and hold it against the real ladder.
  const marketing = 92;
  assert.deepEqual(ScoreSchema.parse({ attentionScore: marketing }), { attentionScore: marketing }, "the runtime accepts it");
  for (const tier of TIERS) {
    const threshold = SELECTION.thresholds[tier]!;
    const res = normalizeAnalysis(run({
      threshold, values: [marketing, marketing], itemType: "opinion_analysis",
      titleZh: "峡谷地质三日游研学招生火热报名", summaryZh: "扫码咨询课程与费用，一江两岸夜色如画。",
      tags: ["非地理/通用", "研学", "招生"], category: "human",
    }));
    assert.equal(res.selected, true, `${tier} at sum ${marketing * 2} >= 2x${threshold}`);
    assert.equal(res.relevance, "pass", "the noise vocabulary in the tags changes nothing: tags are not read for selection");
  }
  // The 60-point band the industry pack itself names as the highest noise the ladder is meant to hold
  // (例行数据更新、厂商版本通告、多主题盘点稿). Read the ladder and report where it actually lands.
  const routine = 60;
  const admitted = TIERS.filter((tier) => normalizeAnalysis(run({ threshold: SELECTION.thresholds[tier]!, values: [routine, routine] })).selected);
  assert.ok(admitted.length > 0,
    `the 60-point band is now closed on every tier — the W2-M1 gap is partly fixed, rewrite this test to assert the clamp`);
  assert.deepEqual(admitted, TIERS.filter((tier) => SELECTION.thresholds[tier]! <= routine), "the tiers that let routine noise through are those with a threshold at or below it");
  assert.ok(admitted.includes("T1") && admitted.includes("T1_5"),
    `T1 and T1_5 admit the 60-point band on their own numbers (thresholds ${SELECTION.thresholds.T1}/${SELECTION.thresholds.T1_5}): the pack's claim that the ladder "关得住" 60 holds only on T2`);
  assert.equal(normalizeAnalysis(run({ threshold: SELECTION.thresholds.T2!, values: [routine, routine] })).selected, SELECTION.thresholds.T2! <= routine,
    "T2 is the only tier with real headroom over the band, and only while its threshold stays above it");
  // The one number that would close the marketing gap by ladder alone is a threshold at the ceiling itself.
  assert.ok(marketing >= maxThreshold,
    `the strictest tier (${maxThreshold}) sits at or under the letter-of-the-cap marketing score ${marketing}: no tier in this ladder can close that gap by threshold alone`);
});

test("one high score cannot be rescued by axis reasoning: the sum is the only input that ever counts", () => {
  const threshold = minThreshold;
  // A 92 that the prompt's own caps would have kept out, paired with a 10: no axis narrative reaches the
  // comparison, so the mean of a great first read and a terrible second read is simply below the line.
  const lopsided = normalizeAnalysis(run({ threshold, values: [92, 10], tags: ["非地理/通用"], itemType: "observation_release" }));
  assert.deepEqual([lopsided.selected, lopsided.score], [false, 51], "sum 102 < 2x the lowest threshold; the mean is floored to 51");
  assert.ok(51 > SELECTION.understandFloor, "above the writing floor, so it is still written well — the floor buys writing, not 精选");
  assert.equal(lopsided.reasonZh, "理由", "and it is written with the selected style");
  // A second call that never came back is not a pass: one score cannot select anything, however high.
  const onlyOne = normalizeAnalysis(run({ threshold, values: [92] }));
  assert.deepEqual([onlyOne.selected, onlyOne.score], [false, null], `${SCORE_CALLS} values are required to have a sum at all`);
  const none = normalizeAnalysis(run({ threshold, values: [] }));
  assert.deepEqual([none.selected, none.score], [false, null]);
  // A content-filter refusal voids both numbers even when they would clear the line.
  const refused = normalizeAnalysis(run({ threshold, values: [92, 92], refused: true }));
  assert.deepEqual([refused.selected, refused.score], [false, null], "a refused score is not a score");
  assert.equal(refused.scoreRefused, true);
  // BLOCK is not "a low score": it stops before scoring, and nothing downstream can select it.
  const blocked = normalizeAnalysis(run({ label: "BLOCK", threshold, values: [92, 92], titleZh: "", summaryZh: "" }));
  assert.deepEqual([blocked.relevance, blocked.selected], ["block", false]);
  // Past the prefilter but with no usable Chinese copy: relevant, unpublished, never selected.
  const noCopy = normalizeAnalysis(run({ label: "PASS", threshold, values: [92, 92], titleZh: "", summaryZh: "  " }));
  assert.deepEqual([noCopy.relevance, noCopy.selected], ["unknown", false], "an empty title or summary waits instead of publishing");
  // The prefilter's UNKNOWN is treated as PASS: the only gate the prefilter really is, is BLOCK.
  assert.equal(normalizeAnalysis(run({ label: "UNKNOWN", threshold, values: [threshold, threshold] })).selected, true);
});

test("the threshold the code holds is the industry pack's, not a number copied into a prompt or a document", () => {
  // analyze.ts reads `tierThreshold(source.tier)`; the value on a committed judgement is that same number,
  // so a re-calibration in industry/selection.ts moves the rule everywhere at once.
  for (const tier of TIERS) {
    const threshold = SELECTION.thresholds[tier]!;
    const res = normalizeAnalysis(run({ threshold, values: [threshold, threshold] }));
    assert.equal(res.threshold, threshold, "the threshold travels with the judgement for audit");
    assert.equal(tierThreshold(tier), res.threshold);
  }
  assert.equal(tierThreshold(TIERS[0]!), SELECTION.thresholds[TIERS[0]!]);
});
