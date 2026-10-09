// Move the archive items that are already waiting up to the band new ones get queued at.
//
// jobs/content.ts now serves `backfill_reason = 'archive'` work between live work and late news. That only
// applies to jobs created after the change, and production had ~1,000 archive articles sitting in the -2 band
// behind a few thousand late-news items — the objective is the January-to-today papers, so leaving the rows
// where they are would mean waiting for the old ordering to drain first.
//
// pg-boss reads `priority` when it hands work out, so this is a plain update of waiting rows; nothing is
// re-sent and no job is created, which is why `singleton_key` dedupe and the receipt cache stay intact.
//
// `--promote=N` is the capacity dial, and it is a decision, not a cleanup. Measured 2026-10-10: the archive
// band sat at 1,790 waiting jobs and had been served zero in 45 minutes, while the live band itself grew
// from 145 to 156 waiting in the same window — the door is oversubscribed at both ends, so any share given
// to the backfill comes out of live freshness. Lifting N of the oldest archive jobs into the live band
// spends about N × 7 model calls of live capacity (≈ N/60 of an hour's successful calls); 0 leaves the
// ordering as the code sets it. Only the owner should move it.
//
//   node --env-file=.env scripts/rebalance-archive-queue.ts                       # what would move
//   node --env-file=.env scripts/rebalance-archive-queue.ts --apply --database-url=…
//   node --env-file=.env scripts/rebalance-archive-queue.ts --promote=200 --apply --database-url=…
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "database-url": { type: "string", default: "" },
    promote: { type: "string", default: "0" },
  },
});

if (values.apply && !values["database-url"]) {
  console.error("--apply 必须同时显式给出 --database-url=（与进程 DATABASE_URL 同一个库）");
  await closeDb();
  process.exit(2);
}
const targetOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "";
  }
};
if (values.apply && targetOf(values["database-url"]!) !== targetOf(String(process.env.DATABASE_URL ?? ""))) {
  console.error("--database-url 与进程正在用的库不是同一个，拒绝改队列。");
  await closeDb();
  process.exit(2);
}

const ARCHIVE_PRIORITY = -1;
const LIVE_PRIORITY = 0;
const promote = Math.max(0, Number(values.promote) || 0);
const queues = ["content.analyze", "content.extract-body"];

for (const name of queues) {
  const waiting = await sql`
    SELECT count(*)::int AS n FROM "pgboss"."job" j
     WHERE j.name = ${name} AND j.state = 'created' AND j.priority < ${ARCHIVE_PRIORITY}
       AND j.data ->> 'articleId' IN (SELECT id FROM articles WHERE backfill_reason = 'archive')`;
  const n = waiting[0]?.n ?? 0;
  console.log(`${name}: ${n} waiting archive jobs below the archive band`);
  if (n && values.apply) {
    const moved = await sql`
      UPDATE "pgboss"."job" j SET priority = ${ARCHIVE_PRIORITY}
       WHERE j.name = ${name} AND j.state = 'created' AND j.priority < ${ARCHIVE_PRIORITY}
         AND j.data ->> 'articleId' IN (SELECT id FROM articles WHERE backfill_reason = 'archive')
       RETURNING j.id`;
    console.log(`  moved ${moved.length} jobs to priority ${ARCHIVE_PRIORITY}`);
  }
}

if (promote) {
  const due = await sql`
    SELECT count(*)::int AS n FROM "pgboss"."job" j
     WHERE j.name = 'content.analyze' AND j.state = 'created' AND j.priority = ${ARCHIVE_PRIORITY}
       AND j.data ->> 'articleId' IN (SELECT id FROM articles WHERE backfill_reason = 'archive')`;
  console.log(`--promote=${promote}: ${due[0]?.n ?? 0} archive jobs available to lift into the live band`);
  if (promote > (due[0]?.n ?? 0)) console.log(`  只有这么多可提，剩下的按 -1 排队`);
  if (values.apply) {
    const lifted = await sql`
      UPDATE "pgboss"."job" j SET priority = ${LIVE_PRIORITY}
       WHERE j.id IN (
         SELECT j2.id FROM "pgboss"."job" j2
          WHERE j2.name = 'content.analyze' AND j2.state = 'created' AND j2.priority = ${ARCHIVE_PRIORITY}
            AND j2.data ->> 'articleId' IN (SELECT id FROM articles WHERE backfill_reason = 'archive')
          ORDER BY j2.created_on LIMIT ${promote})
       RETURNING j.id`;
    console.log(`  lifted ${lifted.length} of the oldest archive jobs to priority ${LIVE_PRIORITY}`);
  }
}

if (!values.apply) console.log("\n默认只报告不动队列；确认后用 --apply --database-url=…（改回原序只需把同一批行的 priority 设回 -2）。");
await closeDb();
