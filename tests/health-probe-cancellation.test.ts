// 2026-11-16 复审根因：/api/health 旧探针是 `sql`SELECT 1`` 套一个 2s Promise.race，
// 计时器只 reject JS 承诺，底层查询继续占着/排队占着池连接——楔死的机器上探针自己也堆叠，
// 成了第二个泄漏。2026-11-18 进一步：探针走独立闸（不碰读者闸），失败分类为
// gate_busy / query_timeout / conn_error / db_unavailable，响应带 reason 与 elapsed。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");
const readBudget = await readFile(new URL("../packages/backend/src/publication/read-budget.ts", import.meta.url), "utf8");

test("health 路由调用 dbHealthProbe，不再裸跑 SELECT 1 + 孤儿 race", () => {
  assert.match(app, /await dbHealthProbe\(\)/, "health 必须走有界探针");
  assert.match(app, /dbHealthProbe, HealthProbeError/, "路由要消费探针的结构化 reason");
  // 旧的孤儿 race 必须消失：不能再有 Promise.race 包住裸 sql`SELECT 1`。
  assert.doesNotMatch(app, /Promise\.race\(\[\s*sql`SELECT 1`/, "health 不能再用孤儿 Promise.race");
});

test("探针用独立 (1,0) 闸，与读者聚合闸隔离", () => {
  assert.match(readBudget, /const aggregates = new CapacityGate\(4, 8\)/, "读者闸是 4 槽 8 排队");
  assert.match(readBudget, /const healthGate = new CapacityGate\(1, 0\)/, "探针必须是独立 (1,0) 闸");
});

test("探针受闸截止时间约束，迟到拒绝被兜底，不把查询晾成 unhandled", () => {
  assert.match(readBudget, /const query = sql`SELECT 1`/);
  assert.match(readBudget, /timeoutMs: 2_500/, "探针有独立的墙钟截止时间");
  assert.match(readBudget, /void query\.catch\(/, "迟到的查询拒绝必须被兜底观察");
  // 探针查询本身不得被孤儿 race 包住；读者层的 race 只允许与 abortPromise 配对。
  assert.doesNotMatch(readBudget, /Promise\.race\(\[\s*sql`SELECT 1`/, "探针查询不得被孤儿 race 包住");
  // 不调用驱动 cancel：3.4.9 丢弃其内部取消承诺，reset 时会变成致命 unhandled rejection。
  const codeOnly = readBudget.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /query\.cancel\(\)/, "读者/探针路径不得调用驱动 cancel");
});

test("失败分类：57014 → query_timeout，连接级错误 → conn_error", () => {
  assert.match(readBudget, /code === "57014"/, "57014 按查询超时归类");
  assert.match(readBudget, /CONNECTION_CLOSED/, "连接关闭归入 conn_error");
  assert.match(readBudget, /conn_error/);
});

test("503 响应保留既有字段并带 reason / elapsed", () => {
  assert.match(app, /reply\s*\.code\(503\)/);
  assert.match(app, /header\("Retry-After", "5"\)/);
  assert.match(app, /db:\s*"unavailable"/);
  assert.match(app, /reason/, "响应必须带结构化 reason");
  assert.match(app, /elapsed/, "响应必须带 elapsed");
  assert.match(app, /ms:/, "既有 ms 字段保留兼容");
});
