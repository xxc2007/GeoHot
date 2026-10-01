// Tibo post collection for the reset monitor (SocialData, paid). Posts and their reply/quote
// context are stored before the cursor moves; recognition runs afterwards in publication order.
// Normal cadence is 5 minutes, as the public v1 description states; after an outage or an
// announcement it is 3 minutes for a while.
import { sql } from "../db.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { getTweet, searchTweets, tweetText, type SdTweet } from "../providers/socialdata.ts";
import { deliverContent } from "../notify/deliver.ts";
import { applyRecognition } from "./assemble.ts";
import { recognizePost, type ContextInput, type OpenEventInput } from "./recognize.ts";
import { bjIso, codexResetsSnapshot, MONITOR_PAGE_URL } from "./read.ts";
import { SITE } from "@aihot/industry/site";

export const AUTHOR = "thsottiaux";
const NORMAL_EVERY_MS = 5 * 60_000;
const HOT_EVERY_MS = 3 * 60_000;
const MAX_PAGES = 5;
const PUSH_MAX_AGE_MS = 36 * 3600_000;

async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM monitor_state WHERE key = ${key}`;
  return row?.value ?? null;
}

async function setState(key: string, value: unknown) {
  await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

async function touchWatermarks(patch: Record<string, string>) {
  const current = (await getState<Record<string, string>>("watermarks")) ?? {};
  await setState("watermarks", { ...current, ...patch });
}

const idGreater = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a > b);

/** Whether a scan is due now (called every few minutes by the scheduler). */
export async function scanDue(now = Date.now()): Promise<boolean> {
  const hot = await getState<{ until: string }>("hot");
  const w = await getState<{ lastAttemptAt?: string }>("watermarks");
  const last = w?.lastAttemptAt ? Date.parse(w.lastAttemptAt) : 0;
  const every = hot && Date.parse(hot.until) > now ? HOT_EVERY_MS : NORMAL_EVERY_MS;
  return now - last >= every - 30_000;
}

async function contextOf(t: SdTweet, subject: string): Promise<Array<ContextInput & { url: string }>> {
  const out: Array<ContextInput & { url: string }> = [];
  const push = (x: SdTweet, relation: "reply" | "quote") =>
    out.push({ id: x.id_str, author: x.user.screen_name, relation, text: tweetText(x), publishedAt: new Date(x.tweet_created_at).toISOString(), url: `https://x.com/i/status/${x.id_str}` });
  if (t.quoted_status) push(t.quoted_status, "quote");
  let parentId = t.in_reply_to_status_id_str ?? null;
  for (let depth = 0; parentId && depth < 2; depth++) {
    const parent = await getTweet(parentId, { purpose: "monitor.context", subject });
    if (!parent) break;
    push(parent, "reply");
    if (parent.quoted_status && depth === 0) push(parent.quoted_status, "quote");
    parentId = parent.in_reply_to_status_id_str ?? null;
  }
  return out;
}

async function storePost(t: SdTweet) {
  const context = await contextOf(t, `x:${t.id_str}`);
  await sql`
    INSERT INTO monitor_posts (id, author, published_at, text, url, context, raw, origin)
    VALUES (${t.id_str}, ${t.user.screen_name}, ${new Date(t.tweet_created_at)}, ${tweetText(t)}, ${`https://x.com/${AUTHOR}/status/${t.id_str}`},
            ${sql.json(context.map(({ publishedAt: _p, ...c }) => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
            ${sql.json({ tweet: t, context } as never)}, 'live')
    ON CONFLICT (id) DO NOTHING`;
}

/** Collects new posts (or a lookback window) and stores them before moving the cursor. */
export async function collectPosts(opts: { lookbackHours?: number } = {}): Promise<{ stored: number; pages: number }> {
  const started = new Date();
  await touchWatermarks({ lastAttemptAt: started.toISOString() });
  const cursor = (await getState<{ sinceId: string | null }>("cursor")) ?? { sinceId: null };
  const since = opts.lookbackHours ? Math.floor((Date.now() - opts.lookbackHours * 3600_000) / 1000) : null;
  const query = since ? `from:${AUTHOR} since_time:${since}` : `from:${AUTHOR}`;
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const found: SdTweet[] = [];
  let next: string | null = null;
  let pages = 0;
  do {
    const res = await searchTweets(query, { purpose: opts.lookbackHours ? "monitor.lookback" : "monitor.scan", subject: `x:${AUTHOR}`, window, cursor: next });
    pages++;
    let reachedKnown = false;
    for (const t of res.tweets) {
      if (t.retweeted_status) continue; // native reposts are not his words
      if (!since && cursor.sinceId && !idGreater(t.id_str, cursor.sinceId)) {
        reachedKnown = true;
        continue;
      }
      found.push(t);
    }
    next = reachedKnown ? null : res.nextCursor;
  } while (next && pages < MAX_PAGES);

  let stored = 0;
  for (const t of found.sort((a, b) => (idGreater(a.id_str, b.id_str) ? 1 : -1))) {
    const [exists] = await sql`SELECT 1 FROM monitor_posts WHERE id = ${t.id_str}`;
    if (exists) continue;
    await storePost(t);
    stored++;
  }
  const newest = found.reduce<string | null>((m, t) => (!m || idGreater(t.id_str, m) ? t.id_str : m), cursor.sinceId);
  if (newest && newest !== cursor.sinceId) await setState("cursor", { sinceId: newest });
  await touchWatermarks({ lastCollectedAt: started.toISOString() });
  return { stored, pages };
}

async function openEvents(before: Date): Promise<OpenEventInput[]> {
  const rows = await sql<{ id: string; type: OpenEventInput["kind"]; status: OpenEventInput["status"]; schedule: { label: string } | null; first_at: Date; excerpt: string }[]>`
    SELECT e.id, e.type, e.status, e.schedule, min(p.published_at) AS first_at,
      (SELECT ep.original_text FROM monitor_event_posts ep JOIN monitor_posts pp ON pp.id = ep.post_id WHERE ep.event_id = e.id ORDER BY pp.published_at LIMIT 1) AS excerpt
    FROM monitor_events e JOIN monitor_event_posts l ON l.event_id = e.id JOIN monitor_posts p ON p.id = l.post_id
    WHERE NOT e.withdrawn AND e.created_at <= ${before}
      AND ((e.status = 'announced' OR e.confirmation_basis = 'receipt_review' AND e.confirmed_at IS NULL) AND e.created_at >= ${new Date(before.getTime() - 72 * 3600_000)}
           OR e.confirmed_at >= ${new Date(before.getTime() - 48 * 3600_000)})
    GROUP BY e.id ORDER BY first_at DESC LIMIT 8`;
  return rows.map((r) => ({ id: r.id, kind: r.type, status: r.status, firstPostAt: r.first_at.toISOString(), excerpt: r.excerpt, schedule: r.schedule?.label ?? null }));
}

function resetCard(eventId: string, action: "announce" | "confirm", snapshot: Awaited<ReturnType<typeof codexResetsSnapshot>>, postId: string) {
  const e = snapshot.events.find((x) => x.id === eventId);
  if (!e) return null;
  const post = e.posts.find((p) => p.id === postId) ?? e.posts[0];
  const kind = e.type === "reset_credit" ? "重置卡发放" : "Codex 额度重置";
  const title = action === "confirm" ? `${kind}已完成（Tibo 确认）` : `${kind}：Tibo 已宣布`;
  const window = e.estimate ?? e.schedule;
  const lines = [
    action === "announce" && window ? `**预计生效**：${window.label}${e.estimate ? `（${SITE.name} 推算）` : ""}` : null,
    action === "confirm" && e.confirmedAt ? `**确认时间**：北京时间 ${e.confirmedAt.slice(5, 16).replace("T", " ")}（确认帖时间，不是精确到账时间）` : null,
    `**适用范围**：${e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "未说明"}${e.presentation?.productsZh ? ` · ${e.presentation.productsZh}` : ""}`,
  ].filter(Boolean);
  return {
    header: { title: { tag: "plain_text", content: title }, template: action === "confirm" ? "turquoise" : "orange" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      post ? { tag: "div", text: { tag: "lark_md", content: `> ${(post.fullText ?? post.text).replace(/\n/g, "\n> ")}` } } : null,
      {
        tag: "action",
        actions: [
          post ? { tag: "button", text: { tag: "plain_text", content: "查看原帖" }, url: post.url, type: "default" } : null,
          { tag: "button", text: { tag: "plain_text", content: "打开重置监控" }, url: MONITOR_PAGE_URL, type: "primary" },
        ].filter(Boolean),
      },
    ].filter(Boolean),
  };
}

/**
 * Recognizes stored posts that have not been processed, oldest first. A failure stops the run (later
 * posts may relate to this one); the post is retried next tick, and ops.alerts reports a post stuck
 * for long, which an admin can then skip.
 */
export async function processPending(limit = 20): Promise<{ processed: number; failed: number }> {
  const posts = await sql<{ id: string; text: string; published_at: Date; raw: { context?: Array<ContextInput & { url: string }> } | null }[]>`
    SELECT id, text, published_at, raw FROM monitor_posts WHERE processed_at IS NULL AND author = ${AUTHOR}
    ORDER BY published_at, id LIMIT ${limit}`;
  let processed = 0;
  let failed = 0;
  for (const p of posts) {
    if (shutdownSignal.signal.aborted) break; // later posts wait for the next tick, in order
    try {
      const rec = await recognizePost({ id: p.id, text: p.text, publishedAt: p.published_at.toISOString(), context: p.raw?.context ?? [], openEvents: await openEvents(p.published_at) });
      await applyRecognition(p.id, rec);
      processed++;
      await sql`DELETE FROM monitor_state WHERE key = ${`failures:${p.id}`}`;
    } catch (error) {
      failed++;
      const prev = (await getState<{ count: number; since: string }>(`failures:${p.id}`)) ?? { count: 0, since: new Date().toISOString() };
      await setState(`failures:${p.id}`, { count: prev.count + 1, since: prev.since, error: String(error).slice(0, 300) });
      console.error(JSON.stringify({ level: "error", msg: "monitor recognition failed", post: p.id, error: String(error).slice(0, 300) }));
      break; // keep order: later posts wait for this one
    }
  }
  return { processed, failed };
}

/**
 * Sends the pushes processed posts owe (stored with their recognition), oldest first: after a normal
 * recognition, and after a stop between recognizing a post and delivering its push. Every target has
 * one delivery row per dedupe key, so nothing is sent twice; pushes older than 36 hours are dropped.
 */
export async function flushResetPushes(): Promise<number> {
  const owed = await sql<{ post_id: string; published_at: Date; event_id: string; action: "announce" | "confirm" }[]>`
    SELECT p.id AS post_id, p.published_at, n->>'eventId' AS event_id, n->>'action' AS action
    FROM monitor_posts p, jsonb_array_elements(coalesce(p.recognition->'notify', '[]'::jsonb)) n
    WHERE p.processed_at IS NOT NULL AND p.author = ${AUTHOR} AND p.published_at > ${new Date(Date.now() - PUSH_MAX_AGE_MS)}
      AND EXISTS (
        SELECT 1 FROM notify_targets t
        WHERE t.purpose = 'content' AND t.enabled AND (t.enabled_at IS NULL OR t.enabled_at <= p.published_at)
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.target_key = t.key AND d.dedupe_key = 'codex:' || p.id || ':' || (n->>'eventId') || ':' || (n->>'action')))
    ORDER BY p.published_at, p.id`;
  if (!owed.length) return 0;
  const snapshot = await codexResetsSnapshot();
  let pushed = 0;
  for (const o of owed) {
    const card = resetCard(o.event_id, o.action, snapshot, o.post_id);
    if (!card) continue;
    const results = await deliverContent({ subjectKind: "codex_reset", subjectId: o.event_id, dedupeKey: `codex:${o.post_id}:${o.event_id}:${o.action}`, contentAt: o.published_at, card });
    pushed += results.filter((r) => r.status === "sent").length;
  }
  return pushed;
}

/** One scheduled tick: scan when due, process what was stored, push what is owed, then move the verified watermark. */
export async function monitorTick(opts: { force?: boolean; lookbackHours?: number } = {}) {
  if (!opts.force && !opts.lookbackHours && !(await scanDue())) return { skipped: true };
  const started = new Date();
  const collected = await collectPosts({ lookbackHours: opts.lookbackHours });
  const result = await processPending();
  const pushed = await flushResetPushes();
  const [pending] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM monitor_posts WHERE processed_at IS NULL AND author = ${AUTHOR}`;
  if (!pending?.n) await touchWatermarks({ lastVerifiedAt: started.toISOString() });
  return { ...collected, ...result, pushed, pending: pending?.n ?? 0, verifiedAt: pending?.n ? null : bjIso(started) };
}
