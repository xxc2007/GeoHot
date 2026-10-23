// Fill derived admin labels without rewriting receipts or keeping a long migration transaction open.
// Resume with the saved cursor, or --after=<id>. Never log provider requests or connection secrets.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { retryModelLabelBatch } from "../packages/backend/src/admin/model-label-backfill.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.DATABASE_URL);
const databaseId = `${target.hostname}:${target.port}${target.pathname}`;
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
let batch = Number(option("batch") ?? 25);
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
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const transaction = <T>(work: (db: import("@aihot/backend/db").Tx) => Promise<T>) => sql.begin(async db => {
  await db`SET LOCAL statement_timeout='5s'`;
  await db`SET LOCAL lock_timeout='250ms'`;
  await db`SET LOCAL max_parallel_workers_per_gather=0`;
  return work(db);
}) as Promise<T>;
const report = (retry: number, size: number, code: string) => console.log(`model labels: retry=${retry}/5 cursor=${cursor} batch=${size} code=${code}`);
try {
  await retryModelLabelBatch(() => transaction(async db => {
    await db`INSERT INTO settings(key,value,updated_by) VALUES('admin.modelLabelsReady','false'::jsonb,'model-label-backfill')
      ON CONFLICT(key) DO UPDATE SET value='false'::jsonb,updated_by=EXCLUDED.updated_by,updated_at=now()`;
  }), batch, pause, report);
  let batches = 0;
  for (;;) {
    const attempt = await retryModelLabelBatch(size => transaction(async db => {
      const ids = await db<{ id: number }[]>`SELECT id FROM receipts WHERE id>${cursor} ORDER BY id LIMIT ${size}`;
      if (!ids.length) return null;
      const added = await db`
        INSERT INTO receipt_model_labels(receipt_id,purpose,service,prompt_version)
        SELECT r.id,r.purpose,r.service,r.request->>'promptVersion' FROM receipts r
        WHERE r.id=ANY(${ids.map(row => row.id)}::bigint[])
          AND NOT EXISTS(SELECT 1 FROM receipt_model_labels l WHERE l.receipt_id=r.id)
        ON CONFLICT(receipt_id) DO NOTHING
        RETURNING receipt_id`;
      return { cursor: ids.at(-1)!.id, added: added.length };
    }), batch, pause, report);
    batch = attempt.batch;
    const result = attempt.result;
    if (!result) break;
    cursor = result.cursor;
    inserted += result.added;
    mkdirSync(path.dirname(progressPath), { recursive: true });
    writeFileSync(progressPath + ".tmp", JSON.stringify({ databaseId, cursor, inserted, updatedAt: new Date().toISOString() }) + "\n");
    renameSync(progressPath + ".tmp", progressPath);
    if (++batches % 100 === 0) console.log(`model labels: cursor=${cursor} inserted=${inserted} batches=${batches}`);
    await pause(25);
  }
  await retryModelLabelBatch(() => transaction(async db => {
    // Never trust a supplied/saved cursor as proof of coverage. Check the complete ledger's ids.
    const [gap] = await db`SELECT 1 FROM receipts r WHERE NOT EXISTS
      (SELECT 1 FROM receipt_model_labels l WHERE l.receipt_id=r.id) LIMIT 1`;
    if (gap) throw new Error("model labels still have gaps; restart with --after=0");
    await db`UPDATE settings SET value='true'::jsonb,updated_at=now() WHERE key='admin.modelLabelsReady'`;
  }), batch, pause, report);
  console.log(`model labels: complete cursor=${cursor} inserted=${inserted}`);
} finally {
  await closeDb();
}
