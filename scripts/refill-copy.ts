// Re-run the writing step for items whose reader-facing copy is not Chinese yet.
//
// Why this needs a script instead of "just re-run the queue": `receipts` caches one answer per logical
// request, so an unchanged article gets the same answer back and nothing moves. This walks the same
// explicit-attempt path the admin's 「重跑分析」 uses (`attemptTag`), which is a genuinely new request —
// see docs/known-issues.md, 「要真重跑得让正文变 revision、在后台重跑分析（attemptTag 才是真新请求）」.
//
// The cost is whatever this deployment pays for: with MODEL_CALLS_ENABLED off (or a local stub behind
// LLM_BASE_URL) a re-run is free, but on a deployment wired to a real model every re-run is a real,
// metered request — 2026-10-06 起本站线上就是 Agnes，一次重跑约 5 个调用，所以这个脚本和后台那个
// 「重跑分析」按钮要按同一份小心使用（budgets 表会兜住速率，但兜不住你一次点 2000 条）。
//
// Run it as: DATABASE_URL=postgres://… node scripts/refill-copy.ts            # dry run（列出候选）
//             DATABASE_URL=postgres://… node scripts/refill-copy.ts --apply    # 入队重跑
//             … --ids id1,id2                                                    # 只重跑指定的条目
//             … --missing-summary --limit 50                                     # 换一类候选：有正文却没有中文摘要
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
    // Kebab on the command line, so the key is kebab too: parseArgs is strict here and would refuse
    // `--missing-summary` against a `missingSummary` key (measured the same minute it was written).
    "missing-summary": { type: "boolean", default: false },
  },
});

const explicit = values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : null;
const limit = Number(values.limit);
// A reader-facing title without a single CJK character, but with enough Latin to be prose: that is copy
// nobody wrote for this site. (`original_title` keeps the source title; this checks the published one.)
const rows = explicit
  ? await sql<{ article_id: string; title: string }[]>`
      SELECT article_id, title FROM publications WHERE article_id = ANY(${explicit}::text[]) ORDER BY article_id`
  : values["missing-summary"]
    // 另一类"还没有中文稿"：正文是有的、够长，但最近一次分析给不出中文摘要（`relevance='unknown'`）。
    // 2026-10-06 上午之前那批条目全卡在这里——那时编辑大脑还是本地 stub，它对"没有夹具的新华语长文"
    // 就回一个空壳（`title_zh:` 换行 `summary_zh:`）。换成真模型之后新条目不再这样，但存量不会自己重跑。
    ? await sql<{ article_id: string; title: string }[]>`
        SELECT article_id, title FROM (
          SELECT DISTINCT ON (an.article_id) an.article_id, a.title, a.discovered_at
          FROM analyses an JOIN articles a ON a.id = an.article_id
          WHERE an.relevance = 'unknown' AND a.processing_state = 'analyzed'
            AND a.body_text IS NOT NULL AND length(a.body_text) >= 150
          ORDER BY an.article_id, an.created_at DESC
        ) newest ORDER BY discovered_at DESC LIMIT ${limit}`
    : await sql<{ article_id: string; title: string }[]>`
        SELECT article_id, title FROM publications
        WHERE title ~ '[A-Za-z]{3,}' AND title !~ ${CJK_COPY_PATTERN}
        ORDER BY published_at DESC NULLS LAST LIMIT ${limit}`;

console.log(`候选 ${rows.length} 条（${explicit ? "指定条目" : values["missing-summary"] ? "有正文但没有中文摘要" : "标题里没有中文、但有拉丁字母"}）`);
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
