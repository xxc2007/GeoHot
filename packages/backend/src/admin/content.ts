// Content diagnostics and corrections (F19). Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication and sync
// ledger → grouping → deliveries. Visibility changes and manual corrections go through editorial
// overrides with a version check, are re-projected to every public exit, and are audited.
import { z } from "zod";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { isCollectEnabled } from "../config.ts";
import { InvalidInput } from "./invalid.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { publishArticleTx } from "../publication/publish.ts";

import { computeHotRanking } from "../events/hot.ts";
import { mergeStoryInto } from "../events/merge.ts";
import { latestHotRanking } from "../events/hot-read.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

export async function searchContent(q: string) {
  const term = q.trim();
  if (!term) return [];
  const byId = ARTICLE_ID_PATTERN.test(term) ? term : null;
  const url = /^https?:\/\//i.test(term) ? normalizeUrl(term) : null;
  return sql`
    SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
           p.visibility, p.selected, p.score
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE (${byId}::text IS NOT NULL AND a.id = ${byId})
       OR (${url}::text IS NOT NULL AND (a.url = ${url} OR a.identity_key = ${url} OR a.url = ${term}))
       OR (${url}::text IS NULL AND (a.title ILIKE ${`%${term}%`} OR p.title ILIKE ${`%${term}%`}))
    ORDER BY a.discovered_at DESC LIMIT 50`;
}

export async function contentChain(id: string) {
  const [article] = await sql`
    SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.language, a.published_at, a.published_at_claim, a.discovered_at,
           a.timeline_at, a.backfill, a.body_status, a.revision, a.processing_state, a.processing_error, a.grouped_at, length(a.body_text) AS body_chars,
           s.name AS source_name, s.kind AS source_kind, s.tier, s.participation_mode, s.site_fulltext, s.syndicate_fulltext
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id}`;
  if (!article) return null;
  const [discoveries, revisions, analyses, publication, override, ledger, membership, decisions, deliveries, history] = await Promise.all([
    sql`SELECT source_id, via, discovered_at FROM article_discoveries WHERE article_id = ${id} ORDER BY discovered_at`,
    sql`SELECT revision, title, content_hash, created_at FROM article_revisions WHERE article_id = ${id} ORDER BY revision DESC LIMIT 10`,
    sql`
      SELECT an.id, an.origin, an.model, an.prompt_version, an.input_revision, an.relevance, an.category, an.score, an.selected, an.title_zh, an.reason_zh,
             an.created_at,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'model', r.model, 'cost', r.cost, 'at', r.created_at) ORDER BY r.id), '[]'::jsonb)
                FROM receipts r WHERE r.id = ANY(an.receipt_ids)) AS receipts
      FROM analyses an WHERE an.article_id = ${id} ORDER BY an.created_at DESC LIMIT 10`,
    sql`SELECT * FROM publications WHERE article_id = ${id}`,
    sql`SELECT fields, visibility, reason, version, updated_by, updated_at FROM editorial_overrides WHERE article_id = ${id}`,
    sql`SELECT seq, op, visible_at, changed_at FROM selected_ledger WHERE article_id = ${id} ORDER BY seq DESC LIMIT 10`,
    sql`
      SELECT fa.fact_id, fa.role, fa.manual, f.public_id AS fact_public_id, f.title AS fact_title, st.id AS story_id, st.public_id AS story_public_id, st.title AS story_title
      FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id WHERE fa.article_id = ${id}`,
    sql`SELECT verdict, fact_id, story_id, receipt_id, candidates, created_at FROM grouping_decisions WHERE article_id = ${id} ORDER BY created_at DESC LIMIT 5`,
    sql`SELECT target_key, dedupe_key, status, attempts, response, created_at, sent_at FROM deliveries WHERE subject_id = ${id} ORDER BY created_at DESC`,
    sql`SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${`content:${id}`} ORDER BY created_at DESC LIMIT 20`,
  ]);
  return { article, discoveries, revisions, analyses, publication: publication[0] ?? null, override: override[0] ?? null, ledger, membership, decisions, deliveries, history };
}


/** Whether the current hot ranking shows the article: as an event's representative or among its reports. */
async function inHotRanking(id: string): Promise<boolean> {
  const ranking = await latestHotRanking();
  if (!ranking?.entries.length) return false;
  if (ranking.entries.some((e) => e.representativeItemId === id)) return true;
  const [p] = await sql<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${id}`;
  return !!p?.story_id && ranking.entries.some((e) => e.storyId === Number(p.story_id));
}

const STALE = "这条内容的人工设置已被修改，请刷新后再操作";

// The three shapes the back office posts for content decisions, validated here rather than at the route:
// this is where the domain meaning lives, and `routes/admin.ts` hands these bodies over with `as never`.
// Before this, `setVisibility` never looked at `visibility` at all, so a request that merely *omitted*
// it wrote `visibility = NULL` — which is neither public nor withdrawn, and lifted a human 下架 while
// bumping the version, so the editor's own next attempt would be refused as stale.
const VisibilitySchema = z.object({
  visibility: z.enum(["public", "summary-only", "withdrawn"]),
  reason: z.string().min(1),
  version: z.number().int().nonnegative(),
}).strict();

const SeoSchema = z.object({
  // `!!input.indexed` used to be the check, so the string "false" — which any form serialisation can
  // produce — meant "mark indexed", the opposite of what the editor clicked.
  indexed: z.boolean(),
  reason: z.string().min(1),
}).strict();

const RerunStepSchema = z.enum(["extract", "analyze", "group"]);

async function overrideRow(id: string) {
  const [o] = await sql<{ fields: Record<string, unknown>; visibility: string | null; version: number }[]>`SELECT fields, visibility, version FROM editorial_overrides WHERE article_id = ${id}`;
  return o ?? { fields: {}, visibility: null, version: 0 };
}

/**
 * Public / summary-only / withdrawn. Applies to the site, API, RSS, MCP, the sync ledger and the
 * search index through the one publication projection; ETags change with the content.
 */
export async function setVisibility(id: string, input: unknown, actor: string) {
  const { visibility, reason, version } = VisibilitySchema.parse(input);
  const before = await overrideRow(id);
  if (before.version !== version) throw new Conflict(STALE);
  // The override write and the re-projection are one transaction. They used to be two: the override
  // committed (v3 → v4), then `publishArticle` opened its own transaction and could lose a lock race
  // with the grouping job and throw — leaving the item public on every exit, with no audit row, and
  // with the editor's retry pinned out forever because the client still held v3 (409 on every try,
  // until someone happened to reload the page). Rolling back means a failed command changes nothing.
  const published = await sql.begin(async (tx) => {
    const written = await tx`
      INSERT INTO editorial_overrides (article_id, visibility, reason, version, updated_by) VALUES (${id}, ${visibility}, ${reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET visibility = EXCLUDED.visibility, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE editorial_overrides.version = ${version}
      RETURNING version`;
    if (!written.count) throw new Conflict(STALE);
    return publishArticleTx(tx, id);
  });
  if (published?.reduced || (before.visibility ?? "public") !== visibility) {
    // On the hot board the change shows at once, not at the next five-minute ranking.
    if (await inHotRanking(id)) await computeHotRanking();
  }
  await audit(actor, "content.visibility", `content:${id}`, reason, { visibility: before.visibility }, { visibility });
  return published;
}

/** Marks a detail page for search indexing (sitemap, IndexNow, robots) or removes the mark. */
export async function setSeoIndexed(id: string, input: unknown, actor: string) {
  const { indexed, reason } = SeoSchema.parse(input);
  const [before] = await sql<{ seo_indexed_at: Date | null; indexable: boolean }[]>`SELECT seo_indexed_at, indexable FROM publications WHERE article_id = ${id}`;
  if (!before) return null;
  // Marking indexes the page; unmarking excludes it, so a selected page is not indexed again automatically.
  // One transaction with the re-projection, for the same half-apply reason as `setVisibility`.
  const published = await sql.begin(async (tx) => {
    await tx`UPDATE publications SET seo_indexed_at = ${indexed ? (before.seo_indexed_at ?? new Date()) : null},
              seo_excluded_at = ${indexed ? null : new Date()} WHERE article_id = ${id}`;
    return publishArticleTx(tx, id);
  });
  await audit(actor, "content.seo", `content:${id}`, reason, { indexed: before.indexable }, { indexed });
  return published;
}

const FieldsSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().max(2000),
    reason: z.string().max(1000),
    category: z.enum(CATEGORY_KEYS as unknown as [string, ...string[]]),
    tags: z.array(z.string().max(60)).max(20),
    selected: z.boolean(),
    silent: z.boolean(),
  })
  .partial()
  .strict();

/** Manual corrections win over model output; null clears a correction. */
export async function overrideFields(id: string, input: { fields: unknown; clear?: string[]; reason: string; version: number }, actor: string) {
  if (!input.reason?.trim()) throw new InvalidInput("reason is required");
  const fields = FieldsSchema.parse(input.fields ?? {});
  const before = await overrideRow(id);
  if (before.version !== input.version) throw new Conflict(STALE);
  const next = { ...before.fields, ...fields };
  for (const k of input.clear ?? []) delete (next as Record<string, unknown>)[k];
  const published = await sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO editorial_overrides (article_id, fields, reason, version, updated_by) VALUES (${id}, ${sql.json(next as never)}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE editorial_overrides.version = ${input.version}
      RETURNING version`;
    if (!rows.count) throw new Conflict(STALE);
    return publishArticleTx(tx, id);
  });
  // A corrected title or summary reaches the event summary: rewrite the digest of its story.
  if (published?.changed) {
    const [st] = await sql<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${id}`;
    if (st?.story_id) await enqueue(QUEUES.digest, { storyId: st.story_id, afterCorrection: true }, { singletonKey: `story:${st.story_id}:correction` });
  }
  await audit(actor, "content.override", `content:${id}`, input.reason, before.fields, next);
  return published;
}

/**
 * Re-runs a pipeline step for the current revision. Re-evaluation is a new paid model call bound to
 * the request id, so submitting the same request twice neither enqueues nor pays twice.
 */
export async function rerun(id: string, input: unknown, requestId: string, actor: string) {
  const { step, reason } = z.object({ step: RerunStepSchema, reason: z.string().optional() }).strict().parse(input);
  if (!/^[\w-]{8,80}$/.test(requestId)) throw new InvalidInput("a stable request id is required");
  const [a] = await sql`SELECT id FROM articles WHERE id = ${id}`;
  if (!a) return null;
  let jobId: string | null;
  if (step === "group") {
    // An explicit regroup replaces an earlier manual "keep standalone" decision and the automatic
    // membership. That decision is a signed editorial one (`detachFromFact` records who made it and
    // why), so taking it back is a decision of its own: without a reason here it used to happen with a
    // click on a dialog that promised the opposite ("人工归组的成员关系不会被覆盖").
    if (!reason?.trim()) throw new InvalidInput("重新归组会撤销人工的“单独成条”决定，请写明理由");
    await sql`DELETE FROM grouping_overrides WHERE article_id = ${id}`;
    jobId = await enqueue(QUEUES.group, { articleId: id, force: true }, { singletonKey: `manual:group:${id}:${requestId}` });
  } else {
    // Both of these re-pay: `analyze` is a fresh model call bound to the request id, `extract` goes out to
    // the publisher again. A command with no reason is not auditable, so all steps now ask for one — the
    // rule `group` already had.
    if (!reason?.trim()) throw new InvalidInput("重跑会再打一次模型或再出网取原文，请写明理由");
    // 抽取正文的消费者（`registerExtractionJobs`）是跟着采集阀门一起开关的。阀门关着时把这一支排进去，
    // 排到的就是一个永远没人领的作业——`route()` 现在不会自己选它了，但后台这一下是显式要求的，
    // 所以在这里说明白，而不是静默收下单据。
    if (step === "extract" && !isCollectEnabled()) throw new InvalidInput("抽取正文要出网，跟着 COLLECT_ENABLED 一起开着；这个环境的采集阀门是关的，先开阀门再点。");
    await sql`UPDATE articles SET processing_state = 'new', processing_error = NULL, processing_attempts = 0, processing_retry_at = NULL,
                body_status = CASE WHEN ${step === "extract"} THEN 'pending' ELSE body_status END WHERE id = ${id}`;
    jobId = step === "analyze"
      ? await queueProcessing(id, { step: "analyze", attemptTag: `admin:${requestId}` })
      : await queueProcessing(id, { step: "extract" });
  }
  await audit(actor, `content.rerun.${step}`, `content:${id}`, reason ?? null, null, { jobId, requestId }, requestId);
  return { jobId };
}

/**
 * Takes an article out of its fact; it is shown on its own again and stays that way (automatic
 * grouping, retries and later revisions do not re-attach it; an explicit regroup does). Its heat
 * evidence leaves the old story, whose digest is rewritten.
 */
export async function detachFromFact(id: string, reason: string, actor: string) {
  // A reason is what makes this a signed editorial decision (`grouping_overrides` keeps it, the audit row
  // keeps it). Checked before anything is written: the audit insert happens after the transaction, so an
  // absent reason used to leave the row detached, the command answered with a 500 and no audit trail.
  if (!reason?.trim()) throw new InvalidInput("detach 会撤销自动归组，请写明理由");
  const { facts, stories } = await sql.begin(async (tx) => {
    // The grouping job writes under the same lock and reads this decision again before it does.
    await tx`SELECT 1 FROM articles WHERE id = ${id} FOR UPDATE`;
    const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id = ${id} RETURNING fact_id`;
    const factIds = removed.map((r) => r.fact_id);
    const storyRows = factIds.length ? await tx<{ story_id: number }[]>`SELECT DISTINCT story_id FROM facts WHERE id = ANY(${factIds}) AND story_id IS NOT NULL` : [];
    const storyIds = storyRows.map((r) => r.story_id);
    if (storyIds.length) await tx`DELETE FROM story_signals WHERE article_id = ${id} AND story_id = ANY(${storyIds})`;
    await tx`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, ${reason}, ${actor})
             ON CONFLICT (article_id) DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, created_at = now()`;
    await tx`UPDATE articles SET grouped_at = now() WHERE id = ${id}`;
    // The re-projection belongs inside this transaction: with `publishArticle` after the commit, a
    // failure in between left the row detached in the database while every exit still showed it inside
    // the event — and the retry re-ran the whole command against facts that were already gone.
    await publishArticleTx(tx, id);
    const others = factIds.length
      ? await tx<{ article_id: string }[]>`SELECT DISTINCT article_id FROM fact_articles WHERE fact_id = ANY(${factIds})`
      : [];
    for (const o of others) await publishArticleTx(tx, o.article_id);
    return { facts: factIds, stories: storyIds };
  });
  for (const storyId of stories) await enqueue(QUEUES.digest, { storyId }, { singletonKey: `story:${storyId}` });
  await audit(actor, "content.detach", `content:${id}`, reason, { facts, stories }, null);
  return { detached: facts.length };
}

/** Merges one story into another: facts move, the old public id keeps working as an alias. */
export async function mergeStories(fromId: number, intoId: number, reason: string, actor: string) {
  // Before the merge, not after: the commit and the digest enqueue happen first, and `audit` binds the
  // reason — an absent one used to throw there, leaving two merged stories, a 500 to the operator and no
  // audit row for a change that really happened.
  if (!reason?.trim()) throw new InvalidInput("合并事件会改掉两个事件的读者面，请写明理由");
  if (fromId === intoId) throw new InvalidInput("cannot merge a story into itself");
  const done = await mergeStoryInto(fromId, intoId, reason, actor);
  if (done) return done;
  const found = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id IN (${fromId}, ${intoId})`;
  if (found.length < 2) throw new InvalidInput("story not found");
  throw new Conflict("两个事件都必须是未合并的事件");
}

/**
 * 让编辑重写这条事件的综述。为什么要有一个人点得动的动作：综述只问「输入变了没有」，而被拒的那一版
 * 根本不会写进版面，于是 `inputs_hash` 与 `stories.version` 都不变——改完署名的 fixture 再干等，
 * 是等不到的（本轮之前 `force` 只能由脚本传入，后台没有任何入口）。
 *
 * 一次点击一个 `requestId`：付费调用的去重按它算（否则第二次「重写」会复放第一次那笔被拒的答复），
 * 而重复点击的去重交给队列的 singletonKey，两件事不再挤在同一个键上。
 */
export async function rewriteStoryDigest(storyId: number, reason: string, requestId: string, actor: string) {
  if (!reason.trim()) throw new InvalidInput("reason is required");
  if (!/^[\w-]{8,80}$/.test(requestId)) throw new InvalidInput("a stable request id is required");
  const [story] = await sql<{ id: number; title: string; digest: string | null }[]>`
    SELECT id, title, digest FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return null;
  const jobId = await enqueue(QUEUES.digest, { storyId, force: true, requestId }, { singletonKey: `manual:digest:${storyId}:${requestId}` });
  await audit(actor, "story.digest-rewrite", `story:${storyId}`, reason.trim(), { digest: story.digest }, { jobId, requestId }, requestId);
  return { jobId, title: story.title };
}
