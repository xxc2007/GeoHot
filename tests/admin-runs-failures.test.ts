// 后台那一行绿色，不代表这一轮的报纸都出来了。
//
// `job_runs.status` 记的是"任务跑完了没有"：`catchUpReports` 某一期失败只把它写进返回值的 `failed`，
// 运行本身是成功的，于是状态是 `ok`、`error` 是空的，名单只活在 `detail` 那一列里。而 `/admin/runs`
// 的两个视图（每个任务最新一次、最近 80 次）原来都不读 `detail`——站长补刊那几天正好撞上这个盲区：
// catch-up 整小时都排不出期次时，后台看起来一切正常。
//
// 修法只有一处：查询把 `detail->failed` 提成 `failures` 列，前端在状态徽标旁边摊开它。这里钉三件事：
// 名单读得出来；没有 `failed` 的运行读成 null；`failed` 是别的形状（数字、空数组）时不能让整页查询炸掉
// ——同一张表里躺着的是所有定时任务的返回值，这一列不是只有日报管道在写。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runsOverview } from "@aihot/backend/admin/runs";
import { tag } from "./setup.ts";

const T = tag();
const JOB = `test-runs-${T}`;
const insert = (detail: unknown) =>
  sql`INSERT INTO job_runs (job, status, detail) VALUES (${JOB}, 'ok', ${sql.json(detail as never)}) RETURNING id`;
// `jobs` 是 DISTINCT ON (job) 按 started_at 取最新一次，所以每插一行就重新读一次。
const latest = async () => (await runsOverview()).jobs.find((j) => j.job === JOB);

after(async () => {
  await sql`DELETE FROM job_runs WHERE job = ${JOB}`;
  await closeDb();
});

test("一轮跑完但期次没排出来，后台那一行要说得出是哪几期", async () => {
  await insert({ generated: ["daily:2026-01-05"], failed: ["daily:2026-01-06: 模拟失败", "weekly:2026-W03: 另一笔"] });
  const row = await latest();
  assert.ok(row, "这一轮没出现在后台的任务列表里");
  assert.equal(row.status, "ok", "运行本身确实完成了——这条钉的是状态不该被改成失败");
  assert.match(String(row.failures), /daily:2026-01-06: 模拟失败/, "失败名单没被提出来，操作员看到的就是一行绿色");
  assert.match(String(row.failures), /weekly:2026-W03/);
});

test("没有失败可说的运行读成空，别的形状不能让整页查询炸掉", async () => {
  for (const detail of [{ generated: [] }, { failed: 5 }, { failed: [] }, { failed: { daily: "x" } }]) {
    await insert(detail);
    const row = await latest();
    assert.equal(row!.failures, null, `${JSON.stringify(detail)} 不该读出一段失败文字`);
  }
});
