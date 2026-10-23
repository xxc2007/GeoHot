// Fill derived admin labels without rewriting receipts or keeping a long migration transaction open.
// Resume with the saved cursor, or --after=<id>. Never log provider requests or connection secrets.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.DATABASE_URL);
const databaseId = `${target.hostname}:${target.port}${target.pathname}`;
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const batch = Number(option("batch") ?? 25);
if (!Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error("--batch must be 1..1000");
const progressPath = path.resolve(option("progress") ?? ".data/admin-model-labels-progress.json");
let cursor = Number(option("after") ?? 0);
let inserted = 0;
if (option("after") === undefined) {
  try {
    const saved = JSON.parse(readFileSync(progressPath, "utf8"));
    if (saved.databaseId !== databaseId) throw new Error("saved progress belongs to another database; use a separate --progress path");
    cursor = saved.cursor;
    inserted = saved.inserted;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid backfill cursor");
const { sql, closeDb } = await import("@aihot/backend/db");
try {
  for (;;) {
    const result = await sql.begin(async db => {
      await db`SET LOCAL statement_timeout='5s'`;
      await db`SET LOCAL lock_timeout='250ms'`;
      await db`SET LOCAL max_parallel_workers_per_gather=0`;
      const ids = await db<{ id: number }[]>`SELECT id FROM receipts WHERE id>${cursor} ORDER BY id LIMIT ${batch}`;
      if (!ids.length) return null;
      const added = await db`
        INSERT INTO receipt_model_labels(receipt_id,purpose,service,prompt_version)
        SELECT r.id,r.purpose,r.service,r.request->>'promptVersion' FROM receipts r
        WHERE r.id=ANY(${ids.map(row => row.id)}::bigint[])
          AND NOT EXISTS(SELECT 1 FROM receipt_model_labels l WHERE l.receipt_id=r.id)
        ON CONFLICT(receipt_id) DO NOTHING
        RETURNING receipt_id`;
      return { cursor: ids.at(-1)!.id, added: added.length };
    });
    if (!result) break;
    cursor = result.cursor;
    inserted += result.added;
    mkdirSync(path.dirname(progressPath), { recursive: true });
    writeFileSync(progressPath + ".tmp", JSON.stringify({ databaseId, cursor, inserted, updatedAt: new Date().toISOString() }) + "\n");
    renameSync(progressPath + ".tmp", progressPath);
    console.log(`model labels: cursor=${cursor} inserted=${inserted} batchAdded=${result.added}`);
  }
  console.log(`model labels: complete cursor=${cursor} inserted=${inserted}`);
} finally {
  await closeDb();
}
