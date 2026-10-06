// `getBoss()` 缓存的是"正在启动"的那个 promise。旧实现只在成功时清掉它，所以一次 `start()` 失败
// （数据库抖一下就够）之后，本进程每次入队都拿到同一个 rejection——而 `publishArticle` 是在业务事务里
// 入队的（selected 通知与媒体准备同一条 tx），后果是那次失败之后**每一条发布都回滚**，只能重启进程。
// 这条测试钉的就是"失败不被记住"：先让它真的失败一次，再把地址换回来，第二次调用必须成功。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const savedUrl = config.databaseUrl;

after(async () => {
  config.databaseUrl = savedUrl;
  await stopBoss();
  await closeDb();
});

test("一次 start 失败之后，下一次调用重新起，而不是重放那个失败", async () => {
  // 一个不会有人监听的端口：connect 立刻 ECONNREFUSED，不会把测试拖到超时。
  config.databaseUrl = "postgres://geohot:geohot@127.0.0.1:59999/geohot_test";
  await assert.rejects(() => getBoss(), "数据库连不上时这次调用要失败");

  config.databaseUrl = savedUrl;
  const boss = await getBoss();
  assert.ok(boss, "失败的 promise 被清掉之后，第二次调用真的重新起一个 pg-boss（旧实现在这里拿回同一个 rejection）");

  // 起了就要停干净：这个文件与同批测试共用一个数据库，boss 会占住 pgboss schema 的轮询连接。
  await stopBoss();
  const again = await getBoss();
  assert.ok(again, "stop 之后再取，仍然能起（缓存里没有留下上一生的引用）");
});
