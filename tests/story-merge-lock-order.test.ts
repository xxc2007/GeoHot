// 合并两条故事时，锁的获取顺序必须与「谁合进谁」无关。
// 旧写法是两条 `FOR UPDATE`（先 from 再 into）：后台合并、grouping 的 consolidate 与
// redirectEmptiedStories 同时对 A→B 和 B→A 动手时，两笔事务各持一把锁等对方 —— PostgreSQL 40P01 死锁，
// 被选中的那一笔整笔回滚，于是「合并成功」的提示之后故事其实没合。
// 现在一次 `SELECT … WHERE id IN (a,b) ORDER BY id FOR UPDATE` 取锁，两个方向拿到同样的顺序。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { mergeStoryInto } from "@aihot/backend/events/merge";
import { stopBoss } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });

async function makeStory(title: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, status) VALUES (gen_random_uuid(), ${title}, 'active') RETURNING id`;
  return row!.id;
}

test("同一个 A→B 与 B→A 同时提交：不死锁，只有一笔生效", async () => {
  const a = await makeStory("并发合并用例 A");
  const b = await makeStory("并发合并用例 B");

  const settled = await Promise.allSettled([
    mergeStoryInto(a, b, "并发合并 A→B", "test:lead"),
    mergeStoryInto(b, a, "并发合并 B→A", "test:lead"),
  ]);

  const rejected = settled.filter((s) => s.status === "rejected");
  assert.deepEqual(rejected, [], `不允许有事务因死锁失败：${JSON.stringify(rejected.map((r) => String((r as PromiseRejectedResult).reason)))}`);

  const values = settled.map((s) => (s as PromiseFulfilledResult<{ moved: number } | null>).value);
  assert.equal(values.filter((v) => v !== null).length, 1, "两个方向只有一笔能合（另一笔看到对方已 merged_into）");

  const rows = await sql<{ id: number; merged_into: number | null }[]>`
    SELECT id, merged_into FROM stories WHERE id IN (${a}, ${b}) ORDER BY id`;
  const alive = rows.filter((r) => r.merged_into === null);
  assert.equal(alive.length, 1, "只剩一条存活的故事");
  assert.equal(rows.filter((r) => r.merged_into !== null).length, 1, "另一条指向存活者");

  await sql`DELETE FROM story_aliases WHERE story_id IN (${a}, ${b})`;
  await sql`DELETE FROM stories WHERE id IN (${a}, ${b})`;
});

test("已合并的目标不再被合并一次：返回 null，不留第二条别名", async () => {
  const a = await makeStory("二次合并用例 A");
  const b = await makeStory("二次合并用例 B");
  assert.ok(await mergeStoryInto(a, b, "第一次", "test:lead"));
  assert.equal(await mergeStoryInto(a, b, "同一个 from 再合一次", "test:lead"), null);
  const aliases = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM story_aliases WHERE public_id IN (SELECT public_id FROM stories WHERE id = ${a})`;
  assert.equal(aliases[0]!.n, 1, "别名只有一条");
  await sql`DELETE FROM story_aliases WHERE story_id = ${b}`;
  await sql`DELETE FROM stories WHERE id IN (${a}, ${b})`;
});
