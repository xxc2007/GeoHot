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
// `default` 这个预设的模型名来自 LLM_MODEL（别的预设都把自己的模型名写在注册表里），所以一旦夹具改回
// 「不点名」，每个测试都必须有一个 LLM_MODEL 才能让 `default` 可用。名字只是回执上的标签——各测试
// 把它自己的 stub 接到 LLM_BASE_URL 上，模型 id 不参与任何解析。
process.env.LLM_MODEL ??= "test-default-model";
// 夹具改回「每一步都是 default」之后，整条管道的调用全落在 `llm` 这一扇门上，而它的分钟窗是
// 8 次（0066 迁移按对端实测墙设的）。一个测试文件跑十几次模型调用就会撞上它，于是一次路由/归组
// 断言会因为"额度用完"而不是"断言错了"变红。这里把 `llm` 的分钟窗抬到 500（与 model-pool.test.ts
// 原来的做法一致），hour/day 窗不动——它们量的是花费，测试用的 stub 不花钱。
// 只在 `_test`/`_ci` 库上生效：本文件顶部已经拒过任何别的库名。
// The tests were written against the named model presets AIHOT assigns to each step (each provider is
// pointed at a local stub by the test that needs it). The open-source default is one model for every
// step, which tests/default-model.test.ts covers.
// 2026-10-21: 这里原来把十一步逐一点名到具体厂商的预设（qwen3.7-flash / glm-5.3-flash-selection /
// deepseek-flash / …）。那些预设已随「没有可用凭据的模型」一并从注册表删除，而测试验的是**管道行为**——
// 预筛、两次打分、理解、结构、归组、成刊、回执复用——不是「哪个厂商被选中」。所以夹具回到开源默认形态：
// 不点名任何一步，让每个能力落回 `default`（由各测试自己指向的 LLM_BASE_URL stub 应答）。
// 需要「不同步骤打不同门」的那几条用例（model-pool / workbuddy-headroom）在自己的文件里显式点名。

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
  const fromSources = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id LIKE ANY(${like}::text[])`;
  await sql`DELETE FROM articles WHERE source_id LIKE ANY(${like}::text[])`;
  await sql`DELETE FROM sources WHERE id LIKE ANY(${like}::text[])`;
  // 向量缓存按 `(kind, ref_id, model)` 存，**没有外键**：删掉条目/事实/事件带不走它。
  // 留着就是下一轮的假象——`recallFacts` 与预筛都读这张表，一条上轮的向量能让这一轮"已经算过"，
  // 于是"这一步会付一次 embedding 费"这类断言永远看不见那次调用。
  // 2026-10-11 实测：`signals.test.ts` 把 `EMBEDDINGS_ENABLED` 打开之后，`analyze.test.ts` 六条用例
  // 在整套连跑时红、单跑绿——红的不是被测代码，是这张没人扫的表。
  const refs = [...articles, ...fromSources.map((r) => r.id), ...factIds.map(String), ...ids.map(String)];
  if (refs.length > 0) await sql`DELETE FROM embeddings WHERE ref_id = ANY(${refs}::text[])`;
  await purgeOrphanJobs();
}

/**
 * Drop waiting queue work whose subject row is gone. Deleting an article takes its analyses, publications
 * and signals with it (the schema cascades), but it cannot reach into pg-boss: our rows are the parentless
 * side of that link, so `data->>'articleId'` outlives the article it names.
 *
 * Measured 2026-10-10 in `geohot_test`: 9,940 rows still in state `created`, 9,800 of them naming an
 * article, story or source that no longer exists — about 700 per run, because the files that enqueue work
 * (`queueProcessing`, `publishArticle`) run their `after()` before anything drains them. The cost is not
 * disk: pg-boss hands out work `priority DESC, created_on ASC`, so a later run that starts a real worker is
 * served an earlier run's garbage first. `analyze-shutdown.test.ts` already has to name its own queues to
 * isolate itself from exactly this.
 *
 * Only rows whose subject is *missing* go: a job still pointing at a live article is somebody's test, and
 * a test that means to leave one pending (a retry, a shutdown mid-flight) is unaffected.
 */
export async function purgeOrphanJobs(): Promise<void> {
  const { sql } = await import("@aihot/backend/db");
  // pg-boss 的 schema 是 worker 第一次启动时才建的，所以一个只跑过 migrations 的库里根本没有 pgboss.job：
  // 那属于"还没有我们自己的排队行"的状态，无话可扫。在这里抛错会把文档里那条"对全新迁移库跑测试"的路
  // 直接打死（2026-10-16 在 geohot_fulltext_ci 上实测：relation "pgboss.job" does not exist）。
  const [exists] = await sql<{ present: boolean }[]>`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`;
  if (!exists?.present) return;
  await sql`
    DELETE FROM "pgboss"."job" j
     WHERE j.state = 'created'
       AND (
         (j.data ? 'articleId' AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = j.data ->> 'articleId'))
         OR (j.data ? 'storyId' AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.id::text = j.data ->> 'storyId'))
         OR (j.data ? 'sourceId' AND NOT EXISTS (SELECT 1 FROM sources r WHERE r.id = j.data ->> 'sourceId'))
         OR (j.data ? 'sourceIds' AND NOT EXISTS (
              SELECT 1 FROM sources r WHERE r.id = ANY(SELECT jsonb_array_elements_text(j.data -> 'sourceIds'))))
       )`;
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

/**
 * 夹具统一落到 `llm` 之后，8 次/分的分钟窗会先把测试自己拦住。抬它，hour/day 保持不动。
 *
 * 这里**不能**借 `@aihot/backend/db` 去做：那个模块导出的是全局连接池，模块级 import 之后没人关它，
 * 而 node 的测试运行器要等事件循环空下来才收工——2026-10-21 实测，`egress-and-feedback.test.ts`
 * 四条用例全过，却因为这一个空转的连接池把整个文件拖到 200 秒被判失败。所以这里开一条一次性连接、
 * 用完立刻 end()。
 */
{
  const { default: postgres } = await import("postgres");
  const url = process.env.DATABASE_URL!;
  const one = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    // 三个窗一起抬：夹具集中到一扇门之后，分钟的 8、小时的 420、天的 6,000 都会先于被测逻辑撞上。
    // 这些用例验的是管道行为，不是对端墙位；stub 不花钱，所以抬高不改变任何被测语义。
    await one`UPDATE budgets SET per_minute = 5000, per_hour = 100000, per_day = 1000000 WHERE service = 'llm'`;
  } finally {
    await one.end({ timeout: 5 });
  }
}
