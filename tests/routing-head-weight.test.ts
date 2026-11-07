import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { weightHead } from "../packages/backend/src/editorial/models.ts";

/** 2026-11-08：池首成员必须稳定拿到一半额度，否则「放第一位」只是摆设。 */
test("池首被补到不少于其余成员之和", () => {
  const spread = ["loomy", "dots", "hy3", "hy3", "hy3", "hy3"];
  const out = weightHead([...spread], "loomy");
  const head = out.filter((n) => n === "loomy").length;
  const others = out.length - head;
  assert.ok(head >= others, `head=${head} others=${others}`);
});

test("池首不在池里时不动", () => {
  const spread = ["dots", "hy3"];
  assert.deepEqual(weightHead([...spread], "loomy"), spread);
});

test("单成员池不动", () => {
  assert.deepEqual(weightHead(["hy3"], "hy3"), ["hy3"]);
});

test("按 id 取模后池首约占一半", () => {
  const spread = weightHead(["loomy", "dots", "hy3"], "loomy");
  let head = 0;
  for (let i = 0; i < 4000; i += 1) {
    const digest = createHash("sha256").update(`id-${i}`).digest("hex");
    if (spread[Number.parseInt(digest.slice(0, 8), 16) % spread.length] === "loomy") head += 1;
  }
  assert.ok(head / 4000 > 0.4, `share=${head / 4000}`);
});
