// 面板按「地名 · 公网 IP」认机器（2026-11-15 站长：不要 iZbp14vh9sicf5z7law47aZ 这种实例 id）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/routes/admin/server.tsx", import.meta.url), "utf8");
const beat = readFileSync(new URL("../../../packages/backend/src/operations/heartbeat.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../../../apps/api/src/routes/server-console.ts", import.meta.url), "utf8");

test("心跳自带机器名，面板优先用它", () => {
  assert.match(beat, /label: process\.env\.GEOHOT_HEARTBEAT_LABEL\?\.trim\(\) \|\| null/);
  assert.match(api, /label: typeof row\.value\?\.label === "string" \? row\.value\.label : null/);
  assert.match(page, /if \(label && label\.trim\(\)\) return label\.trim\(\);/);
});

test("每台已知机器都写着地名与公网 IP", () => {
  // 直接比字面量，不做正则拼接：CodeQL 会把「自己转义 . 」判成不完整转义（high）。
  for (const fragment of [
    'place: "Azure 主库", ip: "20.194.28.128"',
    'place: "杭州", ip: "47.97.97.62"',
    'place: "武汉", ip: "8.148.65.89"',
    'place: "华为云广州", ip: "113.45.66.100"',
  ]) {
    assert.ok(page.includes(fragment), `缺这一行：${fragment}`);
  }
});

test("标题里同时给地名和 IP，而不是只有实例 id", () => {
  assert.match(page, /\{place\(n\.host, s\.host, n\.label\)\}/);
  assert.match(page, /\{placeIp\(n\.host, n\.label\)\}/);
  assert.doesNotMatch(page, /title=\{\}/);
});
