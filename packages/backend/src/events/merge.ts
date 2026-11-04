// Merging stories: facts and heat evidence move into the surviving story, and the old
// public id keeps answering as an alias. Editors merge from the admin; grouping merges when two
// stories turn out to be one (consolidate in group.ts).
import { sql } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { publishArticle } from "../publication/publish.ts";

/** Merges `fromId` into `intoId`; null when either story is missing or already merged (nothing changes then). */
export async function mergeStoryInto(fromId: number, intoId: number, reason: string, actor: string): Promise<{ moved: number } | null> {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  const articles = await sql.begin(async (tx) => {
    // 两条 `FOR UPDATE` 以前按参数顺序加锁（from 先、into 后）：后台合并、grouping 的 consolidate
    // 与 redirectEmptiedStories 同时做 A→B 和 B→A 时会 40P01 死锁，失败那笔合并没有生效。
    // 一次查询按 id 升序取锁，所有调用方拿到的顺序就一致了。
    const locked = await tx<{ id: number; public_id: string; merged_into: number | null }[]>`
      SELECT id, public_id, merged_into FROM stories WHERE id IN (${fromId}, ${intoId}) ORDER BY id FOR UPDATE`;
    const from = locked.find((row) => row.id === fromId);
    const into = locked.find((row) => row.id === intoId);
    if (!from || !into || from.merged_into || into.merged_into) return null;
    await tx`UPDATE facts SET story_id = ${intoId}, updated_at = now() WHERE story_id = ${fromId}`;
    // A report with evidence in both stories keeps one row: (story, article) is unique.
    await tx`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
             SELECT ${intoId}, article_id, participant_key, source_id, kind, observed_at FROM story_signals WHERE story_id = ${fromId}
             ON CONFLICT (story_id, article_id) DO NOTHING`;
    await tx`DELETE FROM story_signals WHERE story_id = ${fromId}`;
    await tx`UPDATE stories SET merged_into = ${intoId}, version = version + 1, updated_at = now() WHERE id = ${fromId}`;
    await tx`UPDATE stories SET version = version + 1, updated_at = now(),
               latest_at = greatest(latest_at, (SELECT latest_at FROM stories WHERE id = ${fromId})),
               first_report_at = least(first_report_at, (SELECT first_report_at FROM stories WHERE id = ${fromId}))
             WHERE id = ${intoId}`;
    await tx`INSERT INTO story_aliases (public_id, story_id) VALUES (${from.public_id}, ${intoId}) ON CONFLICT DO NOTHING`;
    return tx<{ article_id: string }[]>`SELECT DISTINCT fa.article_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE f.story_id = ${intoId}`;
  });
  if (!articles) return null;
  for (const a of articles) await publishArticle(a.article_id);
  await enqueue(QUEUES.digest, { storyId: intoId }, { singletonKey: `story:${intoId}` });
  await audit(actor, "story.merge", `story:${fromId}`, reason, null, { into: intoId });
  return { moved: articles.length };
}
