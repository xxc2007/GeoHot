// Cache invalidation for publication withdrawals and repairs.
//
// The 2026-11-16 incident: four polluted rows were flipped to visibility='summary-only' in the database,
// but readers on the ordinary URLs kept seeing the dirty page — the process MicroCache, the on-disk
// pool snapshots and the edge (s-maxage) all still held the old response. A cache-buster query string
// was the only way to hit 404. The write below only changes the DB; the readers must be told.
//
// This module is the single place that invalidates reader caches:
//   · process-local listeners (registered by the API routes: pool/timeline MicroCache, sitemap cache);
//   · a DB-stored epoch that list/detail ETags include, so once the edge revalidates it sees a new tag;
//   · a hook the repair script and admin review call after every visibility/body transition.
//
// It never calls a CDN vendor directly: the deployment runbook lists the exact URLs to purge at the edge.
import { sql, type Tx } from "../db.ts";

export type PurgeListener = (articleId: string | null) => void;

const listeners = new Set<PurgeListener>();

/** An API route registers its in-process caches here so a withdrawal can drop them immediately. */
export function onPublicationPurge(listener: PurgeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fire every registered listener. Safe to call with no article (drop all list caches). */
export function purgePublicationCaches(articleId: string | null = null): void {
  for (const listener of listeners) {
    try { listener(articleId); } catch { /* one bad listener must not block the others */ }
  }
}

const EPOCH_KEY = "publication.epoch";
let cachedEpoch: { n: number; at: number } | null = null;
const EPOCH_TTL_MS = 30_000;

/** Bump the epoch inside the same transaction as the visibility/body write. Call after commit. */
export async function bumpPublicationEpoch(tx: Tx, articleId: string): Promise<void> {
  await tx`INSERT INTO settings (key, value, updated_by)
    VALUES (${EPOCH_KEY}, ${tx.json({ at: new Date().toISOString(), articleId })}, 'repair-body')
    ON CONFLICT (key) DO UPDATE SET value = ${tx.json({ at: new Date().toISOString(), articleId })}`;
  cachedEpoch = null;
}

/** Current epoch (the last bump time), cached briefly in-process. List ETag prefixes include this. */
export async function publicationEpoch(): Promise<string> {
  const now = Date.now();
  if (cachedEpoch && now - cachedEpoch.at < EPOCH_TTL_MS) return String(cachedEpoch.n);
  const [row] = await sql<{ value: { at?: string } }[]>`SELECT value FROM settings WHERE key=${EPOCH_KEY}`;
  const at = row?.value?.at ?? "1970-01-01T00:00:00Z";
  cachedEpoch = { n: Date.parse(at), at: now };
  return String(cachedEpoch.n);
}

/** Best-effort purge the on-disk pool snapshots for the affected filter pages. */
export async function forgetPoolSnapshots(): Promise<void> {
  // The API route owns the snapshot directory; it registers a listener that clears its in-memory maps
  // and deletes `.data/pool-snapshot/*.json`. This module only coordinates.
  purgePublicationCaches(null);
}
