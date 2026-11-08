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
 * Batched, because one nightly pass must never hold a long transaction on the busiest table of an
 * 891 MB box.
 */
export async function pruneReceiptPayloads(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 86400_000);
  const batch = 2000;
  let total = 0;
  for (;;) {
    const rows = await sql<{ id: number }[]>`
      UPDATE receipts SET request = NULL, response = NULL
      WHERE id IN (
        SELECT id FROM receipts
        WHERE status = 'completed' AND created_at < ${cutoff}
          AND (request IS NOT NULL OR response IS NOT NULL)
        ORDER BY id
        LIMIT ${batch}
      )
      RETURNING id`;
    total += rows.length;
    if (rows.length < batch) break;
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
