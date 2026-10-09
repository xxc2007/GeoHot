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
//   node --env-file=.env scripts/rebalance-archive-queue.ts                     # what would move
//   node --env-file=.env scripts/rebalance-archive-queue.ts --apply --database-url=…
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";

const { values } = parseArgs({
  options: { apply: { type: "boolean", default: false }, "database-url": { type: "string", default: "" } },
});

if (values.apply && !values["database-url"]) {
  console.error("--apply 必须同时显式给出 --database-url=（与进程 DATABASE_URL 同一个库）");
  await closeDb();
  process.exit(2);
}

const ARCHIVE_PRIORITY = -1;
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

if (!values.apply) console.log("\n默认只报告不动队列；确认后用 --apply --database-url=…（改回来只需把同一批行的 priority 设回 -2）。");
await closeDb();
