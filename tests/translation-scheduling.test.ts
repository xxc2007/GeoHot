import assert from "node:assert/strict";
import { test } from "node:test";
import { fairTranslationOrder, translationScope, type TranslationRank } from "../packages/backend/src/editorial/translation-scheduling.ts";

test("translation history cutoff is an inclusive Beijing day shared by both legs", () => {
  const scope = translationScope({ from: "2026-01-01" });
  assert.equal(scope.bodyFrom.toISOString(), "2025-12-31T16:00:00.000Z");
  assert.equal(scope.quoteFrom.getTime(), scope.bodyFrom.getTime());
  assert.equal(scope.historical, true);
  assert.throws(() => translationScope({ from: "2026-02-30" }), /valid YYYY-MM-DD/);
  assert.throws(() => translationScope({ from: "2026-13-01" }), /valid YYYY-MM-DD/);
  assert.equal(translationScope({ from: "2024-02-29" }).historical, true);
});

test("no explicit FROM retains separate rolling body30 / quote3 defaults", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const scope = translationScope({ from: "", bodyDays: "", quoteDays: "", now });
  assert.equal(scope.bodyFrom.toISOString(), "2026-09-19T12:00:00.000Z");
  assert.equal(scope.quoteFrom.toISOString(), "2026-10-16T12:00:00.000Z");
  assert.equal(scope.historical, false);
});

const ranks = (fresh: string[], short: string[], old = [...fresh].reverse()): TranslationRank[] =>
  fresh.map((article_id, i) => ({ article_id, by_fresh: i + 1, by_short: short.indexOf(article_id) + 1, by_old: old.indexOf(article_id) + 1 }));

test("fresh/short start interleaved, overlap is replenished and old history gets an early turn", () => {
  const rows = ranks(["new-long", "newer", "middle", "short", "old-long"], ["short", "middle", "newer", "new-long", "old-long"]);
  assert.deepEqual(fairTranslationOrder(rows, 4, false), ["new-long", "short", "newer", "middle"]);
  assert.deepEqual(fairTranslationOrder(rows, 3, true), ["old-long", "new-long", "short"]);
  assert.deepEqual(fairTranslationOrder(rows, 1, false), ["new-long"]);
  assert.deepEqual(fairTranslationOrder(rows, 1, true), ["old-long"]);
  assert.deepEqual(fairTranslationOrder(rows, 2, true), ["old-long", "new-long"]);
});

test("every overlap shape fills min(N, eligible) unique IDs, including complete overlap", () => {
  for (let count = 0; count <= 30; count++) {
    const ids = Array.from({ length: count }, (_, i) => `id${i}`);
    for (let rotate = 0; rotate < Math.max(count, 1); rotate++) {
      const rows = ranks(ids, [...ids.slice(rotate), ...ids.slice(0, rotate)]);
      for (const limit of [1, 2, 3, 7, 30]) for (const history of [false, true]) {
        const chosen = fairTranslationOrder(rows, limit, history);
        assert.equal(chosen.length, Math.min(count, limit));
        assert.equal(new Set(chosen).size, chosen.length);
      }
    }
  }
});
