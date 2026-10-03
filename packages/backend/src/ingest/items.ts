// External collection reports (docs/sources.md). Same identity rules and timeline
// rule as every other entrance: old or future-dated items and explicit backfill never count as
// today's news and are never pushed. Unknown sources are created isolated, awaiting an operator.
// A report is answered with what it took and what it refused: an item this entrance cannot use
// (no title, no url, no address to normalise, a repeat inside the same call) is named back to the
// reporter, and last_ok_at moves only on a call that actually took something.
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { parsePublishedAt } from "../sources/dates.ts";

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
}

export async function ingestItems(body: unknown): Promise<IngestAnswer> {
  // Upstream #27: validate the whole request before anything is written. A malformed later item used to
  // leave earlier items stored *and* the source row's last_ok_at bumped — the push looked healthy while
  // half of it had been dropped. Per-item rejects are therefore counted and answered, not swallowed.
  if (!isObject(body)) throw new IngestError(400, "request body must be an object");
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const items = Array.isArray(body.items) ? (body.items as ItemIn[]) : [];
  if (!sourceId || !items.length) throw new IngestError(400, "sourceId and items[] required");
  if (items.length > MAX_ITEMS) throw new IngestError(413, `items[] exceeds max ${MAX_ITEMS} per request`);
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) throw new IngestError(400, `items[${index}] must be an object`);
  }

  const [source] = await sql<{ id: string; participation_mode: string; enabled: boolean; config: Record<string, unknown> }[]>`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${sourceId.slice(0, 120)}, ${typeof body.sourceName === "string" && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : sourceId.slice(0, 120)},
            'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
    -- Touching the row is what makes the enabled gate run; last_ok_at is only earned by items that were
    -- really taken, so a call that stored nothing does not look like a healthy fetch.
    ON CONFLICT (id) DO UPDATE SET updated_at = now() WHERE sources.enabled
    RETURNING id, participation_mode, enabled, config`;
  // No row means the source exists and is paused: a push into a paused source must be refused, not
  // quietly accepted with its items stored (upstream b813579).
  if (!source) throw new IngestError(409, "source paused");

  const seen = new Map<string, number>();
  const skipped: IngestAnswer["skipped"] = [];
  let created = 0;
  let revised = 0;
  for (const [index, it] of items.entries()) {
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
      author: typeof it.author === "string" ? it.author.slice(0, 200) : null,
      // A number is a legal publishedAt (a collector's epoch), and an offset is what a zone-less
      // "2026-09-26 10:00" is read in: without one the item joined the wrong newspaper day.
      publishedAt: parsePublishedAt(it.publishedAt, { utcOffset: typeof source.config?.publishedAtUtcOffset === "string" ? source.config.publishedAtUtcOffset : null }),
      raw: it.raw ?? null,
      via: "ingest",
      backfill: it.raw?._aihot?.backfill ? "reported-backfill" : it.raw?._aihot?.baseline ? "reported-baseline" : null,
    });
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    if (res.created || res.revised) await queueProcessing(res.articleId);
  }

  // Nothing taken at all is a broken request, not a successful one: it says so instead of answering 200.
  // An item that reached the store unchanged (the same content pushed again) still counts as taken, so a
  // reporter retrying a batch is not told its push failed.
  const accepted = items.length - skipped.length;
  if (accepted === 0) throw new IngestError(422, `no item could be stored: ${skipped.map((s) => `${s.index}: ${s.reason}`).join("; ").slice(0, 400)}`);
  await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${source.id}`;
  await sql`
    INSERT INTO ingest_events (client, kind, status, summary)
    VALUES ('ingest-items', 'items', 'ok', ${sql.json({ sourceId: source.id, received: items.length, created, revised, skipped: skipped.length } as never)})`;
  return { ok: true, created, revised, skipped };
}
