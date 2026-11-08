// Daily housekeeping: expired leases, old run history and derived caches. The former stored_files
// block is gone with the table itself (migration 0101): nothing wrote that table, and its unlink
// path had no containment check — a legacy or polluted key with "../" would have deleted outside
// the data directory.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";

/** Derived caches (proxied images, share cards and posters) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

/**
 * Model receipts keep the full request/response JSON of every paid call: ~6 KB a row, 449k rows and
 * 2.7 GB on the primary by November 2026, and every status update wrote a heap+index page into that
 * table. Accounting only reads status, model, usage and cost, so a settled receipt loses its bodies
 * after a week. Failed and unknown rows keep theirs — those are exactly the ones an operator reads.
 *
 * Paged by id range, not by `ORDER BY id LIMIT n`: there is no index on (status, created_at), so the
 * ORDER BY form re-scanned the whole 2.7 GB heap for every batch. 2026-11-08 that turned a 207k-row
 * cleanup into a full-table scan per statement, and the `CREATE INDEX CONCURRENTLY` meant to fix it
 * had to be cancelled because the box was already at 99% I/O pressure. Id ranges walk the primary key
 * instead, one commit every 10k ids, so a batch reads kilobytes rather than gigabytes.
 */
const RECEIPT_PAYLOAD_KEEP_MS = 24 * 3600_000;

export async function pruneReceiptPayloads(now = new Date()): Promise<number> {
  // 2026-11-08 二改：一周太长。结清回执的正文只在「同一逻辑请求马上重试」时有复用价值，
  // 那发生在几分钟内；账单与成本都记在 usage/cost 列上，不依赖正文。留一天把稳态体积从
  // 7 天份砍到 1 天份，主库那块慢盘的写放大才会真正降下来。
  const cutoff = new Date(now.getTime() - RECEIPT_PAYLOAD_KEEP_MS);
  const span = 10_000;
  const [head] = await sql<{ max: string | null }[]>`SELECT max(id)::text AS max FROM receipts`;
  const top = Number(head?.max ?? 0);
  let total = 0;
  for (let from = 0; from <= top; from += span) {
    const rows = await sql<{ id: number }[]>`
      UPDATE receipts SET request = NULL, response = NULL
      WHERE id > ${from} AND id <= ${from + span}
        AND status = 'completed' AND created_at < ${cutoff}
        AND (request IS NOT NULL OR response IS NOT NULL)
      RETURNING id`;
    total += rows.length;
  }
  return total;
}

export async function dailyRetention(now = new Date()) {
  const leases = await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`;
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  const monthMs = 30 * 86400_000;
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  // Receipt bodies are the largest thing this box writes; see pruneReceiptPayloads.
  const prunedReceiptPayloads = await pruneReceiptPayloads(now);
  return { deletedLeases: leases.count, deletedJobRuns: runs.count, prunedCache, prunedReceiptPayloads };
}
