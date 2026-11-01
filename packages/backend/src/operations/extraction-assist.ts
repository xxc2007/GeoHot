import { readFileSync } from "node:fs";
import type { PgBoss } from "pg-boss";
import { intakeQueue } from "./resource-intake.ts";

/** Local supervisor evidence is deliberately short lived; a suspended PC cannot reuse it. */
export function assistEligible(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const finite = (key: string) => typeof s[key] === "number" && Number.isFinite(s[key]);
  return ["at", "localFreeMiB", "remoteFreeMiB", "memoryFull", "ioFull"].every(finite)
    && now >= (s.at as number) && now - (s.at as number) <= 20_000
    && s.onAC === true && s.apiHealthy === true && s.workerAll === true && s.sourceMatches === true
    && s.maintenance === false && s.r115 === false
    && (s.localFreeMiB as number) >= 2048 && (s.remoteFreeMiB as number) >= 96
    && (s.memoryFull as number) >= 0 && (s.memoryFull as number) < 10
    && (s.ioFull as number) >= 0 && (s.ioFull as number) < 30;
}

/** Keep X/SocialData jobs on the server; no paid-provider job is claimed by this helper. */
export function extractionClaim(text: string): string | null {
  const queue = intakeQueue(text);
  if (!queue) return null;
  if (queue !== "content.extract-body") throw new Error("extraction-executor permits only body extraction");
  const needle = "AND NOT j.blocked";
  if (text.split(needle).length !== 2 || !/LIMIT 1\s+FOR UPDATE OF j SKIP LOCKED/.test(text)) {
    throw new Error("Unrecognised public extraction claim");
  }
  return text.replace(needle, `${needle} AND coalesce(j.data->>'serverOnly', 'false') <> 'true' AND EXISTS (SELECT 1 FROM public.articles assist_article
    WHERE assist_article.id = j.data->>'articleId' AND assist_article.x_post->>'tweetId' IS NULL)`);
}

export function installExtractionAssist(boss: PgBoss) {
  if (process.env.WORKER_ROLE !== "extraction-executor") return;
  const file = process.env.GEOHOT_ASSIST_LEASE_FILE;
  const slots = Number(process.env.EXTRACT_CONCURRENCY);
  const databasePool = Number(process.env.DATABASE_POOL_MAX);
  const pgbossPool = Number(process.env.PGBOSS_POOL_MAX);
  if (!file || !Number.isInteger(slots) || slots < 1 || slots > 4
      || databasePool !== slots + 1 || pgbossPool !== slots + 1) {
    throw new Error("extraction assist requires a supervisor lease, 1..4 slots, and one more pooled connection than slots");
  }
  const adapter = boss.getDb();
  const execute = adapter.executeSql.bind(adapter);
  adapter.executeSql = async (text, values) => {
    const claim = extractionClaim(text);
    if (!claim) return execute(text, values); // Completion and shutdown must remain possible.
    try {
      if (assistEligible(JSON.parse(readFileSync(file, "utf8")))) return execute(claim, values);
    } catch { /* Missing, partially written, or corrupt evidence closes intake. */ }
    return { rows: [] };
  };
}
