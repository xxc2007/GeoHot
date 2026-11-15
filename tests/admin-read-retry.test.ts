import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/* 后台读在慢盘上的容忍度：一次超时不再等于一次 503。
 * 现场是 2026-11-15 的真浏览器巡检，14 项里 /admin/settings 与 /admin/audit 都拿到 503，
 * 当时 io some avg10 42、语句超时 57014。这里用源码形状守住「超时后再试一次、第二次更宽」。 */
const source = readFileSync(new URL("../packages/backend/src/admin/admin-read.ts", import.meta.url), "utf8");

test("超时之后还有第二次机会，而不是直接报忙", () => {
  const start = source.indexOf("export async function adminReadOrBusy");
  assert.ok(start > 0, "adminReadOrBusy 不见了");
  const body = source.slice(start);
  const calls = body.match(/adminRead\(read,/g) ?? [];
  assert.equal(calls.length, 2, "应当是两次尝试：第一次默认上限、第二次更宽");
});

test("第二次把上限抬到 12 秒，且只在超时类错误上重试", () => {
  assert.match(source, /Math\.max\(timeoutMs, 12_000\)/);
  assert.match(source, /\["57014", "55P03"\]\.includes\(busyCode\(error\)\)/);
  // 非超时错误必须原样抛，不能被重试吞掉
  assert.match(source, /if \(!\["57014", "55P03"\]\.includes\(busyCode\(error\)\)\) throw error;/);
});

test("两次都超时才回落成原来那句提示", () => {
  assert.match(source, /后台读取暂时超时，请稍后刷新/);
  assert.match(source, /code: "ADMIN_READ_TIMEOUT"/);
});
