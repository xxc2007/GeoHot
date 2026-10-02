// Rewrite one story's digest from its current reports and the current writing fixture.
//
// Why this exists: a digest is a snapshot written from the reports as they were then, and `composeStoryDigest`
// skips rewriting when those reports and their copy are unchanged. That is right for the automatic path, but
// it also means a *corrected fixture* (this deployment's digests are served by the local stub) never reaches
// the page: the inputs hash matches and the function returns "updated: false", which reads like "nothing to
// fix". The 2026-10-02 incident was exactly that — a digest kept a magnitude (6.7) that appears in none of its
// own reports after the fixture had been corrected.
//
//   node --env-file=.env --env-file=.env.pipeline scripts/rewrite-story-digest.ts --story <public-id>
//   node --env-file=.env --env-file=.env.pipeline scripts/rewrite-story-digest.ts --story <public-id> --apply
// 两个 env 文件不能省：模型端点（本地是脑干 stub 的 3055）在 `.env.pipeline` 里，缺了它会报
// "Model default is not configured"。--apply 必须显式给 --story；它从不扫全库。
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { composeStoryDigest } from "@aihot/backend/events/digest";

const { values } = parseArgs({
  options: {
    story: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const publicId = values.story?.trim();
if (!publicId) {
  console.error("需要 --story <public-id>（事件页 URL 里的那段 id）");
  process.exit(2);
}

const [story] = await sql<{ id: number; title: string; digest: string | null; digest_updated_at: Date | null }[]>`
  SELECT id, title, digest, digest_updated_at FROM stories WHERE public_id = ${publicId} AND merged_into IS NULL`;
if (!story) {
  console.error(`没有这个事件：${publicId}`);
  await closeDb();
  process.exit(1);
}
const members = await sql<{ n: number }[]>`
  SELECT count(DISTINCT p.article_id)::int AS n
  FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
  WHERE f.story_id = ${story.id} AND p.visibility = 'public' AND p.eligible`;
console.log(`事件 ${story.id}「${story.title}」，公开成员报道 ${members[0]?.n ?? 0} 篇`);
console.log(`当前综述（更新于 ${story.digest_updated_at?.toISOString() ?? "—"}）：\n${story.digest ?? "（空）"}`);
if (!values.apply) {
  console.log("\n（dry run：没有改库。要重写请加 --apply；新版本会写进 story_digests，旧版本仍可追溯）");
} else {
  const res = await composeStoryDigest(story.id, { force: true });
  console.log(res.updated ? `\n已重写为第 ${res.version} 版` : "\n没有重写（事件不存在或没有任何公开成员报道）");
}
await closeDb();
