import type { Db } from "pg-boss";

const QUEUES = new Set(["content.analyze", "content.extract-body", "events.group", "events.digest"]);
const HISTORY_TURNS = new Set([2, 5, 8]);

/** Reserve three successful claims in ten for older priorities; unused shares return to live work.
 * This changes only candidate eligibility inside pg-boss's existing atomic SKIP LOCKED claim.
 * It never changes a job's data, receipt identity, retry time, lease, or total concurrency.
 */
export class BacklogShare {
  private readonly claimed = new Map<string, number>();

  async execute(db: Db["executeSql"], queue: string, text: string, values: unknown[] | undefined, now: number): ReturnType<Db["executeSql"]> {
    if (!QUEUES.has(queue)) return db(text, values);
    const turn = this.claimed.get(queue) ?? 0;
    let result;
    if (HISTORY_TURNS.has(turn % 10)) {
      // Fresh priorities are twice the observed epoch minute. Legacy zero/negative priorities
      // are old work too. A rolling 48 h cut-off keeps today's work ahead of historical repair.
      const cutoff = Math.floor((now - 48 * 3600_000) / 60_000) * 2;
      const needle = "AND NOT j.blocked";
      if (text.split(needle).length !== 2 || !/LIMIT 1\s+FOR UPDATE OF j SKIP LOCKED/.test(text)) {
        throw new Error("Unrecognised pg-boss claim for backlog fairness");
      }
      result = await db(text.replace(needle, `${needle} AND j.priority < ${cutoff}`).replace("ORDER BY j.priority desc, j.created_on", "ORDER BY j.created_on, j.id"), values);
    }
    if (!result?.rows.length) result = await db(text, values);
    if (result.rows.length) this.claimed.set(queue, turn + 1);
    return result;
  }
}
