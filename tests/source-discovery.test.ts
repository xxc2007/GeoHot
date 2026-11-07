// Pure judgement tests: no DATABASE_URL, no setup.ts, no network. The gate is the only thing between a
// dead feed and the registry, so it is tested at its edges rather than through the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateLines,
  evaluateCandidate,
  feedLinksFromHtml,
  formatReviewNote,
  type DiscoveryItem,
} from "@aihot/backend/ingest/discovery";

const NOW = new Date("2026-11-08T00:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

/** Items newest-last on purpose: the verdict must look at every date, not at items[0]. */
function items(dates: Array<Date | null>): DiscoveryItem[] {
  return dates.map((publishedAt) => ({ publishedAt }));
}

const fresh = (count: number, ageDays = 1): DiscoveryItem[] =>
  items(Array.from({ length: count }, (_, index) => daysAgo(ageDays + index)));

test("0 条不算", () => {
  const verdict = evaluateCandidate({ items: [], httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "too-few-items");
  assert.equal(verdict.itemCount, 0);
  assert.equal(verdict.latest, null);
});

test("4 条不算", () => {
  const verdict = evaluateCandidate({ items: fresh(4), httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "too-few-items");
  assert.equal(verdict.itemCount, 4);
});

test("5 条但最新一条 31 天前不算", () => {
  const verdict = evaluateCandidate({ items: fresh(5, 31), httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "stale");
  assert.equal(verdict.itemCount, 5);
  assert.equal(verdict.ageDays, 31);
});

test("5 条且最新一条 3 天前通过", () => {
  const verdict = evaluateCandidate({ items: fresh(5, 3), httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, "ok");
  assert.equal(verdict.itemCount, 5);
  assert.equal(verdict.datedCount, 5);
  assert.equal(verdict.latest?.toISOString(), daysAgo(3).toISOString());
  assert.equal(verdict.ageDays, 3);
});

test("最新一条恰好 30 天仍在门槛内", () => {
  const verdict = evaluateCandidate({ items: fresh(5, 30), httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ageDays, 30);
});

test("非 2xx 先挡住，哪怕条目看起来新鲜", () => {
  const verdict = evaluateCandidate({ items: fresh(5, 1), httpStatus: 403, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "http");
  assert.match(formatReviewNote(verdict), /HTTP 403/);
});

test("条目全无日期时新鲜度不可判断，不放行", () => {
  const verdict = evaluateCandidate({ items: items([null, null, null, null, null]), httpStatus: 200, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-dated-items");
  assert.equal(verdict.itemCount, 5);
  assert.equal(verdict.datedCount, 0);
});

test("验证读数写清条数、最新日期与 HTTP 状态", () => {
  const verdict = evaluateCandidate({ items: fresh(6, 2), httpStatus: 200, now: NOW });
  const note = formatReviewNote(verdict);
  assert.match(note, /^通过：6 条/);
  assert.match(note, new RegExp(daysAgo(2).toISOString().slice(0, 10)));
  assert.match(note, /HTTP 200/);
});

test("页面声明的订阅地址按页面地址解析，非订阅 alternate 不要", () => {
  const html = `<head>
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://example.org/atom.xml">
    <link rel="alternate" type="application/json" href="/feed.json">
    <link rel="stylesheet" href="/site.css">
  </head>`;
  assert.deepEqual(feedLinksFromHtml(html, "https://example.com/news/"), [
    "https://example.com/feed.xml",
    "https://example.org/atom.xml",
  ]);
});

test("候选清单补协议、去重、跳过注释", () => {
  assert.deepEqual(candidateLines("# 手挑\nExample.com/feed/\nhttps://example.com/feed\n\nhttp://other.test/rss"), [
    "https://Example.com/feed/",
    "http://other.test/rss",
  ]);
});
