// 眉标下面没有导读时，页面要说一声。
//
// 2026-10-17 实测：weekly 2026-W12 / W16 / W21 / W30 与 monthly 2026-04 这 5 期的总述没从站内模型拿到
// （`receipts` 里 proseRule 记的是 `model-unparsable`：dots3 的 cap 8,500、step-5 的 cap 6,500 被思考链吃满），
// 而 `ReportPaper` 当时写的是 `{dek && (…)}` —— 眉标照印、标题走机械兜底（"本周的 40 件地理大事"）、
// 导读那一块整块不渲染。读者分不清"这期没有总述"和"这里本来就没有"，而本站对前者一向是给诚实句子的
// （条目页「这一条还没有中文稿：……」、事件页同型）。所以这里钉四件事：
// ① 句子只报当前状态与去处，不许承诺"稍后就有"（那 5 期重排两次，拿到的是同一份不可用的答复）；
// ② 措辞按 kind 分叉——日报那一块眉标是「头条」、印的是「导语」，库里另有 9 期日报两样都缺，不能对它们说"总述"；
// ③ `ReportPaper` 必须走 `dek ? … : …`，而不是把整块藏起来；
// ④ 非横图（`cover && !wide`）那张配图不能因为缺导读而一起消失——它以前就住在这个条件块里。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { leadAbsentNote } from "../apps/web/app/features/report/format.ts";

const PAPER = readFileSync(new URL("../apps/web/app/features/report/ReportPaper.tsx", import.meta.url), "utf8");

test("诚实句只说现状和去处，不承诺稍后有，也不漏内部名词", () => {
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const note = leadAbsentNote(kind);
    assert.match(note, /：下面.*直排。$/, `${kind}：要说清读者现在能看到什么`);
    assert.doesNotMatch(note, /稍后|正在|即将|马上|会补|待补/, `${kind}：不许承诺交付`);
    assert.doesNotMatch(note, /model|receipt|token|proseRule|cap\b/i, `${kind}：不许把内部名词摆给读者`);
  }
});

test("日报说「导语」、周报月报说「总述」，两种版面不能共用一句", () => {
  assert.match(leadAbsentNote("daily"), /^这一天的导语/);
  assert.match(leadAbsentNote("weekly"), /^这一期还没有总述/);
  assert.match(leadAbsentNote("monthly"), /^这一期还没有总述/);
});

test("总述缺失时那一块照样渲染，走的是一元运算符的另一边", () => {
  assert.match(PAPER, /\{dek \? \(/, "有导读走这一边");
  assert.match(PAPER, /\)\s*:\s*\(\s*\n?\s*<p[^>]*>\{leadAbsentNote\(report\.kind\)\}<\/p>/, "没导读要把诚实句子印出来");
  // 旧的写法是 `{dek && (…)}`：缺导读时整块不渲染，读者面上看不出区别。
  assert.doesNotMatch(PAPER, /\{dek && \(/);
});

test("非横图的配图不住在导读的条件里，缺导读不能把图一起带走", () => {
  // 判据就一条：`!wide` 那张配图必须排在诚实句子**之后**、同一个容器里。
  // 它一旦被搬回 `dek ?` 为真的那一支，就会跑到前面去——正是以前"缺导读顺手把图也藏了"的形状。
  const open = /<div className=\{cover && !wide \?/.exec(PAPER);
  assert.ok(open, "头版那一块按是否非横图换布局");
  const end = PAPER.indexOf("\n        </div>", open.index);
  assert.ok(end > open.index, "这块的收尾 div 找得到");
  const block = PAPER.slice(open.index, end);
  const noteAt = block.indexOf("{leadAbsentNote(report.kind)}");
  const picAt = block.indexOf("{cover && !wide && <LeadPicture");
  assert.ok(noteAt >= 0 && picAt >= 0, "块里既有诚实句子也有那张非横图");
  assert.ok(noteAt < picAt, "配图排在导读/诚实句子之后，两者是并列的兄弟");
});
