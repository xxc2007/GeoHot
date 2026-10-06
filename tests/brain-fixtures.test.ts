// The fixture contract, checked against the callers' own prompt builders rather than a description of them.
// Why this exists: a `match` key the step's request cannot contain is silent — the signed Chinese copy is
// never served, the answer falls back to a rule, no job fails and the admin shows nothing (measured
// 2026-10-02: three summarize fixtures keyed on `urlIncludes` were dead for two days, because
// buildArticlePrompt sends date, source, title and body — no URL, and cleanArticleTextForLLM deletes the
// links out of the body). Reader-facing prose that nobody signed is the other half of the same line: the
// stub must answer with no copy, and the caller must keep what it has.
//
// No database here: the stub is a pure function of the request and the fixture files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildArticlePrompt, buildLongTweetPrompt, buildShortTweetPrompt, isShortTweetInput, translateInputOf,
  UNDERSTAND_SYSTEM, understandUser,
} from "@aihot/backend/editorial/writing";
import { promptText } from "@aihot/backend/editorial/prompts";
import { answer, runLint } from "../tooling/brain-stub.ts";

interface Fixture { id: string; match: Record<string, string | string[] | undefined>; reply: Record<string, unknown>; author?: string; guard?: Record<string, string> }

const readFixtures = (cap: string): Fixture[] =>
  readFileSync(new URL(`../tooling/fixtures/${cap}.jsonl`, import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as Fixture);

/** The article as the caller would load it, from the provenance a fixture records about its own material. */
const articleOf = (guard: Record<string, string>) => ({
  id: "fixture-material", revision: 1, title: guard.title ?? "", url: guard.url ?? "", author: null,
  publishedAt: null, discoveredAt: new Date(0), bodyText: guard.text ?? null, excerpt: null, bodyStatus: "ok",
  xPost: null, media: [], translationZh: null,
  source: { name: guard.sourceName ?? "", kind: guard.sourceKind ?? "rss", tier: "T2", firstParty: false, tags: [], ownerEntityId: null },
});

/** The request one step really sends for that material, built by that step's own prompt builder. */
function requestOf(cap: string, guard: Record<string, string>): { system: string; user: string } {
  const a = articleOf(guard);
  if (cap === "understand") return { system: UNDERSTAND_SYSTEM, user: understandUser(a) };
  const t = translateInputOf(a);
  const user = isShortTweetInput(t) ? buildShortTweetPrompt(t) : t.sourceKind === "x_search" ? buildLongTweetPrompt(t) : buildArticlePrompt(t);
  return { system: "", user };
}

const chat = (system: string, user: string) =>
  answer({ model: "geohot-brain", messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }] });

test("every signed article-copy fixture fires on the request its own material produces", () => {
  // The 2026-10-02 failure mode, caught where it happened: not "is the file valid JSON" but "would this
  // answer ever be chosen". Each fixture is asked with the message the caller would build from its guard.
  const checked: string[] = [];
  for (const cap of ["summarize", "understand"]) {
    for (const fixture of readFixtures(cap)) {
      assert.ok(fixture.guard?.title, `${cap}/${fixture.id} 需要 guard（写明这条中文稿是为哪份材料写的），否则没有人能证明它会被选中`);
      const { system, user } = requestOf(cap, fixture.guard as Record<string, string>);
      const entry = chat(system, user).entry;
      assert.equal(entry.capability, cap, `${cap}/${fixture.id}：请求被认成了 ${entry.capability}`);
      assert.equal(entry.fixtureId, fixture.id, `${cap}/${fixture.id} 没有命中自己的材料（via=${entry.via}）—— 这份人工中文稿到不了读者`);
      checked.push(`${cap}/${fixture.id}`);
    }
  }
  assert.ok(checked.length > 100, `这条断言要看的是全部签名稿件，实际只跑了 ${checked.length} 条`);
});

test("summarize with no signed copy answers with no copy (rule:empty), never an echo of the source", () => {
  // The October incident: the default used to fill title_zh/summary_zh from the English original, which
  // made analyze.ts's Chinese gate useless and put 12 English items into the public pool.
  const material = { title: "Weekly tsunami advisory for the Aleutian region", sourceName: "Some Bulletin", text: "A routine advisory listing sea states and no specific event.", url: "https://example.org/tsunami-advisory-unique" };
  const { content, entry } = chat("", buildArticlePrompt(translateInputOf(articleOf(material))));
  assert.equal(entry.fixtureId, null, "没有 fixture 就是没有人工稿");
  assert.match(entry.rule ?? "", /^rule:empty/, `默认策略必须是空答案，实际 ${entry.rule}`);
  assert.equal(content, "title_zh: \nsummary_zh: ", content);
});

test("the digest answers with no prose when nobody has written one", () => {
  // `rule:chronology` used to compress the request's report lines into a 综述 that events/digest.ts then
  // published — machine prose replacing signed prose. The stub now refuses to be the author.
  const user = `事件当前标题：秘鲁南部沿海 M5.2 地震（未写综述）${Date.now()}\n\n报道（按时间）：\n2026-10-02 03:10｜测试信源甲｜秘鲁南部沿海 M5.2 地震｜一台站测定 5.2 级，震源深度 32 千米。`;
  const { content, entry } = chat(promptText("story-digest"), user);
  assert.equal(entry.capability, "digest");
  assert.equal(entry.fixtureId, null);
  assert.match(entry.rule ?? "", /^rule:no-signed-copy/, `实际 rule=${entry.rule}`);
  assert.deepEqual(JSON.parse(content), { title: "", digest: "", latest: "" }, content);
});

test("a signed digest fixture still answers, with its author on the receipt", () => {
  const signed = readFixtures("digest").find((f) => Array.isArray(f.match.titleIncludes) ? f.match.titleIncludes.length : !!f.match.titleIncludes);
  assert.ok(signed, "digest.jsonl 里应有人工写好的综述");
  const title = String(Array.isArray(signed!.match.titleIncludes) ? signed!.match.titleIncludes[0] : signed!.match.titleIncludes);
  const { content, entry } = chat(promptText("story-digest"), `事件当前标题：${title}\n\n报道（按时间）：\n2026-10-02 03:10｜测试信源甲｜${title}｜摘要一句。`);
  assert.equal(entry.fixtureId, signed!.id);
  assert.equal(entry.author, signed!.author, "回执要能看出这份综述是谁写的");
  assert.equal(entry.rule, null, "fixture 命中的答案不是机器默认");
  assert.equal(JSON.parse(content).digest, signed!.reply.digest);
});

test("the lint refuses dead matchers, truncated copy, and stays silent on nothing", async () => {
  const out = await runLint();
  const dead = out.report
    .filter((r) => r.cap && r.id)
    .flatMap((r) => (r.problems as string[]).filter((p) => /urlIncludes|永远不生效|截断/.test(p)).map((p) => `${r.cap}/${r.id}: ${p}`));
  assert.deepEqual(dead, [], "matcher 命中不了这一步的请求，或人工稿被截断：\n" + dead.join("\n"));
});

test("no capability answers reader-facing prose from a rule any more", async () => {
  // `digest` was fixed first; `reports/compose.ts` gated on `usage.brain.rule` on 2026-10-05, which let
  // report_lead / report_period fall back to the same empty answer. The list is meant to stay empty from
  // here on: an entry means some step is writing prose a reader will read out of a rule again, and whoever
  // reads it has to relearn the refusal (`BRAIN_REPORT_LEAD_DEFAULT=list` is how a run does that on purpose).
  const out = await runLint();
  assert.deepEqual(out.readerCopyDefaults.map((d) => d.cap).sort(), [], `这些能力又在用规则写读者要读的稿子：${out.readerCopyDefaults.map((d) => `${d.cap}(${d.rule})`).join(", ")}`);
  const knownUnsignedCopy = "understand-fill-mongabay-elnino-evidence";
  const problems = out.report.filter((r) => (r.problems as string[] | undefined)?.length).map((r) => `${r.cap}/${r.id}`);
  assert.deepEqual(problems.filter((p) => !p.endsWith(knownUnsignedCopy)), [], `fixture 里出现了新的问题：${problems.join(", ")}`);
  // The one allowed case is a gap in another owner's file: IDENTITY_LEXICON's wmo patterns
  // (industry/taxonomy.ts:278) do not know "World Meteorological Organization", so a faithful Chinese
  // rendering of the source's own attribution is dropped by enforceIdentity. It must not grow.
  assert.equal(out.fixturesWithProblems <= 1, true, `只允许那一条已知问题，实际 ${out.fixturesWithProblems}`);
});
