// Resume a derived read model; never update or replay provider/billing rows.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { retryModelLabelBatch } from "../packages/backend/src/admin/model-label-backfill.ts";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.DATABASE_URL);
const databaseId = `${target.hostname}:${target.port}${target.pathname}`;
const progress = path.resolve(".data/admin-model-metrics-progress.json");
let cursor = 0;
try {
  const saved = JSON.parse(readFileSync(progress, "utf8"));
  if (saved.databaseId !== databaseId) throw new Error("progress database mismatch");
  cursor = saved.cursor;
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid cursor");
const { sql, closeDb } = await import("@aihot/backend/db");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const transaction = <T>(work: (db: import("@aihot/backend/db").Tx) => Promise<T>) => sql.begin(async db => {
  await db`SET LOCAL statement_timeout='5s'`;
  await db`SET LOCAL lock_timeout='250ms'`;
  return work(db);
}) as Promise<T>;
try {
  await transaction(async db => { await db`UPDATE settings SET value='false'::jsonb WHERE key='admin.modelMetricsReady'`; });
  let batch = 500, batches = 0;
  for (;;) {
    const attempt = await retryModelLabelBatch(size => transaction(async db => {
      const ids = await db<{ id: number }[]>`SELECT id FROM receipt_attempts WHERE id>${cursor} ORDER BY id LIMIT ${size}`;
      if (!ids.length) return null;
      await db`INSERT INTO admin_model_attempt_metrics(id,receipt_id,started_at,origin,model,status,latency_ms,tokens_in,tokens_out,cost,cost_basis,currency)
        SELECT id,receipt_id,started_at,origin,model,status,latency_ms,admin_metric_token_count(usage->'prompt_tokens'),
          admin_metric_token_count(usage->'completion_tokens'),cost,cost_basis,currency
        FROM receipt_attempts WHERE id=ANY(${ids.map(row => row.id)}::bigint[])
        ON CONFLICT(id) DO NOTHING`;
      return ids.at(-1)!.id;
    }), batch, pause, (retry, size, code) => console.log(`metrics retry=${retry} batch=${size} code=${code}`));
    batch = attempt.batch;
    if (attempt.result === null) break;
    cursor = attempt.result;
    mkdirSync(path.dirname(progress), { recursive: true });
    writeFileSync(progress + ".tmp", JSON.stringify({ databaseId, cursor }) + "\n");
    renameSync(progress + ".tmp", progress);
    if (++batches % 100 === 0) console.log(`metrics cursor=${cursor}`);
    await pause(25);
  }
  await transaction(async db => {
    const [gap] = await db`SELECT 1 FROM receipt_attempts a WHERE NOT EXISTS(SELECT 1 FROM admin_model_attempt_metrics m WHERE m.id=a.id) LIMIT 1`;
    if (gap) throw new Error("metrics gap remains; reset only derived progress before resuming");
    await db`UPDATE settings SET value='true'::jsonb,updated_at=now() WHERE key='admin.modelMetricsReady'`;
  });
  console.log(`metrics complete cursor=${cursor}`);
} finally { await closeDb(); }
