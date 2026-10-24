import { sql, type Tx } from "../db.ts";
import type { TranslationRank } from "./translation-scheduling.ts";

/** Bound selector SQL on the server; release the read transaction before any model request. */
export async function translationSelectorRead<T>(read: (tx: Tx) => Promise<T>, timeoutMs = 2000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error("Invalid translation selector timeout");
  return sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SELECT set_config('statement_timeout',${`${timeoutMs}ms`},true),set_config('lock_timeout','250ms',true)`;
    return read(tx);
  }) as Promise<T>;
}

/** Bound cold header lookups per statement, then rank the complete candidate set in SQL. */
export async function pendingTranslationRanks(from: Date, total: number, historical: boolean, checkpoint: () => void): Promise<TranslationRank[]> {
  checkpoint();
  const publications = await translationSelectorRead(tx => tx<{ article_id: string }[]>`
    SELECT article_id FROM publications
    WHERE selected AND visibility='public' AND body_mode='full' ORDER BY article_id`);
  const candidates: { article_id: string; discovered_at: string; bytes: number }[] = [];
  for (let offset = 0; offset < publications.length; offset += 128) {
    checkpoint();
    const ids = publications.slice(offset, offset + 128).map(row => row.article_id);
    const batch = await translationSelectorRead(tx => tx<typeof candidates>`
      WITH cand AS MATERIALIZED (
        SELECT p.article_id,p.discovered_at
        FROM publications p
        JOIN LATERAL (
          SELECT id,revision FROM articles
          WHERE id=p.article_id AND coalesce(language,'') <> 'zh' OFFSET 0
        ) a ON true
        LEFT JOIN translations tr ON tr.article_id=p.article_id AND tr.lang='zh'
        WHERE p.article_id=ANY(${ids}::text[])
          AND p.selected AND p.visibility='public' AND p.body_mode='full'
          AND (p.discovered_at >= ${from}
               OR EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id=a.id AND r.revision=a.revision AND r.revision>1 AND r.created_at >= ${from}))
          AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND (tr.revision<a.revision OR NOT tr.complete)))
          AND NOT EXISTS (SELECT 1 FROM translation_attempts t WHERE t.article_id=p.article_id AND t.revision=a.revision
                          AND (t.outcome IN ('skipped','translated') OR t.attempts>=3))
      )
      SELECT c.article_id,c.discovered_at::text,octet_length(coalesce(a.body_html,a.body_text,'')) AS bytes
      FROM cand c JOIN LATERAL (SELECT body_html,body_text FROM articles WHERE id=c.article_id OFFSET 0) a ON true`);
    candidates.push(...batch);
  }
  checkpoint();
  if (!candidates.length) return [];
  // SQL retains the database's timestamp precision and ID collation across batch boundaries.
  return translationSelectorRead(tx => tx<TranslationRank[]>`
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
