// 搜索并发闸门（`publication/pool.ts`）此前没有任何测试覆盖，而它是本站对机器流量的唯一上限：
// 超出的请求应当拿 503 + Retry-After，而不是把 /all 的浏览一起拖下水（文件头记着一次 NaN 让两道守卫
// 恒假的事故）。这里钉住它的三件事：名额满了排队、队满立刻 503、排上的最终真的被执行。
//
// 本轮修的是它的**交接**：`finally` 原先先 `running -= 1` 再唤醒等待者，被唤醒者要等一个微任务才把计数
// 加回去——在这中间到达的请求看到的是一个"看起来空着"的名额，于是上限是软的。现在名额随唤醒一起移交。
// 那个窗口只能从模块内部的微任务交错里踩到，测试无法从外面确定性地复现，所以这里钉的是可以确定的部分，
// 移交本身由这段并发断言守住：任何时刻真正在跑的请求数不超过上限。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";

const CAP = 2;
process.env.SEARCH_MAX_CONCURRENCY = String(CAP);
process.env.SEARCH_MAX_QUEUE = "2";
// 环境变量在模块载入时读一次（`config.positiveInt`），所以必须在设好之后才 import。
const { withSearchCapacity, SearchBusyError } = await import("@aihot/backend/publication/pool");

let active = 0;
let peak = 0;
/** 一次"搜索"：占用名额一小会儿，同时记录同时在跑的最大数量。 */
const search = () =>
  withSearchCapacity(async () => {
    peak = Math.max(peak, ++active);
    await delay(8);
    active -= 1;
    return "done";
  });

after(async () => {
  delete process.env.SEARCH_MAX_CONCURRENCY;
  delete process.env.SEARCH_MAX_QUEUE;
  // 闸门本身会开数据库连接（`withCustomPlans` 走默认池），不关掉的话测试进程不会退出。
  await closeDb();
});

test("名额用完就排队，队也用完立刻 503，而不是无限堆着", async () => {
  const running = [search(), search()];            // 占满 CAP 个名额
  const queued = [search(), search()];             // 正好把队排队列填满
  const overflow = await Promise.all([search(), search()].map((p) => p.then(() => "fulfilled" as const, (e: unknown) => e)));
  assert.ok(overflow[0] instanceof SearchBusyError && overflow[1] instanceof SearchBusyError, "队列已满：新请求当场被拒，不排队");
  assert.equal(overflow[0].retryAfter, 4, "拒的原因是 SearchBusyError + Retry-After（路由据此发 503）");
  assert.equal(overflow[1].retryAfter, 4, "两条都是");

  const results = await Promise.all([...running, ...queued]);
  assert.deepEqual(results, Array(4).fill("done"), "占名额的与排队的四条都真的执行完了");
  assert.ok(peak <= CAP, `同时在跑的搜索不超过 ${CAP}（实测峰值 ${peak}）`);
});

test("排队有截止时间：一直排不到就 503，而不是把请求无限堆着", async () => {
  // 名额被占满 3.4 秒（等待上限 3 秒），排队的请求必须超时被拒——这条路径的意义是：机器流量最多占用
  // 三个秒，之后就要么拿到名额要么收到 503，队列不会无限增长。
  const slow = [
    withSearchCapacity(async () => { await delay(3400); return "done"; }),
    withSearchCapacity(async () => { await delay(3400); return "done"; }),
  ];
  const queued = withSearchCapacity(async () => "done");
  const reason = await queued.catch((e: unknown) => e);
  assert.ok(reason instanceof SearchBusyError, "排不到名额的请求在等待上限处被拒，返回的是 SearchBusyError");
  assert.equal(reason.retryAfter, 4, "带 Retry-After（默认等待上限 3 秒 → 4 秒），机器侧的退避有依据");
  assert.deepEqual(await Promise.all(slow), ["done", "done"], "占名额的那两条不受影响");
  assert.ok(peak <= CAP, `整个过程中同时在跑的搜索不超过 ${CAP}（实测峰值 ${peak}）`);
});
