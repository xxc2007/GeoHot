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
 */
export interface ReprioritizeResult {
  promoted: number;
  demoted: number;
}

export async function reprioritizeAnalyzeQueue(now = new Date()): Promise<ReprioritizeResult> {
  const fresh = await sql<{ n: number }[]>`
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
    SELECT count(*)::int AS n FROM changed`;
  const stale = await sql<{ n: number }[]>`
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
    SELECT count(*)::int AS n FROM changed`;
  return { promoted: fresh[0]?.n ?? 0, demoted: stale[0]?.n ?? 0 };
}
