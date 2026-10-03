// Shared setup for the invariant tests (node --test tests/). They write rows, so they refuse to run
// unless DATABASE_URL names a throwaway database ending in _test or _ci (CI: a freshly migrated one).
// Secrets are test values set here, never real credentials; paid providers are pointed at
// local stubs by the tests that need them, and the push valves stay off. The files share
// one database and its paid-service budgets, so they run one at a time (package.json).
import http from "node:http";

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
if (!/_(test|ci)$/.test(database)) {
  throw new Error(`Invariant tests write rows: point DATABASE_URL at a throwaway database named *_test or *_ci (got "${database}")`);
}
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";
process.env.SESSION_SECRET ??= "test-session-secret-0123456789";
process.env.IMG_PROXY_SIGN_SECRET ??= "test-img-secret-0123456789";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
process.env.LOG_LEVEL ??= "error";
// The tests were written against the named model presets AIHOT assigns to each step (each provider is
// pointed at a local stub by the test that needs it). The open-source default is one model for every
// step, which tests/default-model.test.ts covers.
const AIHOT_MODELS: Record<string, string> = {
  PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection", UNDERSTAND_MODEL: "glm-5.3-flash", SUMMARIZE_MODEL: "deepseek-flash",
  STRUCTURE_MODEL: "qwen3.8-flash", GROUP_MODEL: "deepseek-flash", GROUP_REVIEW_MODEL: "mimo-v2.6-flash", DIGEST_MODEL: "deepseek-flash",
  REPORT_MODEL: "deepseek-flash", TRANSLATE_MODEL: "deepseek-flash", MONITOR_MODEL: "deepseek-flash",
};
for (const [name, model] of Object.entries(AIHOT_MODELS)) process.env[name] ??= model;

/**
 * A local HTTP stub standing in for a paid provider; `answer` builds every response from the request
 * (it may wait, to hold a request open while a test changes something).
 */
export async function stub(answer: (hit: number, req: { url: string; body: string }) => unknown) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      hits += 1;
      const out = await answer(hits, { url: req.url ?? "/", body: Buffer.concat(chunks).toString("utf8") });
      const reply = out instanceof Reply ? out : { status: 200, json: out };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A stub answer with its own status (e.g. a provider's 503); anything else is a 200 JSON body. */
export class Reply {
  readonly status: number;
  readonly json: unknown;
  constructor(status: number, json: unknown) {
    this.status = status;
    this.json = json;
  }
}

/** A promise with its resolve function, to hold a stub's answer until a test releases it. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** A short unique tag for the rows a test creates. */
export const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Delete everything the tagged fixture built on top of its stories: the stories, their facts, their
 * hourly heat and the articles those facts report. Any file that writes `stories` must call this in
 * `after()` — the `*_test` database outlives the run, and a leftover story is still a hot-board
 * candidate for 48 hours. Measured 2026-10-03: 11 leftover stories from earlier runs left the board's
 * 10 slots full, so `hot-heat.test.ts` found its own story missing from the ranking and failed on how
 * many runs had come before it rather than on the code under test.
 *
 * The source sweep at the end runs even when the tag created no story. It used to sit behind an early
 * return on an empty story list, so files that only insert an article and a source (analyze-shutdown
 * does) cleaned up nothing: every run left three selected Chinese rows behind, each anchoring above
 * later tests on the home timeline (measured 2026-10-03: 30 rows across ten runs).
 */
export async function purgeTagged(...tags: string[]): Promise<void> {
  // Imported here, not at the top of the file: `db.ts` must not run before the DATABASE_URL guard above.
  const { sql } = await import("@aihot/backend/db");
  const like = tags.map((t) => `%${t}%`);
  const stories = await sql<{ id: number }[]>`
    SELECT DISTINCT s.id FROM stories s
    LEFT JOIN facts f ON f.story_id = s.id
    WHERE s.title LIKE ANY(${like}::text[]) OR f.public_id LIKE ANY(${like}::text[])
       OR s.merged_into = ANY(coalesce((
            SELECT array_agg(DISTINCT s2.id) FROM stories s2
            LEFT JOIN facts f2 ON f2.story_id = s2.id
            WHERE s2.title LIKE ANY(${like}::text[]) OR f2.public_id LIKE ANY(${like}::text[])), '{}'))`;
  const ids = stories.map((s) => s.id);
  const facts = ids.length === 0 ? [] : await sql<{ id: number }[]>`SELECT id FROM facts WHERE story_id = ANY(${ids})`;
  const factIds = facts.map((f) => f.id);
  // An article is deleted once the fact that reported it is gone: the schema cascades publications,
  // analyses, signals and the rest from `articles`, so this is the whole article-side cleanup.
  const articles = factIds.length === 0 ? [] : (await sql<{ article_id: string }[]>`
    SELECT DISTINCT article_id FROM fact_articles WHERE fact_id = ANY(${factIds})`).map((r) => r.article_id);
  if (ids.length > 0) await sql`DELETE FROM story_aliases WHERE story_id = ANY(${ids})`;
  if (articles.length > 0) await sql`DELETE FROM articles WHERE id = ANY(${articles}::text[])`;
  if (ids.length > 0) await sql`DELETE FROM facts WHERE story_id = ANY(${ids})`;
  if (ids.length > 0) await sql`DELETE FROM stories WHERE id = ANY(${ids})`;
  // Its own sources and articles go too: an enabled leftover reads as a source that has fallen behind in
  // sourceClocks(), which is the very state the heat tests reason about.
  await sql`DELETE FROM articles WHERE source_id LIKE ANY(${like}::text[])`;
  await sql`DELETE FROM sources WHERE id LIKE ANY(${like}::text[])`;
}

/**
 * Fail with a named reason instead of waiting forever. Every await on a stub's `gate()` goes through this:
 * a request the stub cannot route (a step whose system prompt stopped matching the module constant) would
 * otherwise leave the test blocked until the runner cancels the whole file at `--test-timeout` (120 s),
 * which hides the cause. 30 s is about fifteen times the measured latency of a worker start plus one
 * stubbed model call, so it only ever fires on a real deadlock.
 */
export async function within<T>(promise: Promise<T>, ms = 30_000, label = "a stub response"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no ${label} within ${ms}ms — the provider stub never routed this step`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
