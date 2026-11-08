// Images of a newly selected item, prepared before readers arrive: every rendition its card and its
// page ask the image proxy for is fetched and resized once (a first reader otherwise waits seconds
// for the source site), animations are re-encoded, and after the release gate the share image is
// rendered before the content push makes chat apps fetch it.
import { convertAnimated, produceImage } from "./images.ts";
import { loadItemForMediaPreparation } from "../publication/detail.ts";
import { sql } from "../db.ts";
import { stripImageSources } from "./strip.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { bodyMediaFingerprint, bodyMediaRequiredCondition } from "../publication/media-readiness.ts";

/** The (source, mode) pairs the proxy URLs in these public answers point at. */
export function proxiedRenditions(answers: unknown[]): Array<{ url: string; mode: string }> {
  const text = JSON.stringify(answers).replaceAll("&amp;", "&").replaceAll("\\u0026", "&");
  const seen = new Map<string, { url: string; mode: string }>();
  for (const m of text.matchAll(/\/api\/img-proxy\?u=([^&"\s\\]+)&mode=([a-z0-9-]+)/g)) {
    let url: string;
    try {
      url = decodeURIComponent(m[1]!);
    } catch {
      // 正文里出现被截断的百分号编码（`%zz`、`%E4`）时，跳过这一张而不是整篇抛 URIError：
      // 否则 prepareArticleMedia 每次重投都失败，这条目的图片永远是裂的。
      continue;
    }
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
  const failedUrls: string[] = [];
  for (const { url, mode } of renditions) {
    // 2026-11-07 现场：1,851 条 `media.prepare` 失败，其中 1,581 条的原因只有一句
    // 「1 rendition failure(s)」——源站瞬时的超时/防盗链被一次 catch 吞掉，既没有重试也没有 URL，
    // 那篇文章就永久停在「媒体未就绪」，读者永远看不到（当天 6 篇里有 2 篇卡在这里，
    // 手工重跑同一个函数立刻 ready:true）。取图是幂等的，值得当场再试两次。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const image = await (dependencies.produce ?? produceImage)(url, mode);
        if (image.type === "image/gif") animatedSaved += await (dependencies.convert ?? convertAnimated)(url, mode);
        break;
      } catch (error) {
        if (attempt === 3) {
          failed += 1;
          failedUrls.push(url);
          console.error(JSON.stringify({ level: 40, component: "media", event: "rendition-failed", articleId, mode, url: url.slice(0, 200), message: (error as Error)?.message ?? String(error) }));
        } else {
          await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 300 : 1_200));
        }
      }
    }
  }
  // 2026-11-08 现场：正文里的图一张都取不到时（源站在墙外、防盗链），整篇稿子会永远停在「媒体未就绪」，
  // 读者一条也看不到（当天 1,792 条 media.prepare 失败、只有 1,053 条成功）。取不到的图本来也显示不出来，
  // 所以把这几张 <img> 从正文（含中文译文）里摘掉，读者看到的就是一篇完整、没有坏图的稿子。
  // 严格模式（站长 2026-11-08）：默认不摘图——图取不到就继续重试，绝不拿「没有图的稿子」换读者。
  // 只有显式设 GEOHOT_MEDIA_STRIP_DEAD=1 才恢复 11-08 那次的兜底行为。
  const stripAll = process.env.GEOHOT_MEDIA_STRIP_DEAD === "1" && failed > 0 && failed === renditions.length;
  const ready = await sql.begin(async tx => {
    // Lock before publishing and recheck the exact body: a slow image fetch cannot bless a newer HTML.
    await tx`SELECT id FROM articles WHERE id=${articleId} FOR UPDATE`;
    let bless = input.fingerprint;
    let effectiveFailed = failed;
    if (stripAll) {
      const [article] = await tx<{ body_html: string | null }[]>`SELECT body_html FROM articles WHERE id=${articleId}`;
      const fromArticle = stripImageSources(article?.body_html ?? "", failedUrls);
      if (fromArticle.removed > 0) await tx`UPDATE articles SET body_html=${fromArticle.html} WHERE id=${articleId}`;
      const [translation] = await tx<{ body_html: string | null }[]>`
        SELECT body_html FROM translations WHERE article_id=${articleId} AND lang='zh' AND revision=${row.article_revision}`;
      const fromTranslation = stripImageSources(translation?.body_html ?? "", failedUrls);
      if (fromTranslation.removed > 0) {
        await tx`UPDATE translations SET body_html=${fromTranslation.html}
          WHERE article_id=${articleId} AND lang='zh' AND revision=${row.article_revision}`;
      }
      const removed = fromArticle.removed + fromTranslation.removed;
      if (removed > 0) {
        const [after] = await tx<{ fingerprint: string }[]>`SELECT ${bodyMediaFingerprint()} AS fingerprint FROM articles ready_a WHERE ready_a.id=${articleId}`;
        bless = after?.fingerprint ?? input.fingerprint;
        effectiveFailed = 0;
        console.error(JSON.stringify({ level: 40, component: "media", event: "media-stripped", articleId, removed, urls: failedUrls.length }));
      }
    }
    const [current] = await tx<{ fingerprint: string }[]>`SELECT ${bodyMediaFingerprint()} AS fingerprint FROM articles ready_a WHERE ready_a.id=${articleId}`;
    if (effectiveFailed > 0 && current?.fingerprint !== input.fingerprint) return false;
    const [previous] = await tx<{ fingerprint: string; ready: boolean }[]>`SELECT fingerprint,ready FROM article_media_readiness WHERE article_id=${articleId}`;
    await tx`INSERT INTO article_media_readiness(article_id,revision,fingerprint,ready,renditions,failed,attempted_at,prepared_at)
      VALUES(${articleId},${row.article_revision},${bless},${effectiveFailed === 0},${renditions.length},${effectiveFailed},now(),CASE WHEN ${effectiveFailed === 0} THEN now() END)
      ON CONFLICT(article_id) DO UPDATE SET revision=EXCLUDED.revision,fingerprint=EXCLUDED.fingerprint,
        ready=EXCLUDED.ready,renditions=EXCLUDED.renditions,failed=EXCLUDED.failed,attempted_at=EXCLUDED.attempted_at,prepared_at=EXCLUDED.prepared_at`;
    const wasReady = previous?.ready && previous.fingerprint === bless;
    if ((effectiveFailed === 0 && !wasReady) || (effectiveFailed > 0 && wasReady)) {
      await publishArticleTx(tx, articleId, { refreshSelected: effectiveFailed === 0, skipMediaPreparation: true });
    }
    return effectiveFailed === 0;
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
