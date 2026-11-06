// Process heartbeats for the runs view and the watchdog: one settings row per process role.
import { freemem, hostname, loadavg, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { sql } from "../db.ts";

const startedAt = new Date().toISOString();

export async function beat(role: string, detail: Record<string, unknown> = {}) {
  const slots = Number.parseInt(process.env.GEOHOT_INTAKE_ANALYSIS_SLOTS ?? "", 10);
  // 分析槽位写进心跳：后台服务器面板要靠它区分「在岗但只跑抓取」和「在岗且吃分析」的机器。
  // 每台机器自己报体检数据：后台面板要能看见远端节点的负载、内存、磁盘，而不是只有主库的六项服务。
  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try {
    const fsStat = statfsSync(process.cwd());
    diskFree = fsStat.bavail * fsStat.bsize;
    diskTotal = fsStat.blocks * fsStat.bsize;
  } catch {
    // 读不到磁盘就留空，不要让心跳整体失败。
  }
  const value = { ...detail, load: Number(loadavg()[0].toFixed(2)), memTotal: totalmem(), memFree: freemem(), diskFree, diskTotal, slots: Number.isFinite(slots) ? slots : null, pid: process.pid, host: hostname(), release: process.env.AIHOT_RELEASE ?? "dev", startedAt, at: new Date().toISOString() };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`heartbeat.${role}@${hostname()}`}, ${sql.json(value)}, ${role})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** Beats now and every minute until the process exits. */
export function startHeartbeat(role: string): NodeJS.Timeout {
  // A failed beat says the watchdog will read a stale row: report the change of state once instead of
  // once a minute, so a database blip is audible without becoming the only thing in the log.
  let failing = false;
  const beatOnce = () => void beat(role)
    .then(() => { failing = false; })
    .catch((error) => {
      if (failing) return;
      failing = true;
      console.error(JSON.stringify({ level: "error", msg: `heartbeat ${role} stopped`, error: String((error as Error)?.message ?? error) }));
    });
  beatOnce();
  const timer = setInterval(beatOnce, 60_000);
  timer.unref();
  return timer;
}
