import {READER_POLICY_VERSION} from "../publication/readiness.ts";
import { sql, type Tx } from "../db.ts";
import type { TranslationRank } from "./translation-scheduling.ts";

/** Content refusals stay terminal; outages and missing fragments can recover without erasing history. */
export const TRANSLATION_ATTEMPT_CEILING = 6;

/** Transport noise is not a verdict on the copy: it backs off for minutes, never for the six-hour wall. */
export const TRANSLATION_TRANSPORT_ERROR =
  '(connect failed|fetch failed|ECONN|CONNECT_TIMEOUT|connection.*closed|network|HTTP (429|5[0-9]{2}))';

export function translationAttemptBlockedSql() {
  return sql`(t.outcome IN ('skipped','translated')
    OR (t.attempts>=${TRANSLATION_ATTEMPT_CEILING} AND t.outcome<>'partial' AND NOT
      (t.outcome='failed' AND coalesce(t.reason,'') ~* ${TRANSLATION_TRANSPORT_ERROR}))
    OR (t.outcome IN ('failed','partial') AND t.updated_at > now() -
      CASE WHEN t.outcome='failed' AND coalesce(t.reason,'') ~* ${TRANSLATION_TRANSPORT_ERROR} THEN interval '5 minutes'
        WHEN t.attempts>=${TRANSLATION_ATTEMPT_CEILING} THEN interval '6 hours'
        ELSE interval '5 minutes' END))`;
}

/**
 * 选稿读的上限从 2 秒放到 8 秒、默认 4 秒：2026-11-08 实测一轮四分钟里 `content.translate` 有 7/24 次
 * 直接死在 `canceling statement due to statement timeout`，选稿读一超时整轮就作废，读者面因此只有
 * 3–10 篇/小时的译文（目标 24 篇/2 分钟）。锁等待仍卡在 250ms，读事务仍只读，慢的只是排序扫描。
 */
const SELECTOR_TIMEOUT_MAX_MS = 8000;

/** Bound selector SQL on the server; release the read transaction before any model request. */
export async function translationSelectorRead<T>(read: (tx: Tx) => Promise<T>, timeoutMs = 4000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SELECTOR_TIMEOUT_MAX_MS) throw new Error("Invalid translation selector timeout");
  return sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SELECT set_config('statement_timeout',${`${timeoutMs}ms`},true),set_config('lock_timeout','250ms',true)`;
    return read(tx);
  }) as Promise<T>;
}

/** Bound cold header lookups per statement, then rank the complete candidate set in SQL. */
/**
 * 库忙时选稿读会踩到 57014。整轮作废的代价（四分钟 + 一篇都没翻）远高于重排一次：
 * 只对「语句超时」重试一次，其它错误照旧往上抛。
 */
async function selectorRead<T>(read: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await translationSelectorRead(read);
  } catch (error) {
    if ((error as { code?: string }).code !== "57014") throw error;
    return translationSelectorRead(read);
  }
}

export async function pendingTranslationRanks(from: Date, total: number, historical: boolean, checkpoint: () => void): Promise<TranslationRank[]> {
  checkpoint();
  const publications = await selectorRead(tx => tx<{ article_id: string }[]>`
    SELECT article_id FROM publications
    WHERE (selected OR eligible) AND visibility='public' AND body_mode='full'
      AND discovered_at >= ${from}
    ORDER BY discovered_at DESC LIMIT 1024`);
  const candidates: { article_id: string; discovered_at: string; bytes: number }[] = [];
  for (let offset = 0; offset < publications.length; offset += 128) {
    checkpoint();
    const ids = publications.slice(offset, offset + 128).map(row => row.article_id);
    const batch = await selectorRead(tx => tx<typeof candidates>`
      WITH cand AS MATERIALIZED (
        SELECT p.article_id,p.discovered_at
        FROM publications p
        JOIN LATERAL (
          SELECT id,revision FROM articles
          WHERE id=p.article_id AND coalesce(language,'') <> 'zh' OFFSET 0
        ) a ON true
        LEFT JOIN translations tr ON tr.article_id=p.article_id AND tr.lang='zh'
        LEFT JOIN article_workflow_readiness repair ON repair.article_id=p.article_id AND repair.policy_version=${READER_POLICY_VERSION}
        WHERE p.article_id=ANY(${ids}::text[])
          AND (p.selected OR p.eligible) AND p.visibility='public' AND p.body_mode='full'
          AND (p.discovered_at >= ${from}
               OR EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id=a.id AND r.revision=a.revision AND r.revision>1 AND r.created_at >= ${from}))
          AND coalesce(repair.quality_error,'') NOT LIKE 'source:%'
          AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND (tr.revision<a.revision OR NOT tr.complete OR repair.quality_error IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM translation_attempts t WHERE t.article_id=p.article_id AND t.revision=a.revision
                          AND CASE WHEN repair.quality_error IS NOT NULL AND t.outcome='translated'
                            THEN t.updated_at > now()-interval '6 hours' ELSE ${translationAttemptBlockedSql()} END)
      )
      SELECT c.article_id,c.discovered_at::text,octet_length(coalesce(a.body_html,a.body_text,'')) AS bytes
      FROM cand c JOIN LATERAL (SELECT body_html,body_text FROM articles WHERE id=c.article_id OFFSET 0) a ON true`);
    candidates.push(...batch);
  }
  checkpoint();
  if (!candidates.length) return [];
  // SQL retains the database's timestamp precision and ID collation across batch boundaries.
  return selectorRead(tx => tx<TranslationRank[]>`
    WITH ranked AS (
      SELECT article_id,
             row_number() OVER (ORDER BY discovered_at DESC,article_id) AS by_fresh,
             row_number() OVER (ORDER BY bytes ASC,discovered_at DESC,article_id) AS by_short,
             row_number() OVER (ORDER BY discovered_at ASC,article_id) AS by_old
      FROM jsonb_to_recordset(${tx.json(candidates)}::jsonb)
        AS c(article_id text,discovered_at timestamptz,bytes integer)
    )
    SELECT article_id,by_fresh,by_short,by_old FROM ranked
    WHERE by_fresh<=${total} OR by_short<=${total} OR (${historical} AND by_old=1)`);
}
