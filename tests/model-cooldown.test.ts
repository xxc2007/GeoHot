import assert from "node:assert/strict";
import { test } from "node:test";
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
