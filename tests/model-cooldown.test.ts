import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "../packages/backend/src/db.ts";
import { ModelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

test("explicit quota/auth refusal closes that member immediately, with expiry and success recovery", () => {
  const cooldown = new ModelCooldown();
  cooldown.reject("provider", "limited", 429, '{"msg":"额度已用尽，请购买加量包"}', 100);
  assert.deepEqual([...cooldown.overlay(new Set(), 101)], ["provider|limited"]);
  assert.equal(cooldown.overlay(new Set(["other"]), 3_600_100).has("provider|limited"), false);
  const olderRequest = cooldown.begin();
  cooldown.reject("provider", "limited", 403, "forbidden", 4_000_000);
  cooldown.accept("provider", "limited", olderRequest);
  assert.equal(cooldown.overlay(new Set(), 4_000_001).size, 1, "an older in-flight success cannot erase a newer refusal");
  cooldown.accept("provider", "limited", cooldown.begin());
  assert.equal(cooldown.overlay(new Set(), 4_000_001).size, 0);
});

test("autoclaw quota wording (免费额度已用完) benches the member too", () => {
  // 2026-11-02 生产实测：autoclaw-cn 429「GLM-5.3 免费额度已用完,开通连续包月会员继续使用」——
  // 旧 matcher 只认「额度已用尽」，这扇门 2 小时 37 次全失败仍进不了一小时冷却。
  const cooldown = new ModelCooldown();
  cooldown.reject("autoclaw-cn", "zaicoding-glm53", 429,
    'HTTP 429: {"error":{"message":"AutoClaw: GLM-5.3 免费额度已用完,开通连续包月会员继续使用"}}', 100);
  assert.ok(cooldown.overlay(new Set(), 101).has("autoclaw-cn|zaicoding-glm53"));
});

test("gateway-side dead members are benched instead of burning a call every rotation", () => {
  // 2026-11-06 生产实测（6 小时失败数）：minimax-code-global 278 / minimax-code 95（都是
  // "account is signed out; sign in again"）、workbuddy 3065 通道 127（"request illegal"）、
  // qoder-cn/dfmodel 53（"unknown or disabled model"）。三族都是确定性拒绝，旧 matcher 一条都不认。
  const cooldown = new ModelCooldown();
  const cases = [
    ["minimax-code-global", "MiniMax Code (Global)", 'HTTP 502: {"error":{"message":"MiniMax Code (Global): this MiniMax Code (Global) account is signed out; sign in again"}}'],
    ["workbuddy", "hy3", 'HTTP 502: {"error":{"message":"workbuddy rejected (HTTP 403): {\\"code\\":11140,\\"msg\\":\\"request illegal\\"}"}}'],
    ["qoder-cn", "dfmodel", 'HTTP 400: {"error":{"code":null,"message":"Qoder CN: unknown or disabled model \\"dfmodel\\""}}'],
  ] as const;
  for (const [service, model, text] of cases) cooldown.reject(service, model, 502, text, 100);
  const benched = cooldown.overlay(new Set(), 101);
  assert.equal(benched.size, 3, "three dead members, three cooldowns");
  assert.equal(benched.has("minimax-code-global|MiniMax Code (Global)"), true);
  assert.equal(cooldown.overlay(new Set(), 100 + 3_600_000).size, 0, "an hour later they are retried once more");
});

test("ordinary rate/transport/output failures do not masquerade as an explicit quota wall", () => {
  const cooldown = new ModelCooldown();
  for (const [status, text] of [[429, "too many requests"], [429, "usage exceeds frequency limit"], [429, "您的使用量已超出频率限制"],
    [429, "API 速率限制"], [503, "busy"], [0, "timeout outcome unknown"], [200, "unusable output"]] as const) {
    cooldown.reject("provider", "model", status, text, 100);
  }
  assert.equal(cooldown.overlay(new Set(), 101).size, 0);
});

test("same-millisecond and backwards wall clocks cannot let an older request clear a newer refusal", () => {
  const cooldown = new ModelCooldown();
  const older = cooldown.begin();
  cooldown.reject("provider", "model", 429, "insufficient_quota", 100);
  cooldown.accept("provider", "model", older);
  assert.equal(cooldown.overlay(new Set(), 100).has("provider|model"), true);
  cooldown.reject("provider", "model", 429, "insufficient_quota", 90);
  cooldown.accept("provider", "model", older);
  assert.equal(cooldown.overlay(new Set(), 100).has("provider|model"), true);
});

test("a refusal survives the process: the next process reads the cooldown back", async () => {
  const { sql } = await import("../packages/backend/src/db.ts");
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
  const first = new ModelCooldown();
  await first.load();
  const now = Date.now();
  first.reject("agnes-cn", "restart-survivor", 429, '{"msg":"额度已用尽"}', now);
  assert.ok(first.overlay(new Set(), now + 1).has("agnes-cn|restart-survivor"));
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  const second = new ModelCooldown();
  await second.load();
  assert.ok(second.overlay(new Set(), now + 2).has("agnes-cn|restart-survivor"),
    "the hour-long refusal must not be forgotten by a restart");
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
});

test("flushNow writes the hour-long refusal before the process exits", async () => {
  // 2026-11-05：worker 一天被停/起六十多次，退出路径原先只 stopBoss + closeDb——
  // 最后一次 reject() 的冷却会跟着进程消失。flushNow 是退出路径上那一次显式落库。
  const { sql } = await import("../packages/backend/src/db.ts");
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
  const cooldown = new ModelCooldown();
  await cooldown.load();
  cooldown.reject("agnes-cn", "exit-flush", 402, "insufficient balance");
  await cooldown.flushNow();
  const [row] = await sql<{ value: { until: number } }[]>`
    SELECT value FROM settings WHERE key = 'model-cooldown.v1:agnes-cn|exit-flush'`;
  assert.ok(row?.value?.until, "flushNow must land the refusal without waiting for the debounce");
  assert.ok(row!.value.until > Date.now(), "the refusal it wrote must still be in the future");
  await sql`DELETE FROM settings WHERE key LIKE 'model-cooldown.v1:%'`;
});

after(closeDb);
