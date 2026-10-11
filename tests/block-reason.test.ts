// 拦下的条目要留下「为什么拦」。
//
// BLOCK 之后管道就停了（`writing` 是 null），所以预筛那一句理由是这条材料唯一的记录。2026-10-11 生产实测：
// 三天里 1,381 条 block 的 `analyses.reason_zh` **全部为空**——后台只看得到「已拦」，人工复核拦得对不对
// 没有任何依据（读者面不受影响：拦下的条目本来就不给读者看）。
//
// 这里钉三件事：BLOCK 把预筛的理由留下；PASS／UNKNOWN 不拿预筛的话冒充编辑判断（写作那步的理由优先，
// 没有写作步骤就是空）；理由里的换行折叠成一行，与标题摘要同一个写法。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnalysis, type AnalysisRun } from "@aihot/backend/editorial/analyze";

const prefilter = (label: AnalysisRun["prefilter"]["label"], reason: string) =>
  ({ label, reason, model: "m", receiptId: 1, reused: false });
const run = (over: Partial<AnalysisRun> & { prefilter: AnalysisRun["prefilter"] }): AnalysisRun =>
  ({ scores: null, writing: null, structure: null, ...over }) as AnalysisRun;

test("BLOCK 留下预筛的理由，人工复核看得见依据", () => {
  const out = normalizeAnalysis(run({ prefilter: prefilter("BLOCK", "文旅 promotional 软文，没有空间显著性") }));
  assert.equal(out.relevance, "block");
  assert.equal(out.reasonZh, "文旅 promotional 软文，没有空间显著性", "拦下它的那句话被丢掉了");
});

test("PASS 与 UNKNOWN 不拿预筛的话冒充编辑理由；写了稿子就用稿子的理由", () => {
  const plain = normalizeAnalysis(run({ prefilter: prefilter("PASS", "与地理相关") }));
  assert.equal(plain.reasonZh, null, "没走写作步骤时不编一条理由");
  const written = normalizeAnalysis(run({
    prefilter: prefilter("PASS", "与地理相关"),
    writing: { kind: "understand", model: "m", titleZh: "标题", summaryZh: "摘要。", reasonZh: "近实时测绘能力的一处变化", tags: null, receiptIds: [2], reused: false },
  }));
  assert.equal(written.relevance, "pass");
  assert.equal(written.reasonZh, "近实时测绘能力的一处变化", "写作那步的理由优先，不与预筛的话混成一句");
});

test("预筛理由里的换行折叠成一行", () => {
  const out = normalizeAnalysis(run({ prefilter: prefilter("BLOCK", "  非地理：\n\n  分子生物学 \n") }));
  assert.equal(out.reasonZh, "非地理： 分子生物学");
});
