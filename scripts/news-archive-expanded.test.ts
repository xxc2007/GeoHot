import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pages, options, type ArchiveRule } from "./backfill-news.ts";

const rules: ArchiveRule[] = JSON.parse(await readFile(new URL("../industry/news-archives.json", import.meta.url), "utf8")).archives;
const o = options(["--from=2026-01-01", "--to=2026-10-10", "--max-pages=3"]);

test("verified Chinese archives use real home URL then page 2, never nonexistent index_1", () => {
  for (const id of ["cn-web-shanghai-news", "cn-web-guangzhou-government", "cn-web-shanghai-statistics"]) {
    const r = rules.find(r => r.sourceId === id)!;
    const urls = pages(r, o);
    assert.equal(urls[0], r.firstPageUrl);
    assert.match(urls[1]!, /index_2\.html$/);
    assert.match(urls[2]!, /index_3\.html$/);
    assert.ok(!urls.some(u => u.includes("index_1.html")));
  }
});

test("official zero-based international HTML page adapters retain verified publisher routes", () => {
  const expected = new Map([
    ["web-unfpa-news", "https://www.unfpa.org/news"],
    ["web-iom-news", "https://www.iom.int/news"],
    ["web-adb-news", "https://www.adb.org/news/releases"],
    ["web-eclac-news", "https://www.cepal.org/en/list/cepal_pr"],
  ]);
  for (const [id, base] of expected) {
    const rule = rules.find(r => r.sourceId === id)!;
    assert.deepEqual(pages(rule, o), [0, 1, 2].map(p => `${base}?page=${p}`));
    assert.deepEqual(rule.config, {});
  }
});

/**
 * The 2026-10-15 rules reuse each source's own listing selectors, so the only thing a rule carries is the
 * URL shape — and `firstPage` is the one number in it that fails *silently*: a value of 1 on a CMS whose
 * second page is `index_1.html` asks for `index_2.html` first, and the walk never revisits the page it
 * skipped. Measured on the collector: igsnrr's page 2 holds 20 dated rows that the off-by-one hid.
 */
test("the 2026-10-15 back-pagination rules walk every page from the first one", () => {
  const indexed = ["web-igsnrr-zhxw", "web-igsnrr-kyjz", "web-stats-latest", "web-mee-xwfb", "web-cgs-ddyw", "web-mwr-news", "web-yrcc-hhyw",
    "web-mem-press", "web-mem-yjglbgzdt", "web-mwr-sjzs", "web-ihns-news", "web-ciis-news", "cn-web-beijing-departments", "web-iap-kyjz",
    "web-cgs-xa-dwdt", "web-cgs-zz-tz", "web-cgs-drc-gg", "web-cgs-imr-xw", "web-cgs-igge-jryw", "web-cgs-qimg-tp", "web-cgs-gmgs-news",
    "web-cgs-ogs-dwdt", "web-cgs-hbgs-tz", "web-cgs-caggs-tp", "web-cgs-igeo-dwdt", "web-hwcc-slyw", "web-hwcc-lysl"];
  for (const id of indexed) {
    const rule = rules.find((r) => r.sourceId === id);
    assert.ok(rule, `missing rule for ${id}`);
    const [first, second] = pages(rule, o);
    assert.equal(first, rule.firstPageUrl, `${id}: the walk must start at the live listing`);
    assert.match(second!, /index_1\.(html|shtml)$/, `${id}: page two must be index_1, not index_2 (${second})`);
  }

  for (const id of ["web-pric-news", "web-ecmwf-news", "web-gmu-science-news"]) {
    const rule = rules.find((r) => r.sourceId === id)!;
    const [, second] = pages(rule, o);
    assert.equal(rule.firstPage, 1, `${id}: a query-string listing starts its second page at page=2`);
    assert.match(second!, /page=2(&|$)/, `${id}: expected ${second}`);
  }
});

