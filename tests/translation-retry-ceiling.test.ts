import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-11-07：翻译重试三次封顶、一进六小时冷却，当天 17 篇好稿被自己的规则锁住。
 * 这里钉住新语义：网络类失败只退五分钟，内容类失败才按次数算，上限六次。
 */
const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "packages/backend/src/editorial/translation-selector.ts"), "utf8");

test("attempt ceiling is six, and transport noise does not reach it", () => {
  assert.match(source, /export const TRANSLATION_ATTEMPT_CEILING = 6;/, "ceiling must be six");
  assert.match(source, /attempts>=\$\{TRANSLATION_ATTEMPT_CEILING\}/, "the terminal branch must read the constant");
  assert.doesNotMatch(source, /attempts>=3\b/, "no hard-coded three should survive");
});

test("transport failures back off for minutes, never for the six-hour wall", () => {
  const backoff = source.slice(source.indexOf("CASE WHEN t.outcome='failed'"), source.indexOf("ELSE interval '5 minutes' END"));
  assert.match(backoff, /TRANSLATION_TRANSPORT_ERROR.*interval '5 minutes'/, "transport branch comes first and is short");
  assert.ok(backoff.indexOf("interval '5 minutes'") < backoff.indexOf("interval '6 hours'"), "the six-hour branch must not catch transport errors");
  assert.match(source, /connect failed\|fetch failed\|ECONN\|CONNECT_TIMEOUT\|connection\.\*closed\|network\|HTTP \(429\|5\[0-9\]\{2\}\)/);
});

test("content refusals still stay terminal", () => {
  assert.match(source, /t\.outcome IN \('skipped','translated'\)/, "skipped/translated remain blocked for good");
  assert.match(source, /t\.outcome<>'partial'/, "partial batches may still be retried");
});