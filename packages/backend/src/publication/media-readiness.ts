import { sql } from "../db.ts";

/** Only reader body images/posters count: avatars, source logos, favicon and OG never block release. */
export function bodyMediaRequiredCondition() {
  return sql`(
    coalesce(ready_a.body_html, '') ~* '<img[[:space:]][^>]*src[[:space:]]*=[[:space:]]*[''"]https?://'
    OR coalesce((SELECT body_html FROM translations WHERE article_id=ready_a.id AND lang='zh' AND revision=ready_a.revision), '') ~* '<img[[:space:]][^>]*src[[:space:]]*=[[:space:]]*[''"]https?://'
    OR coalesce(ready_a.body_html, '') ~* '<video[[:space:]][^>]*poster[[:space:]]*=[[:space:]]*[''"]https?://'
    OR coalesce((SELECT body_html FROM translations WHERE article_id=ready_a.id AND lang='zh' AND revision=ready_a.revision), '') ~* '<video[[:space:]][^>]*poster[[:space:]]*=[[:space:]]*[''"]https?://'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ready_a.media)='array' THEN ready_a.media ELSE '[]'::jsonb END) m WHERE m->>'kind'='video' AND m->>'poster' ~* '^https?://')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ready_a.x_post->'media')='array' THEN ready_a.x_post->'media' ELSE '[]'::jsonb END) m WHERE m->>'url' ~* '^https?://')
  )`;
}

/** SQL JSON serialization is shared by the read gate and writer to avoid language/whitespace hash drift. */
export function bodyMediaFingerprint() {
  return sql`md5(jsonb_build_array(ready_a.revision,coalesce(ready_a.body_html,''),
    coalesce((SELECT body_html FROM translations WHERE article_id=ready_a.id AND lang='zh' AND revision=ready_a.revision),''),
    ready_a.media,ready_a.x_post->'media')::text)`;
}

export function bodyMediaReadyCondition() {
  return sql`(CASE WHEN EXISTS (
    SELECT 1 FROM article_media_readiness ready_media
    WHERE ready_media.article_id=ready_a.id AND ready_media.revision=ready_a.revision
      AND ready_media.fingerprint=${bodyMediaFingerprint()} AND ready_media.ready
  ) THEN true ELSE NOT ${bodyMediaRequiredCondition()} END)`;
}
