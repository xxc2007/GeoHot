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
