// Retire the GDACS Green forest-fire template notices that are already in the database.
//
// Why this exists: the pre-filter (`industry/sources.json` → rss-gdacs-alerts →
// ingestNoiseFilter.dropMarkersTitleOnly) only stops *new* items from entering the pipeline. The 53
// notices that reached `eligible`/`public` before 2026-10-02 are still there, and seed is
// ON CONFLICT DO NOTHING, so editing the JSON changes nothing for them. This is the one-off cleanup:
// it flips `visibility` to 'withdrawn' (reversible — it does not delete rows, and the read layer
// already treats withdrawn citations as unreadable everywhere).
//
// Run it as: node scripts/retire-gdacs-green.ts                      # dry run, prints what it would do
//             node scripts/retire-gdacs-green.ts --apply --database-url=postgres://…
// It refuses to write without BOTH flags, refuses any title that is not the exact template, and prints
// every id it touches so the change can be reviewed afterwards.
import process from "node:process";
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbArg = args.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length)
  ?? process.env.DATABASE_URL;
if (!dbArg) {
  console.error("需要数据库地址：--database-url=… 或 DATABASE_URL（dry-run 也需要，它要读库）");
  process.exit(2);
}
if (apply && !args.some((a) => a.startsWith("--database-url="))) {
  // --apply against DATABASE_URL silently is how a dry run becomes a production change.
  console.error("--apply 必须显式给 --database-url=…（不接受从环境变量猜生产库）");
  process.exit(2);
}

const sql = postgres(dbArg, { max: 1 });
try {
  const rows = await sql<{ article_id: string; title: string; visibility: string; eligible: boolean }[]>`
    SELECT article_id, title, visibility, eligible
    FROM publications
    WHERE source_id = 'rss-gdacs-alerts'
      AND title LIKE 'Green forest fire notification in %'
    ORDER BY article_id`;
  console.log(`匹配 ${rows.length} 条（模板标题 'Green forest fire notification in …'）`);
  for (const r of rows) console.log(`  ${r.article_id}  ${r.visibility}/${r.eligible ? "eligible" : "not-eligible"}  ${r.title}`);
  const toRetire = rows.filter((r) => r.visibility === "public" || r.eligible);
  console.log(`其中 ${toRetire.length} 条当前可见或可入选；另有 ${rows.length - toRetire.length} 条已经不可见。`);

  if (!apply) {
    console.log("（dry run：没有写库。要执行请加 --apply --database-url=…）");
  } else if (!toRetire.length) {
    console.log("没有需要撤下的条目。");
  } else {
    const ids = toRetire.map((r) => r.article_id);
    await sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE publications SET visibility = 'withdrawn', eligible = false
        WHERE article_id = ANY(${ids}::text[])
        RETURNING article_id`;
      console.log(`已撤下 ${updated.length} 条（visibility='withdrawn'，未删除任何行，可逆）。`);
    });
  }
} finally {
  await sql.end();
}
