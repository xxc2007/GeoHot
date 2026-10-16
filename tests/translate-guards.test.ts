// 译文入库前的三块"内容守卫"（纯函数，不碰库）。第一块是引用编号守卫，第二块是长度/断句守卫，
// 第三块把第一块的"空括号"判据收紧到只认分隔符（公式里的 f(⋅) 不该被当成丢掉的引用）。
// 依据：2026-10-16 在库存译文里量到 8 条中文句子留着**被掏空的引用括号**——
//   `…负的碳同位素偏移（δ13C）（; ; ; ）`、`…持续推进（）并导致…（）`
// 源文那里是 (12; 13) 式编号，Frontiers 的采集把它摊成了纯文本，所以 unshield 的链接计数守卫接不住。
import assert from "node:assert/strict";
import { test } from "node:test";
import { shield, unshield } from "@aihot/backend/editorial/translate";

test("源括号里有编号、译文括号被掏空 ⇒ 整块按没翻出来处理（重问一次，再不行保留原文）", () => {
  const s = shield("全球数据库里 40% 的条目被引用（12; 13; 14），且这一比例逐年上升。");
  assert.equal(unshield("全球数据库中 40% 的条目被引用（; ; ），且该比例逐年上升。", s), null, "编号被丢进空括号：读者看到的是「话到一半，出处是空的」");
});

test("编号保住了就不是缺陷：同样的句子带着数字回来，照单入库", () => {
  const s = shield("全球数据库里 40% 的条目被引用（12; 13; 14），且这一比例逐年上升。");
  const got = unshield("全球数据库中 40% 的条目被引用（12；13；14），且该比例逐年上升。", s);
  assert.ok(got && got.includes("（12；13；14）"), String(got));
});

test("源文本来就是空括号时不冤枉译文（这一族的判定只认「源里有、译文里没了」）", () => {
  const s = shield("该方法的细节见（; ），后续章节展开。");
  const got = unshield("该方法的细节见（；），后续章节展开。", s);
  assert.ok(got, "源里没有编号，译文留空括号不是丢信息");
});

test("括号外漏数字不触发这条守卫（那是另一族问题，不能靠这一条误伤整块）", () => {
  const s = shield("样本量为 1,200 个站点，覆盖 12 个国家。");
  const got = unshield("样本量为 1,200 个站点，覆盖多个国家。", s);
  assert.ok(got, "没有空括号，就不该被这一条判死");
});

test("引用带链接的写法仍由原有守卫负责：链接丢了整块退回原文", () => {
  const s = shield('见 <a href="https://example.org/r12">12</a> 与 <a href="https://example.org/r13">13</a> 两节。');
  assert.equal(unshield("见 12 与 13 两节。", s), null);
  const ok = unshield('见 <a id="L0">12</a> 与 <a id="L1">13</a> 两节。', s);
  assert.ok(ok && ok.includes('href="https://example.org/r12"'), String(ok));
});

// 第二块守卫：模型把长块"翻成摘要"。2026-10-17 在 141 条库存译文上量到 4 块，全在同一篇 copernicus-gc
// 长文里，比值 0.035–0.125、结尾是「——」「，即」「以及」「表示：」——条数与占位符都对得上，所以既有的
// 结构守卫全部放行，读者拿到的是说到一半就没了的中文。
const LONG_EN = "The participatory process KlimaRhön aimed at identifying ways for adapting to climate change in the biosphere reserve Rhön in central Germany in the two stakeholder-selected problem fields water supply and land use, and the atlas was afterwards used by practitioners in three neighbouring districts during a series of workshops that ran over eleven months.";

test("长块只交出前半句 ⇒ 整块按没翻出来处理，宁可重问或保留原文，不发半句中文", () => {
  const s = shield(LONG_EN);
  assert.equal(unshield("参与式过程 KlimaRhön 旨在针对德国中部 Rhön 生物圈保护区由利益相关方选定的两个问题领域——", s), null, "以破折号收尾的半句");
  assert.equal(unshield("在浏览图集的地图视图时，用户可以选择不同的方式来展示不确定性，即", s), null, "以「即」收尾的半句");
  assert.equal(unshield("参与式过程 KlimaRhön 旨在针对德国中部两个问题领域，并且随后在三个相邻区县的工作坊里被实践者使用", s), null, "没有句末标点也算没说完");
});

test("原文啰嗦、译文本来就短不是缺陷：德语那种压到两成的整句照单入库", () => {
  // 实测：destatis 那条 297 字德文压成 58 字中文（比值 0.195），内容是全的，只是以句号收尾。
  const s = shield("Bei den Ergebnissen zur Kartoffelernte handelt es sich um vorläufige Ergebnisse fur 2026. Die Ergebnisse zu den Anbauflachen von Kartoffeln stammen aus der Erhebung der Bodennutzung landwirtschaftlicher Erzeugnisse. Die Ergebnisse zur Erntemenge stammen aus der Sondererhebung Ernte- und Qualitatsermittlung.");
  const ok = unshield("马铃薯收成结果为 2026 年的初步结果。种植面积结果源自农业经营土地利用调查。产量结果源自特殊收成与质量测定。", s);
  assert.ok(ok, "结尾是句末标点就不该被长度这一条判死");
});

// 空括号这一条原来判"括号里没有字母和数字"，公式里的 f(⋅) 因此被当成被掏空的引用。
// 这一族在 Nature 系正文里成段出现（$…$ 与 (6) 同屏），收紧成"只剩分隔符"后两边都对。
test("公式里的括号不是被掏空的引用：f(⋅) 与带编号的 (6) 同屏时照单入库", () => {
  const s = shield("The likelihood is L(w) = prod f(Y_j | w), see equation (6) where f denotes a density.");
  const ok = unshield("似然为 L(w) = prod f(Y_j | w)，见公式（6），其中 f（⋅）表示概率密度函数。", s);
  assert.ok(ok, "（⋅）里是非字母符号，不是被丢掉的引用编号");
});

