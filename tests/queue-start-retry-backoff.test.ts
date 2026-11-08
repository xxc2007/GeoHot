// 2026-11-08 14:07：主库 I/O 打满时 pg-boss 的 start 抛连接超时，box 的执行器当场以 fatal 退出。
// 一台机器的瞬时超时不该变成重启风暴，重启本身又加重 I/O —— 所以起队列要退避重试。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.resolve(import.meta.dirname, "../apps/worker/src/main.ts"), "utf8");

test("执行器起队列失败会退避重试，而不是第一次超时就退出", () => {
  assert.match(source, /async function startQueue\(\)/);
  assert.match(source, /const boss = await initialized\(startQueue\(\)\);/);
  assert.match(source, /if \(stopping \|\| attempt >= 8\) throw error;/);
  // 停机信号仍然优先：正在收尾时不再等待重试
  assert.match(source, /const wait = Math\.min\(60_000, 5_000 \* attempt\);/);
});

test("重试期间不再直接调用 getBoss", () => {
  assert.doesNotMatch(source, /const boss = await initialized\(getBoss\(\)\);/);
});
