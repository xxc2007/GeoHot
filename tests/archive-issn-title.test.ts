// `scripts/archive-issn.ts` exists to stop the one archive mistake a reader can never see: an ISSN that was
// guessed instead of read publishes journal A's articles under journal B's source name. Measured on production
// 2026-10-11 while widening the Jan–Sep archive, it produced two such proposals and called them `match`:
//
//   rss-jgr-biogeosciences-toc  -> 1726-4189  (that is Copernicus's *Biogeosciences*, owned by rss-copernicus-bg)
//   rss-jgr-solid-earth-toc     -> 1869-9510  (Copernicus's *Solid Earth*)
//
// Two separate holes let that through, and both are pinned here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { issnOf, issnsFromPack, latinTitle, normalize, ownerOfIssn } from "../scripts/archive-issn.ts";

test("带系列名的子刊不能被砍成同名的另一本期刊", () => {
  // The pack calls this source "JGR: Biogeosciences · 当期目录". The colon was not part of the Latin-run
  // character class, so the run broke at it and the longest survivor was "Biogeosciences" — a different
  // journal, with a different publisher, whose ISSN the script then offered as a clean `match`.
  assert.equal(latinTitle("JGR: Biogeosciences · 当期目录"), "JGR: Biogeosciences");
  assert.equal(latinTitle("JGR: Solid Earth · 当期目录"), "JGR: Solid Earth");
  assert.notEqual(normalize(latinTitle("JGR: Biogeosciences · 当期目录")!), normalize("Biogeosciences"),
    "子刊的名字若与 Copernicus 那本同名，就会被当成同一本期刊");
});

test("没有系列名前缀的刊名照旧取整段拉丁名", () => {
  assert.equal(latinTitle("Sedimentology（国际沉积学家协会会刊）· 当期目录"), "Sedimentology");
  assert.equal(latinTitle("International Journal of Climatology · 当期目录"), "International Journal of Climatology");
  assert.equal(latinTitle("地理学报 当期目录"), null, "全中文的名字交给人看，不许猜");
});

test("比较用的是整个词序列，省掉 of/and 会把两本刊并成一本", () => {
  assert.notEqual(normalize("International Journal of Climatology"), normalize("Journal of Climatology"));
  assert.equal(normalize("Sedimentology "), normalize("sedimentology"));
});

test("ISSN 的归属登记来自整包，而不只来自这一轮跑过的信源", () => {
  const pack = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
  const rows: Array<{ id: string; config: Record<string, unknown> }> = (Array.isArray(pack) ? pack : pack.sources)
    .map((s: { id: string; config?: Record<string, unknown> }) => ({ id: s.id, config: s.config ?? {} }));
  const owned = issnsFromPack(rows);
  assert.equal(owned.get("rss-copernicus-bg"), "1726-4189", "包里的登记本身就是这条判据的依据");
  assert.equal(ownerOfIssn(owned, "1726-4189", "rss-jgr-biogeosciences-toc"), "rss-copernicus-bg");
  assert.equal(ownerOfIssn(owned, "1726-4189", "rss-copernicus-bg"), null, "自己名下不算冲突");
  assert.equal(ownerOfIssn(owned, "0000-0000", "rss-jgr-biogeosciences-toc"), null);
});

test("一本期刊的印刷版与网络版两个 ISSN 是同一条记录，不是歧义答案", () => {
  assert.equal(issnOf({ title: "Sedimentology", ISSN: ["0037-0746", "1365-3091"] }), "0037-0746");
  assert.equal(issnOf({ title: "无 ISSN 的记录" }), null);
});
