// Process heartbeats for the runs view and the watchdog: one settings row per process role and host.
//
// 键里必须带主机名：武汉和杭州两台执行器的 role 都是 content-executor，只按 role 存会互相覆盖，
// 后台「协同节点」表里就永远只看得见最后心跳的那一台。
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";
import { readFileSync, statfsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "../db.ts";

const startedAt = new Date().toISOString();

// 上一次采样的 CPU 时间片，用来算一分钟内的占用率（远端机器没有 node_exporter，就地算最省事）。
let lastCpu = snapshotCpu();

function snapshotCpu() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercent(): number | null {
  const now = snapshotCpu();
  const total = now.total - lastCpu.total;
  const idle = now.idle - lastCpu.idle;
  lastCpu = now;
  if (total <= 0) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}

function memInfo(): { swapTotal: number; swapFree: number } {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const pick = (key: string) => Number.parseInt(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? "", 10) * 1024;
    return { swapTotal: pick("SwapTotal") || 0, swapFree: pick("SwapFree") || 0 };
  } catch {
    return { swapTotal: 0, swapFree: 0 };
  }
}

// 每台机器自己报本机的 systemd 单元：面板要像看主库那样看辅助机，而不是只看到一个心跳点。
const UNIT_NAMES = [
  "geohot-exec-tunnel",
  "geohot-exec-worker",
  "geohot-exec-window-day.timer",
  "geohot-exec-window-night.timer",
  "geohot-backup.timer",
  "geohot-probe.timer",
];

const run = promisify(execFile);

// 单元状态缓存：每秒问 systemctl 会把 worker 的启动拖慢，而状态本来就一分钟才变一次。
// beat() 只读缓存，刷新在后台跑，且五分钟最多一次。
type ServiceRow = { name: string; state: string; memory: number; restarts: number };
let serviceCache: ServiceRow[] = [];
let serviceCacheAt = 0;
let serviceRefreshing = false;

function refreshUnits(): void {
  if (process.platform !== "linux" || serviceRefreshing) return;
  if (Date.now() - serviceCacheAt < 300_000) return;
  serviceRefreshing = true;
  void units()
    .then((rows) => { serviceCache = rows; serviceCacheAt = Date.now(); })
    .catch(() => { serviceCacheAt = Date.now(); })
    .finally(() => { serviceRefreshing = false; });
}

async function units(): Promise<ServiceRow[]> {
  const found: ServiceRow[] = [];
  await Promise.all(UNIT_NAMES.map(async (name) => {
    try {
      const { stdout } = await run("systemctl", ["show", "-p", "ActiveState", "-p", "MemoryCurrent", "-p", "NRestarts", name], { timeout: 2_500 });
      const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? "";
      const state = get("ActiveState");
      if (!state) return;
      const memory = Number.parseInt(get("MemoryCurrent"), 10);
      found.push({ name, state, memory: Number.isFinite(memory) && memory > 0 ? memory : 0, restarts: Number.parseInt(get("NRestarts"), 10) || 0 });
    } catch {
      // 单元不存在（比如本机执行器）就不报，别让一条心跳为此失败。
    }
  }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function listeningPorts(): string[] {
  try {
    const text = readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1);
    const ports = new Set<string>();
    for (const line of text) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4 || columns[3] !== "0A") continue;
      const port = Number.parseInt(columns[1]?.split(":")[1] ?? "", 16);
      if (Number.isFinite(port) && port > 0) ports.add(String(port));
    }
    return [...ports].sort((a, b) => Number(a) - Number(b));
  } catch {
    return [];
  }
}

export async function beat(role: string, detail: Record<string, unknown> = {}) {
  const slots = Number.parseInt(process.env.GEOHOT_INTAKE_ANALYSIS_SLOTS ?? "", 10);
  const swap = memInfo();
  // 每台机器自己报体检数据：后台面板要能看见远端节点的负载、内存、磁盘与单元状态，而不是只有主库的六项服务。
  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try {
    const fsStat = statfsSync(process.cwd());
    diskFree = fsStat.bavail * fsStat.bsize;
    diskTotal = fsStat.blocks * fsStat.bsize;
  } catch {
    // 读不到磁盘就留空，不要让心跳整体失败。
  }
  refreshUnits();
  const ports = listeningPorts();
  const value = {
    ...detail,
    load: Number(loadavg()[0].toFixed(2)),
    loadAll: loadavg().map(n => Number(n.toFixed(2))),
    cpus: cpus().length,
    cpuPercent: cpuPercent(),
    memTotal: totalmem(),
    memFree: freemem(),
    swapTotal: swap.swapTotal,
    swapFree: swap.swapFree,
    diskFree,
    diskTotal,
    uptime: Math.round(uptime()),
    platform: process.platform,
    kernel: process.platform === "linux" ? readFileSync("/proc/sys/kernel/osrelease", "utf8").trim() : "",
    services: serviceCache,
    ports,
    slots: Number.isFinite(slots) ? slots : null,
    pid: process.pid,
    host: hostname(),
    release: process.env.AIHOT_RELEASE ?? "dev",
    startedAt,
    at: new Date().toISOString(),
  };
  // 键默认仍是 heartbeat.<role>（主库 worker、api 与告警面都按这个名字找），
  // 但每台辅助机器可以在自己的 .env 里用 GEOHOT_HEARTBEAT_KEY 指定带主机名的键，
  // 否则两台 content-executor 会写同一行、后心跳的那台把先前的覆盖掉。
  const key = process.env.GEOHOT_HEARTBEAT_KEY?.trim() || `heartbeat.${role}`;
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json(value)}, ${role})
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
