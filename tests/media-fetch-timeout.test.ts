import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaFetchTimeoutMs } from "@aihot/backend/media/images";

// 2026-11-08：欧洲机构图站从杭州取要 28–31 秒，20 秒上限把它们全判成失败。
test("默认二十秒，慢出口的机器可以调到四十五秒", () => {
  assert.equal(mediaFetchTimeoutMs(undefined), 20_000);
  assert.equal(mediaFetchTimeoutMs(""), 20_000);
  assert.equal(mediaFetchTimeoutMs("45000"), 45_000);
  assert.equal(mediaFetchTimeoutMs("120000"), 120_000);
});

test("写坏了回默认，不能被一个笔误设成零或者一天", () => {
  for (const bad of ["0", "-1", "abc", "4999", "120001", "1e5", "45 s"]) assert.equal(mediaFetchTimeoutMs(bad), 20_000, bad);
});

test("下限五秒是硬边界", () => {
  assert.equal(mediaFetchTimeoutMs("5000"), 5_000);
  assert.equal(mediaFetchTimeoutMs("5001"), 5_001);
});
