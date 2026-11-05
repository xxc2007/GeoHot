/**
 * 主题轮换与候选的人工入口。
 *
 * 定时任务在 `apps/worker/src/schedules.ts`（`topics.rotate` 每月 1 日 04:10、`topics.proposals` 每日 04:30）；
 * 这个脚本给运维一个不用等窗口的手动扳机，也让「部署完立刻看一次」不必重启 worker。
 *
 *   node --env-file-if-exists=.env scripts/topics-rotate.ts propose
 *   node --env-file-if-exists=.env scripts/topics-rotate.ts rotate
 */
import { closeDb } from "@aihot/backend/db";
import { proposeTopics, rotateTopics } from "@aihot/backend/publication/topic-rotate";

const mode = process.argv[2] ?? "propose";

try {
  if (mode === "rotate") {
    const result = await rotateTopics();
    console.log(JSON.stringify({ mode, ...result }));
  } else if (mode === "propose") {
    const proposals = await proposeTopics();
    console.log(JSON.stringify({ mode, candidates: proposals.length, top: proposals.slice(0, 10) }));
  } else {
    console.error(`unknown mode: ${mode}（propose | rotate）`);
    process.exitCode = 2;
  }
} finally {
  await closeDb();
}