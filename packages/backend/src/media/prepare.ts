// Images of a newly selected item, prepared before readers arrive: every rendition its card and its
// page ask the image proxy for is fetched and resized once (a first reader otherwise waits seconds
// for the source site), animations are re-encoded, and after the release gate the share image is
// rendered before the content push makes chat apps fetch it.
import { convertAnimated, produceImage } from "./images.ts";
import { loadItemForMediaPreparation } from "../publication/detail.ts";
import { sql } from "../db.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { bodyMediaFingerprint, bodyMediaRequiredCondition } from "../publication/media-readiness.ts";

/** The (source, mode) pairs the proxy URLs in these public answers point at. */
export function proxiedRenditions(answers: unknown[]): Array<{ url: string; mode: string }> {
  const text = JSON.stringify(answers).replaceAll("&amp;", "&").replaceAll("\\u0026", "&");
  const seen = new Map<string, { url: string; mode: string }>();
  for (const m of text.matchAll(/\/api\/img-proxy\?u=([^&"\s\\]+)&mode=([a-z0-9-]+)/g)) {
    const url = decodeURIComponent(m[1]!);
    seen.set(`${m[2]}|${url}`, { url, mode: m[2]! });
  }
  return [...seen.values()];
}

export async function prepareArticleMedia(articleId: string, dependencies: {
  produce?: typeof produceImage; convert?: typeof convertAnimated;
} = {}): Promise<{ renditions: number; failed: number; animatedSaved: number; ready: boolean }> {
  const found = await loadItemForMediaPreparation(articleId);
  if (found.kind !== "found") return { renditions: 0, failed: 0, animatedSaved: 0, ready: false };
  // Older jobs can outlive a licence/body-mode change. Only media actually exposed by the
  // current reader projection is this job's work; hidden source HTML cannot demand a fetch.
  // Do not bless its raw fingerprint: if full text is later allowed, its images still need work.
  if (!found.detail.body && !found.detail.media?.length && !found.detail.x?.media.length) {
    return { renditions: 0, failed: 0, animatedSaved: 0, ready: true };
  }
  // The exact raw fields that generated these reader-body renditions, excluding every avatar/icon/OG.
  const row = found.row;
  const [input] = await sql<{ fingerprint: string; required: boolean }[]>`
    SELECT md5(jsonb_build_array(${row.article_revision}::int,${row.body_html ?? ""}::text,
      ${row.tr_revision === row.article_revision ? row.tr_html ?? "" : ""}::text,
      ${sql.json(row.preparation_media as Parameters<typeof sql.json>[0])}::jsonb,
      ${row.x_post?.media ? sql.json(row.x_post.media) : null}::jsonb)::text) AS fingerprint,
      ${bodyMediaRequiredCondition()} AS required
    FROM articles ready_a WHERE ready_a.id=${articleId}`;
  if (!input) return { renditions: 0, failed: 0, animatedSaved: 0, ready: false };
  const renditions = proxiedRenditions([found.detail.body, found.detail.media, found.detail.x?.media]);
  if (!input.required) return { renditions: 0, failed: 0, animatedSaved: 0, ready: true };
  let failed = renditions.length ? 0 : 1;
  let animatedSaved = 0;
  for (const { url, mode } of renditions) {
    try {
      const image = await (dependencies.produce ?? produceImage)(url, mode);
      if (image.type === "image/gif") animatedSaved += await (dependencies.convert ?? convertAnimated)(url, mode);
    } catch { failed += 1; }
  }
  const ready = await sql.begin(async tx => {
    // Lock before publishing and recheck the exact body: a slow image fetch cannot bless a newer HTML.
    await tx`SELECT id FROM articles WHERE id=${articleId} FOR UPDATE`;
    const [current] = await tx<{ fingerprint: string }[]>`SELECT ${bodyMediaFingerprint()} AS fingerprint FROM articles ready_a WHERE ready_a.id=${articleId}`;
    if (current?.fingerprint !== input.fingerprint) return false;
    const [previous] = await tx<{ fingerprint: string; ready: boolean }[]>`SELECT fingerprint,ready FROM article_media_readiness WHERE article_id=${articleId}`;
    await tx`INSERT INTO article_media_readiness(article_id,revision,fingerprint,ready,renditions,failed,attempted_at,prepared_at)
      VALUES(${articleId},${row.article_revision},${input.fingerprint},${failed === 0},${renditions.length},${failed},now(),CASE WHEN ${failed === 0} THEN now() END)
      ON CONFLICT(article_id) DO UPDATE SET revision=EXCLUDED.revision,fingerprint=EXCLUDED.fingerprint,
        ready=EXCLUDED.ready,renditions=EXCLUDED.renditions,failed=EXCLUDED.failed,attempted_at=EXCLUDED.attempted_at,prepared_at=EXCLUDED.prepared_at`;
    const wasReady = previous?.ready && previous.fingerprint === input.fingerprint;
    if ((failed === 0 && !wasReady) || (failed > 0 && wasReady)) {
      await publishArticleTx(tx, articleId, { refreshSelected: failed === 0, skipMediaPreparation: true });
    }
    return failed === 0;
  });
  return { renditions: renditions.length, failed, animatedSaved, ready: ready as boolean };
}

/**
 * Renders the article's share image through the local router, so it sits in the api's disk cache
 * before chat apps unfurl the pushed link. Best effort.
 */
export async function warmShareImage(articleId: string): Promise<boolean> {
  const base = process.env.LOCAL_ROUTER_URL || "http://127.0.0.1:3000";
  try {
    const res = await fetch(`${base}/og/items/${encodeURIComponent(articleId)}.png`, { signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}
