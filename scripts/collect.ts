// Runs collection for given sources now (development / operations helper).
// 用法（sourceId 从 industry/sources.json 里挑，例如）：
//   node --env-file=.env scripts/collect.ts rss-nmc-alert web-mwr-news
//   阀门关着时要抓，必须显式加 --force-collect。
import { isCollectEnabled } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const args = process.argv.slice(2);
const force = args.includes("--force-collect");
const ids = args.filter((a) => a !== "--force-collect");

// 这个脚本带 `force: true`，绕过信源自己的调度时间；而采集阀门以前只在 worker 入口与看门狗里检查
// （`sources/collect.ts` 只看 source.enabled，force 连它也盖掉）。也就是说在 `.env`
// （COLLECT_ENABLED=false）下跑它，照样会真的向信源发请求——约束说的是"这个进程不出网"，不是"worker 不出网"。
if (!ids.length) {
  console.error("用法: node --env-file=.env scripts/collect.ts <sourceId> [sourceId…] [--force-collect]");
  process.exitCode = 2;
} else if (!isCollectEnabled() && !force) {
  console.error("COLLECT_ENABLED 是关的：这一步会向信源发出真实请求。确认要跑就加 --force-collect。");
  process.exitCode = 1;
} else {
  let missing = 0;
  for (const id of ids) {
    const started = Date.now();
    const r = await collectSource(id, { force: true });
    console.log(JSON.stringify({ ...r, ms: Date.now() - started }));
    // 认不出的 id 以前也照样 exit 0（status:"skipped"、error:"missing"），运营以为这一轮跑过了。
    if (r.status === "skipped" && r.error === "missing") missing += 1;
  }
  if (missing) {
    console.error(`${missing} 个 sourceId 在库里不存在，本次没有抓到它们`);
    process.exitCode = 1;
  }
}
await stopBoss();
await closeDb();
