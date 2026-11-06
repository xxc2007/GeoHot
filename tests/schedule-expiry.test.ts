import assert from "node:assert/strict";
import test from "node:test";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";

/** 2026-11-06：`topics.assign` 因为一次 `CONNECTION_CLOSED` 死在 `running`，
 * cron 队列又是 singleton + expireInSeconds:3600，于是它一小时不再跑、主题页三小时没更新。
 * 十分钟一次的活不该拿一小时的过期时间；这里钉住「它自己有更短的期限」，其余仍取默认。 */
test("十分钟级的定时任务有自己的过期时间，长周期任务沿用一小时默认", () => {
  const tenMinute = SCHEDULES.find((s) => s.name === "topics.assign");
  assert.equal(tenMinute?.cron, "*/10 * * * *");
  assert.equal(tenMinute?.expire, 300);

  const daily = SCHEDULES.find((s) => s.name === "topics.rotate");
  assert.equal(daily?.expire, undefined, "每天一次的任务不需要更短的期限");
});

test("过期时间不会被写成 0 或负数——那会让任务刚被领取就被判死", () => {
  for (const s of SCHEDULES) {
    if (s.expire === undefined) continue;
    assert.ok(Number.isFinite(s.expire) && s.expire >= 60, `${s.name} 的 expire 太小：${s.expire}`);
  }
});
