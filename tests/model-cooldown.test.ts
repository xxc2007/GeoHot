import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelCooldown } from "../packages/backend/src/operations/model-cooldown.ts";

test("explicit quota/auth refusal closes that member immediately, with expiry and success recovery", () => {
  const cooldown = new ModelCooldown();
  cooldown.reject("provider", "limited", 429, '{"msg":"额度已用尽，请购买加量包"}', 100);
  assert.deepEqual([...cooldown.overlay(new Set(), 101)], ["provider|limited"]);
  assert.equal(cooldown.overlay(new Set(["other"]), 3_600_100).has("provider|limited"), false);
  cooldown.reject("provider", "limited", 403, "forbidden", 4_000_000);
  cooldown.accept("provider", "limited", 3_999_999);
  assert.equal(cooldown.overlay(new Set(), 4_000_001).size, 1, "an older in-flight success cannot erase a newer refusal");
  cooldown.accept("provider", "limited", 4_000_001);
  assert.equal(cooldown.overlay(new Set(), 4_000_001).size, 0);
});

test("ordinary rate/transport/output failures do not masquerade as an explicit quota wall", () => {
  const cooldown = new ModelCooldown();
  for (const [status, text] of [[429, "too many requests"], [503, "busy"], [0, "timeout outcome unknown"], [200, "unusable output"]] as const) {
    cooldown.reject("provider", "model", status, text, 100);
  }
  assert.equal(cooldown.overlay(new Set(), 101).size, 0);
});
