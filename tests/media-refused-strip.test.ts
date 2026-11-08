import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyRenditionFailure } from "@aihot/backend/media/strip";

const source = readFileSync(new URL("../packages/backend/src/media/prepare.ts", import.meta.url), "utf8");

// 站长 2026-11-08 选 A：源站明确拒绝（403/404/410/451）的图跳过，其余真图照发；
// 超时这一类可恢复的失败仍然严格重试，一张都不跳。
test("源站拒绝与可恢复失败分开判", () => {
  for (const refused of ["upstream 403", "upstream 404", "upstream 410", "upstream 451"]) {
    assert.equal(classifyRenditionFailure(refused), "refused", refused);
  }
  for (const transient of ["The operation was aborted due to timeout", "upstream 500", "upstream 502", "fetch failed", "upstream 429"]) {
    assert.equal(classifyRenditionFailure(transient), "transient", transient);
  }
});

test("只有被拒绝的图进摘除名单，超时的一律保留", () => {
  assert.match(source, /const refusedUrls: string\[\] = \[\];/);
  assert.match(source, /if \(classifyRenditionFailure\(.*\) === "refused"\) refusedUrls.push\(url\);/);
  assert.match(source, /const strippedUrls = stripAll \? failedUrls : stripRefused \? refusedUrls : \[\];/);
});

test("摘掉拒绝图之后，剩下的可恢复失败仍然让这篇不就绪", () => {
  assert.match(source, /effectiveFailed = failed - strippedUrls\.length;/);
});
