import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 2026-11-07 现场：1,851 条 `media.prepare` 失败，1,581 条的原因只有「1 rendition failure(s)」。
 * 源站瞬时的超时/防盗链被一次 catch 吞掉，没有重试也没有 URL，文章就永久停在「媒体未就绪」，
 * 读者永远看不到。当天 6 篇里 2 篇卡在这里，手工重跑同一个函数立刻 ready:true。
 */
const source = readFileSync(new URL("../packages/backend/src/media/prepare.ts", import.meta.url), "utf8");

test("each rendition gets three attempts with backoff before it counts as failed", () => {
  assert.match(source, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/, "rendition retry loop exists");
  assert.match(source, /attempt === 1 \? 300 : 1_200/, "backoff grows between attempts");
  assert.match(source, /if \(attempt === 3\) \{\s*\n\s*failed \+= 1;/, "only the last attempt counts as failed");
});

test("a failed rendition leaves a trace with the URL and the mode", () => {
  assert.match(source, /event: "rendition-failed"/, "structured failure log");
  assert.match(source, /url: url\.slice\(0, 200\)/, "the URL is recorded, truncated");
  assert.match(source, /mode,/, "the mode is recorded");
});
