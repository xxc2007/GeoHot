// The worker watchdog, run from the api process: the worker cannot report its own death.
import { sql } from "../db.ts";
import { beijingStamp, formatAlert, formatRecovery, sendAlert, type Finding } from "../notify/feishu.ts";

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row?.value ?? null;
}

async function writeSetting(key: string, value: unknown, by: string) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json(value as never)}, ${by})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

// The process manager restarts a crashed worker within seconds and a deploy restarts it on purpose;
// half an hour without a heartbeat means those did not help.
const WORKER_STALE_MS = 30 * 60_000;

const WORKER_DOWN: Finding = {
  key: "worker",
  level: "now",
  title: "后台处理服务停了，网站不会出现新内容",
  impact: "新内容的采集、处理、推送和日报全部暂停，网站停在旧内容上",
  heals: "系统自动重启没有成功",
  action: "转给 AI 立即处理",
};

/**
 * Runs in the api process (the worker cannot report its own death): alerts once when the worker's
 * heartbeat is older than half an hour, and once when it recovers. Several api processes may check;
 * the conditional update lets only one of them send.
 */
export async function checkWorkerHeartbeat(): Promise<void> {
  const [hb] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM settings WHERE key = 'heartbeat.worker'`;
  if (!hb) return;
  const stale = Date.now() - hb.updated_at.getTime() > WORKER_STALE_MS;
  const next = stale ? "down" : "up";
  const prior = await readSetting<{ state: string; since: string }>("watchdog.worker");
  if (!prior && !stale) {
    await writeSetting("watchdog.worker", { state: "up", since: new Date().toISOString() }, "api");
    return;
  }
  // "since" of a down state is the last heartbeat, so the recovery can say how long it lasted.
  const since = stale ? hb.updated_at.toISOString() : new Date().toISOString();
  const claimed = await sql`
    INSERT INTO settings (key, value, updated_by) VALUES ('watchdog.worker', ${sql.json({ state: next, since })}, 'api')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE settings.value->>'state' IS DISTINCT FROM ${next}
    RETURNING key`;
  if (!claimed.length) return;
  const msg = stale
    ? formatAlert({ ...WORKER_DOWN, detail: `worker 心跳停在 ${beijingStamp(hb.updated_at)}；看 worker 的日志（docker compose logs worker）` }, hb.updated_at, Date.now())
    : formatRecovery(WORKER_DOWN.title, new Date(prior?.state === "down" ? prior.since : hb.updated_at), Date.now());
  await sendAlert(msg.title, msg.lines);
}

export function startWorkerWatchdog(): NodeJS.Timeout {
  // This is the only thing that notices a dead worker, so its own failures must not be silent.
  const timer = setInterval(() => void checkWorkerHeartbeat().catch((error) => console.error(JSON.stringify({ level: "error", msg: "worker watchdog failed", error: String((error as Error)?.message ?? error) }))), 5 * 60_000);
  timer.unref();
  return timer;
}
