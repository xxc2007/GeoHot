import { sql } from "../db.ts";

/**
 * 让「今天的稿子」真的排在队伍前面。
 *
 * 2026-11-07 现场：`content.analyze` 里有 6,681 条 `created`，优先级只有 0 / -1 / -2 三种值
 * （都是 `balanced` 档没生效时写下的），于是 pg-boss 只能按先进先出取活——30 分钟里领走的
 * 143 条全是 10-30 的旧稿，当天 1,194 条一条没动，读者面「今天」只有 3 条。
 *
 * 这里不改入队逻辑（入队时算不出「谁在等」），而是在队列上做一次廉价的重排：
 * 三天内的稿子按「观察时刻的分钟数 × 2」抬到高位，和 `realTimePriority` 的活线同一数量级；
 * 更老的维持 0（谁都不抢），历史/回填的负优先级一个也不碰。
 *
 * 幂等、可反复跑、不发模型、不碰发布状态。
 *
 * 2026-11-07 补一处：新鲜度取 `GREATEST(published_at, discovered_at)`。老稿被重新发现时
 * `published_at` 还是上周，只按它算就会把「今天新出现的旧报道」当成存量继续压在队尾。
 *
 * 2026-11-27：它并不廉价。`a.id::text = j.data->>'articleId'` 是文本关联，pgboss.job 上没有任何
 * 涉及 `data->>'articleId'` 的表达式索引，于是每 5 分钟就是一次 articles（1.8GB）× pgboss.job 的
 * 全量扫描。现场抓到那条「降级」单条跑了 119.6 秒（wait_event=DataFileRead）、整次最长 522 秒；
 * `expire: 240` 到点后下一轮照常入队，两轮还会重叠（同刻两条同一条 SQL 在跑）。代价是真金白银的
 * IO，收益却常常是 `{"promoted":0,"demoted":0}`。
 *
 * 所以：一条 UPDATE 一个带预算的事务，跑不完（57014）就当这一轮没做、下一轮再来——它只是运营便利，
 * 读者不靠它出页；超预算的写事务被回滚，不会占着行锁。要把它变成索引扫描得在 pgboss.job 上建
 * `((data->>'articleId'))` 的表达式索引，那是一条迁移，需要单独批准，不在这条改动里。
 */
export interface ReprioritizeResult {
  promoted: number;
  demoted: number;
}

/** 单条 UPDATE 的预算。健康时这段关联是秒级；一旦要跑到几十秒，说明库已经在挨打，让路。 */
const REPRIORITIZE_BUDGET = "10s";

/**
 * 一条 UPDATE 一个带预算的事务：超时（57014）当这一条没做，并留一行日志。
 * 与 `admin/runs.ts` 的 `RELEASE_SCAN_BUDGET` 同一形态：运营便利的扫描不能把读者一起拖死。
 */
async function boundedUpdate(read: (db: typeof sql) => Promise<{ n: number }[]>): Promise<number> {
  try {
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${REPRIORITIZE_BUDGET}, true)`;
      return read(tx as unknown as typeof sql);
    });
    return rows[0]?.n ?? 0;
  } catch (error) {
    if ((error as { code?: string }).code === "57014") {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "queue reprioritize skipped: budget exhausted",
        budget: REPRIORITIZE_BUDGET,
      }));
      return 0;
    }
    throw error;
  }
}

export async function reprioritizeAnalyzeQueue(now = new Date()): Promise<ReprioritizeResult> {
  // 心跳式的 EXISTS 预检（`priority > 1000` 是否有活）**没有用**，不要再加回来：promoted 那条把三天内的
  // 活写成 `floor(epoch/60)*2`（2026-11-27 的 epoch≈1.79e9 ⇒ priority≈6e7），只要有一轮 promoted 成功过，
  // 队列里还没被领走的 content.analyze 就带着 6e7 躺在 created 里，预检恒为真，demote 照跑。
  // 而且那种预检自己是一条裸 sql、没有 statement_timeout，将来 content.analyze 若单独分区、
  // job_common 上的索引盖不到，它就是另一种「无超时全扫描」——与这次要修的病同型。
  // 所以这里只有预算，没有预检。
  const promoted = await boundedUpdate((db) => db`
    WITH changed AS (
      UPDATE pgboss.job j
         SET priority = LEAST(2147483646, GREATEST(20, floor(extract(epoch FROM LEAST(GREATEST(coalesce(a.published_at, a.discovered_at), a.discovered_at), ${now})) / 60) * 2)::int)
        FROM articles a
       WHERE j.name = 'content.analyze'
         AND j.state = 'created'
         AND j.priority >= 0
         AND a.id::text = j.data->>'articleId'
         AND GREATEST(coalesce(a.published_at, a.discovered_at), a.discovered_at) > ${now}::timestamptz - interval '3 days'
         AND j.priority < 1000
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM changed`);
  const demoted = await boundedUpdate((db) => db`
    WITH changed AS (
      UPDATE pgboss.job j
         SET priority = 0
        FROM articles a
       WHERE j.name = 'content.analyze'
         AND j.state = 'created'
         AND j.priority > 1000
         AND a.id::text = j.data->>'articleId'
         AND GREATEST(coalesce(a.published_at, a.discovered_at), a.discovered_at) < ${now}::timestamptz - interval '3 days'
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM changed`);
  return { promoted, demoted };
}
