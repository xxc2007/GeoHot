// Re-run the writing step for items whose reader-facing copy is not Chinese yet.
//
// Why this needs a script instead of "just re-run the queue": `receipts` caches one answer per logical
// request, so an unchanged article gets the same answer back and nothing moves. This walks the same
// explicit-attempt path the admin's 「重跑分析」 uses (`attemptTag`), which is a genuinely new request —
// see docs/known-issues.md, 「要真重跑得让正文变 revision、在后台重跑分析（attemptTag 才是真新请求）」.
//
// The deployment's model is the local stub, so a re-run costs nothing; on a deployment with a paid model
// every re-run is a real request and this script must be used with the same care as the admin button.
//
// Run it as: DATABASE_URL=postgres://… node scripts/refill-copy.ts            # dry run（列出候选）
//             DATABASE_URL=postgres://… node scripts/refill-copy.ts --apply    # 入队重跑
//             … --ids id1,id2                                                    # 只重跑指定的条目
// It refuses --apply without --ids when more than 50 candidates match, so a wide sweep is a conscious act.
import { parseArgs } from "node:util";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { closeDb, sql } from "@aihot/backend/db";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    ids: { type: "string" },
    limit: { type: "string", default: "200" },
  },
});

const explicit = values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : null;
const limit = Number(values.limit);
// A reader-facing title without a single CJK character, but with enough Latin to be prose: that is copy
// nobody wrote for this site. (`original_title` keeps the source title; this checks the published one.)
const rows = explicit
  ? await sql<{ article_id: string; title: string }[]>`
      SELECT article_id, title FROM publications WHERE article_id = ANY(${explicit}::text[]) ORDER BY article_id`
  : await sql<{ article_id: string; title: string }[]>`
      SELECT article_id, title FROM publications
      WHERE title ~ '[A-Za-z]{3,}' AND title !~ ${CJK_COPY_PATTERN}
      ORDER BY published_at DESC NULLS LAST LIMIT ${limit}`;

console.log(`候选 ${rows.length} 条（标题里没有中文、但有拉丁字母）`);
for (const r of rows) console.log(`  ${r.article_id}  ${r.title.slice(0, 90)}`);

if (!values.apply) {
  console.log("\n（dry run：没有入队。要执行加 --apply；只重跑指定的条目加 --ids a,b,c）");
} else if (!rows.length) {
  console.log("\n没有需要重跑的条目。");
} else if (!explicit && rows.length > 50) {
  console.log(`\n候选超过 50 条（${rows.length}）：--apply 只在 --ids 指定具体条目时执行，避免一次扫全库。`);
  process.exitCode = 2;
} else {
  const runId = `refill-copy:${Date.now()}`;
  let queued = 0;
  for (const r of rows) {
    const job = await queueProcessing(r.article_id, { step: "analyze", attemptTag: runId });
    if (job) queued += 1;
  }
  console.log(`\n已入队 ${queued} 条分析（attemptTag=${runId}；分析成功后发布投影会自动更新标题与摘要）`);
  console.log("worker 跑完后核对：SELECT article_id, title FROM publications WHERE article_id = ANY(ARRAY[…]::text[])");
}

await stopBoss();
await closeDb();
