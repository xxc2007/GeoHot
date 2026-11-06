import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("apps/worker/src/schedules.ts", "utf8");

/**
 * 2026-11-07 01:0x 现场：`cron.sources.schedule` 在 pgboss 里 active 了 57 分钟、
 * `cron.sources.reserves` 55 分钟、`cron.stories.status` 45 分钟，而 postgres 里
 * 一条对应查询都没有 —— 认领它们的 worker 早就不在了。默认 `expireInSeconds: 3600`
 * 让 singleton 队列整整一小时不再跑：那一小时里没有任何新信源被排期。
 */
test("minute-cadence schedules expire long before an hour", () => {
  const minute = /cron: "\* \* \* \* \*"[^}]*expire: (\d+)/g;
  const seen: number[] = [];
  for (const match of src.matchAll(minute)) seen.push(Number(match[1]));
  assert.ok(seen.length >= 2, "分钟级调度必须显式给 expire");
  for (const seconds of seen) assert.ok(seconds <= 300, `分钟级调度 expire 太长：${seconds}`);
});

test("default expiry is capped well below the old hour", () => {
  assert.match(src, /const DEFAULT_SCHEDULE_EXPIRE = (\d+);/);
  const value = Number(/const DEFAULT_SCHEDULE_EXPIRE = (\d+);/.exec(src)![1]);
  assert.ok(value <= 900, `默认过期时间太长：${value}`);
  assert.match(src, /expireInSeconds: s\.expire \?\? DEFAULT_SCHEDULE_EXPIRE/);
  assert.ok(!/expireInSeconds: s\.expire \?\? 3600/.test(src), "不能退回硬编码 3600");
});

test("every fast schedule carries an explicit expiry", () => {
  for (const name of ["content.sweep", "content.translate", "hot.rank", "sources.schedule", "sources.reserves"]) {
    const line = src.split("\n").find(text => text.includes(`name: "${name}"`));
    assert.ok(line, `${name} 不见了`);
    assert.match(line!, /expire: \d+/, `${name} 缺 expire`);
  }
});
