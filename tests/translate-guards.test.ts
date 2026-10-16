// 译文入库前的两块"内容守卫"（纯函数，不碰库）。第一块是本轮新加的引用编号守卫。
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
