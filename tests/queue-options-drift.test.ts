// `QUEUE_OPTIONS` 是这个仓库里唯一的队列定义，但 pg-boss 的 `createQueue` 对一个已存在的队列是空操作
// （2026-10-05 实测：先以 retryLimit 4 建、再以 9 建，库里那行仍是 4，连 `updated_on` 都没动）。第二十四轮
// 把 `content.analyze` 的 `expireInSeconds` 从 600 提到 1500 时，这个空操作让改动只活在代码里——线上那一格
// 还是 600 秒，而一次开了思考的调用上限 240 秒，五个串起来就跑超，任务被判死再来一遍（同一条目花钱两次）。
// 现在 `ensureQueue` 自己把库里的行对齐代码：pg-boss 12 的 `updateQueue` 是逐列 COALESCE 的 UPDATE，
// 不重建队列，所以等待中的任务一条都不会掉；只有 `policy` 和 `partition` 它拒绝改（改了只能重建队列），
// 那两个留成警告。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureQueue, getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const PATCHABLE = "probe.queue-drift";
const UNUPDATABLE = "probe.queue-policy";
const REFUSES = "probe.queue-refuses";

const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]): void => {
  logged.push(args.map(String).join(" "));
};

function lineFor(name: string): Record<string, unknown> | null {
  const raw = logged.find((line) => line.includes(name));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

after(async () => {
  console.log = realLog;
  const boss = await getBoss().catch(() => null);
  if (boss) {
    await boss.deleteQueue(PATCHABLE).catch(() => {});
    await boss.deleteQueue(UNUPDATABLE).catch(() => {});
    await boss.deleteQueue(REFUSES).catch(() => {});
  }
  await stopBoss();
  await closeDb();
});

test("库里那一格与代码不一致时，ensureQueue 把它对齐，等待中的任务一条不掉", async () => {
  const boss = await getBoss();
  await boss.createQueue(PATCHABLE, { policy: "short", retryLimit: 1, expireInSeconds: 30 });
  await boss.send(PATCHABLE, { probe: true });

  await ensureQueue(PATCHABLE, { policy: "short", retryLimit: 4, expireInSeconds: 1500 });

  const stored = await boss.getQueue(PATCHABLE);
  assert.ok(stored);
  assert.equal(stored.retryLimit, 4, "重试次数按代码给的值落库（旧实现只打印一行警告，改动永远不生效）");
  assert.equal(stored.expireInSeconds, 1500, "过期时间同理——这一条就是本轮真正要修的东西");

  const jobs = await sql<{ id: string }[]>`SELECT id FROM pgboss.job WHERE name = ${PATCHABLE}`;
  assert.equal(jobs.length, 1, "对账不能把队列里等待的任务一起删掉（那正是删队列重建会做的事）");

  const line = lineFor(PATCHABLE);
  assert.ok(line, "动过共享状态要在日志里留一行");
  assert.equal(line.level, "info");
  assert.deepEqual(line.wanted, { retryLimit: 4, expireInSeconds: 1500 });
  assert.deepEqual(line.stored, { retryLimit: 1, expireInSeconds: 30 });
});

test("policy 改不了：不动库、也不假装改好了", async () => {
  const boss = await getBoss();
  await boss.createQueue(UNUPDATABLE, { policy: "standard", retryLimit: 2 });

  await ensureQueue(UNUPDATABLE, { policy: "short", retryLimit: 2 });

  const stored = await boss.getQueue(UNUPDATABLE);
  assert.equal(stored?.policy, "standard", "pg-boss 拒绝在队列建好后改 policy；硬塞给它只会让整个入队路径抛错");

  const line = lineFor(UNUPDATABLE);
  assert.ok(line, "这一类不一致必须有人看见");
  assert.equal(line.level, "warn");
  assert.deepEqual(line.wanted, { policy: "short" });
  assert.equal((line.stored as Record<string, unknown>).policy, "standard");
});

test("这一格没写成不等于这一条不能发：对齐失败只报，不把入队路径带下水", async () => {
  const boss = await getBoss();
  await boss.createQueue(REFUSES, { policy: "short", retryLimit: 1 });
  const real = boss.updateQueue.bind(boss);
  boss.updateQueue = (): never => {
    throw new Error("permission denied for table queue");
  };
  try {
    await ensureQueue(REFUSES, { policy: "short", retryLimit: 3 });
  } finally {
    boss.updateQueue = real;
  }

  const line = lineFor(REFUSES);
  assert.equal(line?.level, "warn", "写不进去要在日志里点名，否则线上看起来就像「改动没生效」");
  assert.match(String(line?.reason), /permission denied/);
  assert.equal((await boss.getQueue(REFUSES))?.retryLimit, 1, "原值不动");
});
