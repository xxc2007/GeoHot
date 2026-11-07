// Round 22 审计批次的守卫：每条都钉住「2026-11-06 复核时为什么这么改」，避免下一轮被顺手改回去。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

test("归档主题仍能打开自己的页面，列表仍然不列它", () => {
  const source = read("packages/backend/src/publication/topics.ts");
  assert.match(source, /export async function listTopicSummaries\(now\?: Date, includeDormant = false\)/);
  assert.match(source, /topics\.filter\(\(t\) => includeDormant \|\| !t\.dormant_at\)/);
  // 页面必须能拿到归档主题，否则 0104 的「列表里没有、页面还在」就成了 404。
  assert.match(source, /const topics = await listTopicSummaries\(now, true\);/);
});

test("首屏预算不再许给读者八秒的空白", () => {
  const source = read("apps/web/app/lib/api.server.ts");
  const main = Number(source.match(/const SSR_BUDGET_MS = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  const aux = Number(source.match(/const SSR_AUX_BUDGET_MS = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  assert.ok(main > 0 && main <= 3_500, `first byte must not wait longer than 3.5s, got ${main}`);
  assert.ok(aux > 0 && aux <= 1_500, `auxiliary reads must not wait longer than 1.5s, got ${aux}`);
  assert.ok(aux < main, "配菜不能比首屏等得久");
});

test("精选那一段不再替看不到的收录池付一趟请求", () => {
  const source = read("apps/web/app/routes/home.tsx");
  const lines = source.split(String.fromCharCode(10));
  const poolIdx = lines.findIndex(l => l.includes("/api/site/pool") && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
  assert.ok(poolIdx > 0, "pool still loaded somewhere");
  // 2026-11-07：手机切「全部」是客户端换列表，所以条件从「只在 tab=all」放宽成
  // 「tab=all 或手机 UA」；判据改为「取数那一行的上一行（跳过注释）必须是条件本身」。
  let j = poolIdx - 1;
  while (j >= 0 && (lines[j].trim() === "" || (lines[j].trim().startsWith("//") || lines[j].trim().startsWith("*") || lines[j].trim().startsWith("/*")))) j -= 1;
  assert.ok(j >= 0 && lines[j].includes("tab === " + String.fromCharCode(34) + "all" + String.fromCharCode(34)), "pool 只在 tab=all（或手机 UA）时取，实际上一行是：" + (lines[j] ?? ""));
});

test("HTML 与错误页都带自己的安全头（CSP 不再只活在 nginx 片段里）", () => {
  const source = read("apps/web/server.ts");
  assert.match(source, /function applySecurityHeaders\(/);
  assert.match(source, /frame-ancestors 'none'; base-uri 'self'; object-src 'none'/);
  const calls = source.match(/applySecurityHeaders\(res\)/g) ?? [];
  assert.ok(calls.length >= 3, `expected at least three call sites, got ${calls.length}`);
  assert.match(source, /X-Frame-Options", "DENY/);
  assert.match(source, /Referrer-Policy", "strict-origin-when-cross-origin/);
});

test("池里那条 deepseek 说的是 3426 上真的存在的 id", () => {
  const source = read("packages/backend/src/providers/llm.ts");
  assert.match(source, /model: "workbuddy-ai\/deepseek-v4\.1-flash-sg"/);
  assert.doesNotMatch(source, /model: "workbuddy-ai\/deepseek-v4\.1-flash"/);
});

test("构建镜像不会把工作台目录与凭据一起 COPY 进去", () => {
  const source = read(".dockerignore");
  for (const entry of [".zcode", ".claude", ".mimosa", "_diag", "_archive", "_assist"]) {
    assert.ok(source.split(/\r?\n/).includes(entry), `${entry} must be ignored by docker build`);
  }
});