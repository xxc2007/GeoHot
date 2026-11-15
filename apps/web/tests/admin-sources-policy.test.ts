import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 站长 2026-11-15：信源总数 2000、正式 1000、备用 1000，并且要「能自己调」。
// 这几条钉住后台那条旋钮的存在与语义（目标只改 policy，不动信源本身）。
const route = readFileSync(new URL("../app/routes/admin/sources.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../../../apps/api/src/routes/admin.ts", import.meta.url), "utf8");
const backend = readFileSync(new URL("../../../packages/backend/src/admin/sources.ts", import.meta.url), "utf8");

test("后台信源页有『正式的采集目标』旋钮与原因输入", () => {
  assert.match(route, /新的正式采集目标/);
  assert.match(route, /name="target"/);
  assert.match(route, /name="expectedEnabled"/);
  assert.match(route, /name="reason"/);
});

test("保存走 policy 路由，不是逐条改信源", () => {
  assert.match(route, /adminPost\(request, "\/api\/admin\/sources\/policy"/);
  assert.match(api, /app\.post\("\/api\/admin\/sources\/policy"/);
  assert.match(api, /app\.get\("\/api\/admin\/sources\/policy"/);
});

test("后端只改 policy 并校验版本与原因", () => {
  assert.match(backend, /export async function sourceRegistryPolicy/);
  assert.match(backend, /setRegistryTarget\(parsed\.target, parsed\.expectedEnabled, actor, parsed\.reason\)/);
  assert.match(backend, /expectedEnabled: z\.number\(\)\.int\(\)\.positive\(\)/);
});

test("旋钮不能写成『直接 UPDATE sources』", () => {
  assert.doesNotMatch(backend, /UPDATE sources SET enabled=true[\s\S]{0,80}target_enabled/);
});
