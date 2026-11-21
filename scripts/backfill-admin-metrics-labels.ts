// Fill the denormalized service/purpose columns of admin_model_attempt_metrics from
// receipt_model_labels, in separately committed batches. 0127 的传播触发器只覆盖迁移之后的标签写入，
// 这个脚本只补历史缺口，不改回执/账单。Resume with the saved cursor, or --after=<id>.
// Never log provider requests or connection secrets.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { retryModelLabelBatch } from "../packages/backend/src/admin/model-label-backfill.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.DATABASE_URL);
const databaseId = `${target.hostname}:${target.port}${target.pathname}`;
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
let batch = Number(option("batch") ?? 25);
if (!Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error("--batch must be 1..1000");
// 进度文件路径固定在仓库 .data 下（没有任何可拼片段，无路径穿越面）；换库时 databaseId 守卫会拒绝
// 并提示删掉旧进度文件，不做 --progress 动态路径。
const progressPath = path.resolve(process.cwd(), ".data", "admin-metrics-labels-progress.json");
let cursor = Number(option("after") ?? 0);
let propagated = 0;
if (option("after") === undefined) {
  try {
    const saved = JSON.parse(readFileSync(progressPath, "utf8"));
    if (saved.databaseId !== databaseId) throw new Error("saved progress belongs to another database; delete the progress file or restart with --after=0");
    cursor = saved.cursor;
    propagated = saved.propagated;
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
const report = (retry: number, size: number, code: string) => console.log(`metrics labels: retry=${retry}/5 cursor=${cursor} batch=${size} code=${code}`);
try {
  await retryModelLabelBatch(() => transaction(async db => {
    await db`INSERT INTO settings(key,value,updated_by) VALUES('admin.modelMetricsLabelsReady','false'::jsonb,'metrics-label-backfill')
      ON CONFLICT(key) DO UPDATE SET value='false'::jsonb,updated_by=EXCLUDED.updated_by,updated_at=now()`;
  }), batch, pause, report);
  let batches = 0;
  for (;;) {
    const attempt = await retryModelLabelBatch(size => transaction(async db => {
      const ids = await db<{ id: number }[]>`SELECT id FROM receipts WHERE id>${cursor} ORDER BY id LIMIT ${size}`;
      if (!ids.length) return null;
      // 0127 的 receipt_id 索引让每批只是几十次主键级定位；IS DISTINCT FROM 让重跑幂等（同值不重写行）。
      const moved = await db<{ id: number }[]>`
        UPDATE admin_model_attempt_metrics m SET service=l.service,purpose=l.purpose
        FROM receipt_model_labels l
        WHERE l.receipt_id=m.receipt_id AND m.receipt_id=ANY(${ids.map(row => row.id)}::bigint[])
          AND (m.service IS DISTINCT FROM l.service OR m.purpose IS DISTINCT FROM l.purpose)
        RETURNING m.id`;
      return { cursor: ids.at(-1)!.id, propagated: moved.length };
    }), batch, pause, report);
    batch = attempt.batch;
    const result = attempt.result;
    if (!result) break;
    cursor = result.cursor;
    propagated += result.propagated;
    mkdirSync(path.dirname(progressPath), { recursive: true });
    writeFileSync(progressPath + ".tmp", JSON.stringify({ databaseId, cursor, propagated, updatedAt: new Date().toISOString() }) + "\n");
    renameSync(progressPath + ".tmp", progressPath);
    if (++batches % 100 === 0) console.log(`metrics labels: cursor=${cursor} propagated=${propagated} batches=${batches}`);
    await pause(25);
  }
  await retryModelLabelBatch(() => transaction(async db => {
    // Never trust a supplied/saved cursor as proof of coverage. Check the complete ledger's rows:
    // every metrics row that has a label row must carry its service/purpose. 连标签行都没有的回执
    // 不归本脚本（那是 admin.modelLabelsReady 的业务），传播触发器会在标签落库时补上。
    const [gap] = await db`SELECT 1 FROM admin_model_attempt_metrics m
      JOIN receipt_model_labels l ON l.receipt_id=m.receipt_id
      WHERE m.service IS NULL LIMIT 1`;
    if (gap) throw new Error("metrics labels still have gaps; restart with --after=0");
    await db`UPDATE settings SET value='true'::jsonb,updated_at=now() WHERE key='admin.modelMetricsLabelsReady'`;
  }), batch, pause, report);
  console.log(`metrics labels: complete cursor=${cursor} propagated=${propagated}`);
} finally {
  await closeDb();
}
