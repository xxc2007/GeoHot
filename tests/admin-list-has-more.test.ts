// 「还有没有下一页」不能靠「这页满 N 条」推断：尾页正好满的时候，操作者点下一页会落到一张空表
// （2026-11-05 审计）。这里钉住 API 现在给出的答案：多取一行，再把多出来的那行切掉。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listFeedback } from "@aihot/backend/admin/feedback";
import { listSources } from "@aihot/backend/admin/sources";

after(closeDb);

test("a full last page still says there is no next page", async () => {
  // 一个只有这批行才有的前缀：测试库里的其它反馈不参与计数。
  const marker = `hasmore-${Date.now()}`;
  const total = 50;
  await sql`DELETE FROM feedback WHERE content LIKE ${`${marker}%`}`;
  for (let i = 0; i < total; i++) {
    await sql`INSERT INTO feedback (content, source_hash) VALUES (${`${marker} ${i}`}, ${`${marker}:${i}`})`;
  }
  try {
    const first = await listFeedback({ q: marker, page: 1 });
    assert.equal(first.rows.length, total, "第一页就是全部 50 条");
    assert.equal(first.hasMore, false, "整页满 50 条，但没有第 51 条 —— 下一页是空的");

    // 再塞一条，同一页就装不下了：这时 hasMore 必须为 true，且只返回 50 行。
    await sql`INSERT INTO feedback (content, source_hash) VALUES (${`${marker} extra`}, ${`${marker}:extra`})`;
    const again = await listFeedback({ q: marker, page: 1 });
    assert.equal(again.rows.length, total, "一页仍然只给 50 行");
    assert.equal(again.hasMore, true, "第 51 条确实存在");

    const second = await listFeedback({ q: marker, page: 2 });
    assert.equal(second.rows.length, 1);
    assert.equal(second.hasMore, false);
  } finally {
    await sql`DELETE FROM feedback WHERE content LIKE ${`${marker}%`}`;
  }
});

test("sources lists report the same answer from the same shape", async () => {
  const page = await listSources({ page: 1 });
  assert.ok(Array.isArray(page.rows));
  assert.equal(typeof page.hasMore, "boolean");
  // 一页最多 100 行：多取的那一行必须被切掉，不能多给后台一列。
  assert.ok(page.rows.length <= 100, `一页最多 100 行，实际 ${page.rows.length}`);
  if (page.rows.length < 100) assert.equal(page.hasMore, false);
});