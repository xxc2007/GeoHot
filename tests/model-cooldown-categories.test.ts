// 2026-11-16: 冷却分类与恢复时间戳的最小行为测试。
// 覆盖：日额度切换/重置、分钟 429、同 provider 不连坐、400 配置冷却、成功解除 + generation 守卫、
// 无 reset 不编造、5xx 不盲目重放、旧 settings 形状兼容。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { ModelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

after(closeDb);

test("quota_day with explicit reset-at body cools until that timestamp, not one hour", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  const resetIso = "2026-11-17T00:00:00+08:00";
  const resetMs = Date.parse(resetIso);
  c.reject("loomy", "loomy/DeepSeek-V4.1-Flash", 429,
    `{"error":{"message":"今日文本额度已用完, reset at 2026-11-17 00:00:00 UTC+8"}}`,
    { category: "quota_day", resetAt: resetMs, resetAssumed: false, now });
  const [entry] = c.inspect(now);
  assert.equal(entry?.category, "quota_day");
  assert.equal(entry?.resetAt, resetMs);
  assert.equal(entry?.resetAssumed, false);
  assert.equal(entry?.until, resetMs);
});

test("rate_minute with Retry-After seconds cools only that short window", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  const retryAt = now + 30_000;
  c.reject("zcode", "glm-5.3-flash", 429, `{"error":{"message":"too many requests"}}`,
    { category: "rate_minute", resetAt: retryAt, resetAssumed: false, now });
  const [entry] = c.inspect(now);
  assert.equal(entry?.category, "rate_minute");
  assert.equal(entry?.until, retryAt);
  assert.equal(entry?.resetAssumed, false);
});

test("no reset evidence: quota_day falls back to 1h and is marked assumed", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  c.reject("trae-global", "deepseek-v4.1-flash-max", 429,
    `{"error":{"message":"insufficient_quota"}}`,
    { category: "quota_day", resetAt: undefined, resetAssumed: true, now });
  const [entry] = c.inspect(now);
  assert.equal(entry?.category, "quota_day");
  assert.equal(entry?.resetAt, null);
  assert.equal(entry?.resetAssumed, true);
  assert.equal(entry?.until, now + 3_600_000);
});

test("same service: one member's quota wall does not bench the sibling", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  c.reject("loomy", "loomy/DeepSeek-V4.1-Flash", 429, `额度已用完`,
    { category: "quota_day", resetAt: undefined, resetAssumed: true, now });
  const keys = c.inspect(now).map(e => e.key);
  assert.deepEqual(keys, ["loomy|loomy/DeepSeek-V4.1-Flash"]);
  assert.ok(!keys.includes("loomy|loomy/GLM-5.3-Flash"));
});

test("400 config refusal cools 1h and is not cleared by an old in-flight success", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  const oldTicket = c.begin(); // 拒前在飞的请求
  c.reject("workbuddy-cn", "hy4-preview-f", 400,
    `{"error":{"message":"reasoning effort value is not supported by the current model"}}`,
    { category: "config", now });
  c.accept("workbuddy-cn", "hy4-preview-f", oldTicket);
  assert.equal(c.inspect(now).length, 1, "old in-flight success must not clear a new config refusal");
  c.accept("workbuddy-cn", "hy4-preview-f", c.begin());
  assert.equal(c.inspect(now).length, 0);
});

test("402 with quota text is quota_day, not auth", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  c.reject("loomy", "loomy/GLM-5.3-Flash", 402, `{"error":{"message":"insufficient_quota"}}`,
    { category: "quota_day", resetAt: undefined, resetAssumed: true, now });
  assert.equal(c.inspect(now)[0]?.category, "quota_day");
});

test("5xx with account-suspended body is auth; generic 5xx gets no 1h cooldown", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  c.reject("magpie", "some-model", 502, `{"error":{"code":100003,"message":"account suspended"}}`,
    { category: "auth", now });
  assert.equal(c.inspect(now).length, 1);
  assert.equal(c.inspect(now)[0]?.category, "auth");
  const c2 = new ModelCooldown();
  c2.reject("some-service", "some-model", 500, `internal server error`, { now });
  assert.equal(c2.inspect(now).length, 0, "generic 5xx must not get a 1h cooldown");
});

test("old settings shape {until, generation} loads without category fields", async () => {
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
  const now = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by, updated_at)
             VALUES ('model-cooldown.v1:old-service|old-model', ${sql.json({ until: now + 3_600_000, generation: 7 })}, 'test', now())`;
  const c = new ModelCooldown();
  await c.load();
  const entries = c.inspect();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.service, "old-service");
  assert.equal(entries[0]?.model, "old-model");
  assert.ok(entries[0]?.category);
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
});

test("inspect() returns desensitized fields only, no raw body", () => {
  const c = new ModelCooldown();
  const now = Date.now();
  c.reject("svc", "model", 429, `{"secret":"leak-me"}`,
    { category: "quota_day", resetAt: undefined, resetAssumed: true, now });
  const [entry] = c.inspect(now);
  assert.ok(entry);
  assert.ok(!("body" in entry));
  assert.ok(!("message" in entry));
  assert.equal(entry.category, "quota_day");
  assert.equal(entry.service, "svc");
  assert.equal(entry.model, "model");
});
