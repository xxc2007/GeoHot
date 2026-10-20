// External collection reports (docs/sources.md). Same identity rules and timeline
// rule as every other entrance: old or future-dated items and explicit backfill never count as
// today's news and are never pushed. Unknown sources are created isolated, awaiting an operator.
// A report is answered with what it took and what it refused: an item this entrance cannot use
// (no title, no url, no address to normalise, a repeat inside the same call) is named back to the
// reporter, and last_ok_at moves only on a call that actually took something.
import { sql } from "../db.ts";
import { upsertMaterial,identityKeyFor } from "../content/materials.ts";
import {strongMaterialKeys,lockMaterialKeys} from '../content/material-identity.ts';
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { parsePublishedAt } from "../sources/dates.ts";
import { resolveIngestSource } from "../sources/registry.ts";

export const MAX_ITEMS = 50;

export class IngestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ItemIn {
  title?: unknown;
  url?: unknown;
  doi?: unknown;
  publishedAt?: unknown;
  author?: unknown;
  raw?: { _aihot?: { backfill?: boolean; baseline?: boolean } } & Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface IngestAnswer {
  ok: true;
  created: number;
  revised: number;
  /** Items this call could not use, with the index they came at: a 200 that dropped half the batch silently is what made a push look healthy. */
  skipped: Array<{ index: number; reason: string }>;
  quarantined?: number;
  sourceStatus?: "pending_review";
  submissionId?: number;
}

export async function ingestItems(body: unknown): Promise<IngestAnswer> {
  // Upstream #27: validate the whole request before anything is written. A malformed later item used to
  // leave earlier items stored *and* the source row's last_ok_at bumped — the push looked healthy while
  // half of it had been dropped. Per-item rejects are therefore counted and answered, not swallowed.
  if (!isObject(body)) throw new IngestError(400, "request body must be an object");
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (sourceId.length > 120) throw new IngestError(400, "sourceId exceeds 120 characters");
  let encoded: string;
  try { encoded = JSON.stringify(body); } catch { throw new IngestError(400, "request body must be JSON"); }
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) throw new IngestError(413, "request evidence exceeds 512 KiB");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) throw new IngestError(400, `items[${index}] must be an object`);
  }

  const resolution = await resolveIngestSource(sourceId, typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0,200) : sourceId, body);
  if (resolution.quarantined) return { ok: true, created: 0, revised: 0, skipped: [], quarantined: items.length, sourceStatus: "pending_review", submissionId: resolution.submissionId };
  return sql.begin(async tx => {
  const [source] = await tx<{ id: string; participation_mode: string; enabled: boolean; config: Record<string, unknown> }[]>`
    SELECT id,participation_mode,enabled,config FROM sources WHERE id=${sourceId} AND enabled FOR UPDATE`;
  // No row means the source exists and is paused: a push into a paused source must be refused, not
  // quietly accepted with its items stored (upstream b813579).
  if (!source) throw new IngestError(409, "source paused");

  const seen = new Map<string, number>();
  const skipped: IngestAnswer["skipped"] = [];
  let created = 0;
  let revised = 0;
  let quarantined = 0;
  // Shared URL identities can be delivered by different sources concurrently. Consistent identity
  // order prevents a multi-item transaction locking A/B while another locks B/A.
  const ordered = items.map((it,index) => ({ it,index,key: typeof it.url === "string" ? normalizeUrl(it.url.trim()) ?? "" : "" }))
    .sort((a,b) => a.key.localeCompare(b.key) || a.index-b.index);
  // A batch shares a transaction: acquire the complete strong-key set before its first item.
  await lockMaterialKeys(tx,ordered.flatMap(({it,key})=>{
    const m={sourceId:source.id,url:key,title:typeof it.title==='string'?it.title:'',doi:typeof it.doi==='string'?it.doi:undefined,via:'ingest' as const};
    return strongMaterialKeys(m,identityKeyFor(m));
  }));
  for (const {index,it} of ordered) {
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const rawUrl = typeof it.url === "string" ? it.url.trim() : "";
    if (!title || !rawUrl) {
      skipped.push({ index, reason: !title ? "missing title" : "missing url" });
      continue;
    }
    const url = normalizeUrl(rawUrl);
    if (!url) {
      skipped.push({ index, reason: "url is not a normalisable http(s) address" });
      continue;
    }
    const again = seen.get(url);
    if (again !== undefined) {
      skipped.push({ index, reason: `duplicate of items[${again}]` });
      continue;
    }
    seen.set(url, index);
    const res = await upsertMaterial({
      sourceId: source.id,
      url,
      title,
      doi:typeof it.doi==='string'?it.doi:undefined,
      observation:it,
      author: typeof it.author === "string" ? it.author.slice(0, 200) : null,
      // A number is a legal publishedAt (a collector's epoch), and an offset is what a zone-less
      // "2026-09-26 10:00" is read in: without one the item joined the wrong newspaper day.
      publishedAt: parsePublishedAt(it.publishedAt, {
        utcOffset: typeof source.config?.publishedAtUtcOffset === "string" ? source.config.publishedAtUtcOffset : null,
        dateOrder: typeof source.config?.publishedAtDateOrder === "string" ? source.config.publishedAtDateOrder : null,
      }),
      raw: it.raw ?? null,
      via: "ingest",
      backfill: it.raw?._aihot?.backfill ? "reported-backfill" : it.raw?._aihot?.baseline ? "reported-baseline" : null,
    }, tx);
    if(res.quarantined){quarantined++;skipped.push({index,reason:`material identity conflict ${res.conflictId}; evidence retained`});continue;}
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    if (res.created || res.revised) await queueProcessing(res.articleId, { db: tx });
  }

  // Nothing taken at all is a broken request, not a successful one: it says so instead of answering 200.
  // An item that reached the store unchanged (the same content pushed again) still counts as taken, so a
  // reporter retrying a batch is not told its push failed.
  const accepted = items.length - skipped.length;
  if (accepted === 0 && !quarantined) throw new IngestError(422, `no item could be stored: ${skipped.map((s) => `${s.index}: ${s.reason}`).join("; ").slice(0, 400)}`);
  if(accepted>0)await tx`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${source.id}`;
  await tx`
    INSERT INTO ingest_events (client, kind, status, summary)
    VALUES ('ingest-items', 'items', 'ok', ${tx.json({ sourceId: source.id, received: items.length, created, revised, skipped: skipped.length } as never)})`;
  return { ok: true, created, revised, skipped: skipped.sort((a,b) => a.index-b.index),...(quarantined?{quarantined}:{}) };
  });
}
