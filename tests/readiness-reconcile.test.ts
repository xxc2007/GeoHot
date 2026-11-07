import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

// 2026-11-07：404 篇公开文章没有就绪行，读者面一整天只停在凌晨那几条，而日志里一条错误都没有。
// 那次是手工补的；这几条断言把「补」变成例行任务，并且要求它边界清楚。
test("就绪行自愈只挑缺行的公开文章", async () => {
  const text = await source("packages/backend/src/publication/readiness-reconcile.ts");
  assert.match(text, /from publications p/);
  assert.match(text, /p\.visibility = 'public'/);
  assert.match(text, /not exists \(\s*select 1 from article_workflow_readiness/);
  assert.match(text, /refreshWorkflowReadinessTx\(tx, row\.article_id\)/);
});

test("自愈是幂等的事实重算，不发模型、不改发布状态", async () => {
  const text = await source("packages/backend/src/publication/readiness-reconcile.ts");
  assert.doesNotMatch(text, /enqueue\(/);
  assert.doesNotMatch(text, /callModel/);
  assert.doesNotMatch(text, /update publications/);
});

test("定时任务每十分钟跑一次，过期上限与其它分钟级任务同档", async () => {
  const text = await source("apps/worker/src/schedules.ts");
  assert.match(text, /name: "content\.readiness", cron: "\*\/10 \* \* \* \*", expire: 300, run: \(\) => reconcileReadiness\(\)/);
  assert.match(text, /import \{ reconcileReadiness \} from "@aihot\/backend\/publication\/readiness-reconcile";/);
});

test("缺口清零时巡检不出声，有缺口才写日志", async () => {
  const text = await source("packages/backend/src/publication/readiness-reconcile.ts");
  assert.match(text, /if \(refreshed > 0 \|\| failed > 0 \|\| count > 0\) \{/);
  assert.match(text, /missingAfter: count/);
});
