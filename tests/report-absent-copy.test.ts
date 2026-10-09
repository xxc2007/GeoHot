// A report URL with no edition behind it has four different reasons, and the site used to answer all four
// with the root 404's 「你访问的页面不存在，或内容已不再公开。」 That sentence claims the paper published
// something and took it back — false for a day nothing was printed, false for a window that has not closed,
// false for a mistyped issue key, and about to matter a lot: the archive backfill is filling January through
// September issue by issue, so readers will pick a date that has no edition yet by the hundred, and each of
// them would be told the newspaper retracted it.
//
// So each reason gets its own sentence, and no reason is allowed to borrow the retraction wording.
import assert from "node:assert/strict";
import { test } from "node:test";
import { absentCopy, KINDS, reportAbsentReason } from "../apps/web/app/features/report/format.ts";

const reasons = ["bad_key", "no_edition", "not_yet", "unreadable"] as const;
/** 2026-10-09 的北京时间 06:00 与 09:00 —— 日报在 08:00 收口，这两刻正好分在两侧。 */
const beforeCutoff = Date.parse("2026-10-08T22:00:00Z");
const afterCutoff = Date.parse("2026-10-09T01:00:00Z");

test("期号写法与「永远不会有」的日期不再被算成「还没到」", () => {
  assert.equal(reportAbsentReason("daily", "2026-10-09", beforeCutoff), "not_yet");
  assert.equal(reportAbsentReason("daily", "2026-10-09", afterCutoff), "no_edition");
  // 2 月 30 日没有 dueAt：它不是下一期，是永远不会有的那一期。
  assert.equal(reportAbsentReason("daily", "2026-02-30", afterCutoff), "no_edition");
  // 13 月、第 54 周写法一样长，但那种期次不存在，所以是"认不出来"而不是"没有这一期"。
  assert.equal(reportAbsentReason("monthly", "2026-13", afterCutoff), "bad_key");
  assert.equal(reportAbsentReason("weekly", "2026-W54", afterCutoff), "bad_key");
  assert.equal(reportAbsentReason("daily", "2026-9-2", afterCutoff), "bad_key");
  assert.equal(reportAbsentReason("weekly", "2026-W41", afterCutoff), "not_yet");
  assert.equal(reportAbsentReason("monthly", "2026-09", afterCutoff), "no_edition");
});

test("四种情形各说一句，且没有一种把「这一期被撤下了」当成事实说", () => {
  const said = reasons.map((r) => `${absentCopy("daily", "2026-09-24", r).title}｜${absentCopy("daily", "2026-09-24", r).body}`);
  assert.equal(new Set(said).size, 4, `四句话不能撞车：${said.join(" / ")}`);
  for (const line of said) {
    // 旧的那句 404 说的是"内容已不再公开"——它把一件没出过的事讲成一件被收回的事。
    assert.doesNotMatch(line, /不再公开|已下架|曾公开|曾经发布/, `这句话在暗示一份被撤回的报纸：${line}`);
  }
  // 「不是出过之后撤下」是本站**否认**撤回，允许出现一次，且只能以否认的形式出现。
  const noEdition = absentCopy("daily", "2026-09-24", "no_edition").body;
  assert.equal((noEdition.match(/撤/g) ?? []).length, 1, noEdition);
  assert.match(noEdition, /不是出过之后撤下/);
  for (const r of ["bad_key", "not_yet", "unreadable"] as const) {
    assert.doesNotMatch(`${absentCopy("daily", "2026-09-24", r).body}`, /撤/, `${r} 不该谈撤回`);
  }
});

test("没出过刊的那一句说清「从来没有过」而不是「被撤了」", () => {
  const copy = absentCopy("daily", "2026-09-24", "no_edition");
  assert.equal(copy.title, "没有「2026-09-24」这一期");
  assert.match(copy.body, /不是出过之后撤下/);
  assert.match(copy.body, /存档里从来没有过/);
});

test("还没到出刊时间的那一句不假称这一天不存在", () => {
  const copy = absentCopy("monthly", "2026-11", "not_yet");
  assert.match(copy.title, /还没到出刊时间/);
  assert.match(copy.body, /还没有走完/);
  assert.doesNotMatch(`${copy.title}${copy.body}`, /从来没有过/);
});

test("期号写法不对的那一句给出三种正确写法", () => {
  const copy = absentCopy("weekly", "2026-40", "bad_key");
  for (const shape of ["2026-10-09", "2026-W40", "2026-09"]) assert.ok(copy.body.includes(shape), `少了一种写法：${copy.body}`);
});

test("数据读不到时不下任何结论，既不说出了也不说没出", () => {
  const copy = absentCopy("daily", "2026-10-09", "unreadable");
  assert.match(copy.body, /还不能说这一期出刊了没有/);
  assert.doesNotMatch(copy.body, /没有出过|从来没有过|还没到/);
});

test("三种报纸的名字都在句子里，读者不必从网址猜这是哪一种", () => {
  const LABEL: Record<string, string> = { daily: "日报", weekly: "周报", monthly: "月报" };
  for (const kind of KINDS) {
    for (const reason of ["no_edition", "not_yet", "unreadable"] as const) {
      const copy = absentCopy(kind, "2026-10-09", reason);
      assert.ok(`${copy.title}${copy.body}`.includes(LABEL[kind]!), `${kind}/${reason} 没有点名是哪一份报纸：${copy.title}`);
    }
  }
});
