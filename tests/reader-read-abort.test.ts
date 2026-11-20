// 2026-11-18 回归（隔离库 geohot_test，不碰生产）：
//  1. 真实 PG 上探针正常返回，探针槽连续可用；
//  2. 读者读在外部预算 abort 后 best-effort cancel 挂起查询，槽位回收、后续读与裸 SELECT 都正常；
//  3. 对一个不可达端口做真实失败探针：失败不永久占槽，第二次探针仍能进入。
import "./setup.ts";
import assert from "node:assert/strict";
import postgres from "postgres";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { CapacityExceeded, CapacityGate } from "@aihot/backend/lib/capacity";
import { dbHealthProbe, PublicReadBusyError, withPublicRead } from "@aihot/backend/publication/read-budget";

after(async () => {
  await closeDb();
});

test("健康探针在隔离库上返回 ok，探针槽连续两次可用", async () => {
  const first = await dbHealthProbe();
  assert.equal(first.reason, "ok");
  const second = await dbHealthProbe();
  assert.equal(second.reason, "ok");
});

test("abort 挂起的读者读：快速翻成 busy，槽位回收，后续读与池连接正常", async () => {
  const controller = new AbortController();
  const pending = withPublicRead(
    async (tx) => {
      await tx`SELECT pg_sleep(5)`;
      return "should-not-return";
    },
    12_000,
    false,
    controller.signal,
  );
  await delay(80);
  controller.abort();
  const outcome = await pending.catch((e: unknown) => e);
  assert.ok(outcome instanceof PublicReadBusyError, `abort 必须翻成 PublicReadBusyError，got ${String(outcome)}`);

  // 槽位已回收：紧接着的一次读者读必须成功，不能被上一个挂起占住；
  // 这次读走自己的有界事务，成功即说明池连接已被重新取用/回收。
  const n = await withPublicRead(async (tx) => {
    const rows = await tx<{ n: number }[]>`SELECT 1 AS n`;
    return rows[0].n;
  });
  assert.equal(n, 1);
});

test("真实失败探针（不可达端口）不永久占槽，第二次仍能进入", async () => {
  const dead = postgres("postgres://geohot:geohot@127.0.0.1:5999/dead", {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 1,
    onnotice: () => {},
  });
  const gate = new CapacityGate(1, 0);
  const probe = () =>
    gate.run(
      () =>
        new Promise<void>((resolve, reject) => {
          const query = dead`SELECT 1`;
          // 兜底观察迟到拒绝；不调用驱动 cancel()（3.4.9 丢弃其内部取消承诺，reset 时会致命）。
          void query.catch(() => {});
          query.then(
            () => resolve(),
            (error: unknown) => reject(error),
          );
        }),
      { timeoutMs: 2_500 },
    );

  const first = await probe().catch((e: unknown) => e);
  assert.ok(first instanceof Error, "第一次探针按预期失败");
  const second = await probe().catch((e: unknown) => e);
  assert.ok(second instanceof Error, "第二次探针同样失败");
  assert.ok(!(second instanceof CapacityExceeded), "失败后槽位必须回收，第二次不得被闸挡住");

  await dead.end({ timeout: 5 });
});
