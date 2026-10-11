// finalizeCopy 的语言门：读者面的门（items.chineseCopyCondition）只查「标题含中文、提要非空」，
// 不查提要的语言。模型答「中文标题 + 英文提要」时，英文提要被当中文稿发出去（红线：不把英文当中文
// 发布）。这道测试钉住三个方向：英文提要被清空、非中文标题退回原文标题（原文中文才可用）、原文与
// 答复都没有中文时字段为空（normalizeAnalysis 会把该条判成等待而不是发布）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeCopy } from "@aihot/backend/editorial/writing";
import { noChineseAnswer } from "@aihot/backend/editorial/analyze";

const english = {
  title: "Magnitude 7.2 earthquake struck off the coast, USGS said",
  text: "A significant earthquake struck off the coast late on Tuesday, the USGS said. ".repeat(5),
  sourceKind: "rss",
  sourceName: "USGS",
};
const chinese = { ...english, title: "近海发生 7.2 级地震" };

test("英文提要不算中文稿：清空而不是发出去", () => {
  const c = finalizeCopy(chinese, { titleZh: "近海发生 7.2 级地震", summaryZh: "A magnitude 7.2 earthquake struck off the coast, USGS said." });
  assert.equal(c.summaryZh, "", "英文提要不要留下");
  assert.equal(c.titleZh, "近海发生 7.2 级地震", "中文标题照常");
});

test("非中文的标题退回原文标题（原文是中文才用）", () => {
  const c = finalizeCopy(chinese, { titleZh: "Magnitude 7.2 earthquake off the coast", summaryZh: "测定近海 7.2 级地震，震源深度 10 千米。" });
  assert.equal(c.titleZh, "近海发生 7.2 级地震", "退回到了原文的中文标题");
  assert.equal(c.summaryZh, "测定近海 7.2 级地震，震源深度 10 千米。", "中文提要不受影响");
});

test("原文与答复都没有中文时字段为空——normalize 会判成等待，列表不会出现英文卡", () => {
  const c = finalizeCopy(english, { titleZh: "Magnitude 7.2 earthquake off the coast", summaryZh: "The USGS said the quake struck late on Tuesday." });
  assert.equal(c.titleZh, "");
  assert.equal(c.summaryZh, "");
});

test("正常中文稿原样通过", () => {
  const c = finalizeCopy(chinese, { titleZh: "近海 7.2 级地震，机构测定", summaryZh: "测定近海 7.2 级地震，震源深度 10 千米。" });
  assert.equal(c.titleZh, "近海 7.2 级地震，机构测定");
  assert.equal(c.summaryZh, "测定近海 7.2 级地震，震源深度 10 千米。");
});

test("混合答复不算「可用」：否则回执被记成好答复，条目永远等不到重问", () => {
  // 上面三条钉的是 finalizeCopy 会清空英文提要；这一组钉的是**这条答复不该被当成好答复**。
  // usable 只问"有没有中文"时，中文标题 + 英文提要通过闸门 → 回执记 completed →
  // 条目停在等待，之后每次重试都免费回放同一条坏答复（只有删 receipts 行才能重问）。
  assert.equal(noChineseAnswer({ titleZh: "近海发生 7.2 级地震", summaryZh: "测定近海 7.2 级地震，震源深度 10 千米。" }), null, "两个字段都是中文：可用");
  assert.match(noChineseAnswer({ titleZh: "近海发生 7.2 级地震", summaryZh: "A magnitude 7.2 earthquake struck off the coast." }) ?? "", /mixes non-Chinese/, "中文标题 + 英文提要：拒收，让下一次重试真的重问");
  assert.match(noChineseAnswer({ titleZh: "Magnitude 7.2 earthquake off the coast", summaryZh: "测定近海 7.2 级地震。" }) ?? "", /mixes non-Chinese/, "反过来混也一样");
  assert.match(noChineseAnswer({ titleZh: "Magnitude 7.2 earthquake", summaryZh: "A magnitude 7.2 earthquake." }) ?? "", /no Chinese copy/, "整条没有中文：仍是原来的理由");
});

// 摘要以「，、；：」收尾就是半句话。线上 2026-08-31 至 10-04 有 1,717 条公开摘要是这个形状（按
// published_at 数出来的，10-04 之后零新增），但"上游会带结尾标点"从来不是一条规则，所以 finalizeCopy
// 里留一道纯文本的收尾：换掉挂着的分隔符，不增一个字的事实。短推文刻意不套：它的提要本来就是来源原话
// 的片段，硬补句号像在替作者结句。
test("提要的结尾不许是挂着的逗号或分号", () => {
  // 材料里得自己提到这些主体，否则身份闸门会先把提要清空（这一条钉的不是身份门，是收尾）。
  const warning = {
    ...chinese,
    title: "中央气象台继续发布大雾黄色预警",
    text: "中央气象台今天继续发布大雾黄色预警：京津冀等地的部分地区能见度低于500米，局地不足200米。有关部门应当按照职责做好防雾准备工作。驾驶人员应注意道路变化，小心驾驶。".repeat(3),
  };
  const c = finalizeCopy(warning, { titleZh: "中央气象台继续发布大雾黄色预警", summaryZh: "中央气象台继续发布大雾黄色预警，有关部门应当按照职责做好防雾准备工作；" });
  assert.doesNotMatch(c.summaryZh, /[，、；：;:]$/u, `留着开放收尾：${c.summaryZh}`);
  assert.equal(c.summaryZh, "中央气象台继续发布大雾黄色预警，有关部门应当按照职责做好防雾准备工作。");
  const comma = finalizeCopy(chinese, { titleZh: "近海发生 7.2 级地震", summaryZh: "测定近海 7.2 级地震，震源深度 10 千米，" });
  assert.equal(comma.summaryZh, "测定近海 7.2 级地震，震源深度 10 千米。");
  const tweet = { ...chinese, sourceKind: "x_search", text: "暴雨预警更新，中心城区局地内涝", mainText: "暴雨预警更新，中心城区局地内涝" };
  assert.equal(finalizeCopy(tweet, { titleZh: "暴雨预警", summaryZh: "中心城区局地内涝，" }).summaryZh, "中心城区局地内涝，", "短推文保留来源原话的片段");

  // 另外两种半句话：正文被抽取器截断时兜底路径原样交出去（线上实测的形状，2026-10-10 一天 19 条）。
  const nmc = { ...chinese, title: "孙吴县气象台发布大雾黄色预警信号", text: "孙吴县气象台2026年10月10日06时40分发布大雾黄色预警信号：孙吴县多地出现能见度小于500米的雾，局部不足200米。".repeat(3) };
  const cut = finalizeCopy(nmc, { titleZh: "孙吴县气象台发布大雾黄色预警信号", summaryZh: "孙吴县气象台2026年10月10日06时40分发布大雾黄色预警信号，孙吴县多地出现能见度小于500" });
  assert.equal(cut.summaryZh, "孙吴县气象台2026年10月10日06时40分发布大雾黄色预警信号。", "没写完的半句退回最近的分句边界，宁可少说一句");
  const mid = finalizeCopy(chinese, { titleZh: "近海发生 7.2 级地震", summaryZh: "测定近海 7.2 级地震，震源深度 10 千米。第二句写到一半" });
  assert.equal(mid.summaryZh, "测定近海 7.2 级地震，震源深度 10 千米。", "前面有写完的句子就收在那儿");
});
