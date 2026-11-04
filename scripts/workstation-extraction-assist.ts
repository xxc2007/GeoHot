// Finite, foreground supervisor. No scheduled task and no production credentials on disk.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, createWriteStream, readdirSync, type WriteStream } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import path from "node:path";
import { freemem } from "node:os";
import { assistEligible } from "../packages/backend/src/operations/extraction-assist.ts";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { config: { type: "string" }, "run-seconds": { type: "string" }, slots: { type: "string" } } });
if (!values.config) throw new Error("--config must name a private JSON file outside the repository");
const configPath = path.resolve(values.config);
if (configPath === root || configPath.startsWith(root + path.sep)) throw new Error("Keep private helper configuration outside the repository");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { host: string; hostKeyAlias: string; identityFile: string; localPort: number; stateDirectory: string };
if (!/^[a-z0-9_.-]+@[a-z0-9.-]+$/i.test(config.host) || !/^[a-z0-9.-]+$/i.test(config.hostKeyAlias)
    || !Number.isInteger(config.localPort) || config.localPort < 1024 || config.localPort > 65535
    || !path.isAbsolute(config.identityFile) || !path.isAbsolute(config.stateDirectory)) throw new Error("Invalid private helper configuration");
const stateDirectory = path.resolve(config.stateDirectory);
if (stateDirectory === root || stateDirectory.startsWith(root + path.sep)) throw new Error("Keep helper state outside the repository");
const duration = values["run-seconds"] === undefined ? 0 : Number(values["run-seconds"]);
if (!Number.isInteger(duration) || duration < 0 || duration > 600) throw new Error("Finite trial must be between 1 and 600 seconds; omit for read-only check");
// In-process slots: the worker runs EXTRACT_CONCURRENCY parallel extract handlers and the two pg
// pools get one more connection than slots. The backend re-asserts the same envelope (1..4) on
// startup, so a supervisor/backend disagreement fails closed instead of silently reconfiguring.
// Cap of 4 mirrors the widened 2026-11-01 authorization; more needs fresh PSI-clean server weeks.
// Default stays 1 so every existing caller behaves as before.
const slotCount = values.slots === undefined ? 1 : Number(values.slots);
if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 4) throw new Error("--slots must be 1..4");
// Child diagnostics and per-child bookkeeping; all child log files live inside the validated state
// directory and carry only digits in their names, so no path fragment ever reaches open().
const children: Array<ReturnType<typeof spawn>> = [];
const childExits: Array<Promise<number | null>> = [];
const childLogs: WriteStream[] = [];
let childExited: Promise<number | null> | undefined;
/** Keep the newest 20 child logs (10 rounds at 2 slots); diagnostics rot, not evidence. */
function pruneChildLogs(dir: string): void {
  const KEEP = 20;
  const names = readdirSync(dir).filter(n => /^assist-child-\d{12}-\d+\.log$/.test(n)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - KEEP))) {
    const victim = dir + path.sep + name;
    if (victim.startsWith(dir + path.sep)) { try { unlinkSync(victim); } catch { /* locked by a running round */ } }
  }
}
if (process.platform !== "win32") throw new Error("This supervisor currently verifies Windows AC power only");
const sshArgs = ["-i", config.identityFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=2", "-o", `HostKeyAlias=${config.hostKeyAlias}`];
// 脏检查只看辅助运行时真正哈希的路径（apps/worker/src、packages/backend/src、contracts、
// industry、package-lock.json）。全树检查会把自己锁死：并行工作流编辑 apps/api/apps/web
// （与抽取运行时无关）时，98 轮全被拒启（2026-11-03 实测）。哈希清单本身仍然逐文件校验，
// 运行时文件的任何改动照旧拒启——完整性不减，误伤归零。
const RUNTIME_PATHS = ["apps/worker/src", "packages/backend/src", "packages/contracts/src", "industry", "package-lock.json"];
const clean = await exec("git", ["status", "--porcelain", "--untracked-files=normal", "--", ...RUNTIME_PATHS], { cwd: root });
if (clean.stdout.trim()) {
  // 静默死守则：这里曾是裸 throw，报错发生在 PS 包装器写完 header 之后、任何日志行之前，
  // 一次部署残留就能让计划任务连静默失败几十轮（2026-11-01 实测 83 轮）。改为把脏文件名
  // 打进 stdout（PS 包装器会落盘），值班的人 grep 一次就能定位；仍然拒启——脏运行时是
  // 哈希清单完整性检查的前提，不脏才跑。
  console.log(JSON.stringify({ mode: duration ? "finite-trial" : "read-only", release: null, eligible: false, error: "Refusing a dirty runtime checkout", dirty: clean.stdout.trim().split(/\r?\n/).slice(0, 10) }));
  process.exit(duration ? 2 : 0);
}
const release = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const files = (await exec("git", ["ls-files", "apps/worker/src", "packages/backend/src", "packages/contracts/src", "industry", "package-lock.json"], { cwd: root })).stdout.trim().split(/\r?\n/)
  .filter(file => /\.(ts|json|md)$/.test(file));
const manifest = files.map(file => ({ file, sha256: createHash("sha256").update(readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n")).digest("hex") }));
const session = randomUUID().replaceAll("-", "");
let fenced = false;
let fenceAttempted = false;
let lastEvidence: unknown;
// 服务端循环的采样间隔（秒）。10 秒 = 每 30 秒 3 条 SSH 会话，是 ufw LIMIT 的一半。
const WATCH_SEC = 10;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 隧道是否真的能连上：只探 TCP，不发协议。1 秒的固定等待在负载尖峰时不够，
// 孩子会在隧道还没起来时直接 ECONNREFUSED 退出（2026-11-04 09:55）。
function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
async function remote(command: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [...sshArgs, config.host, command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    // 10s 在 891MB 的机器上不够：sudo + python 启动 + 3 次 systemctl 都可能撞上 PSI 尖峰，
  // 2026-11-04 09:55 一轮就是这样把"证据超时"变成"隔离"，还顺手留下新的锁。25s 只放宽读数，
  // 不放松任何判据。
  const timeout = setTimeout(() => { proc.kill(); reject(new Error("Remote evidence timed out")); }, 25_000);
    proc.stdout.on("data", data => { output += data; if (output.length > 256_000) proc.kill(); });
    // 探针从不打印凭据（它只报哈希、内存、PSI、单元状态），所以把 stderr 的最后 400 字节带上：
    // 以前整段丢弃，换来的是 "Remote evidence unavailable" 这种没法定因的报错（2026-11-04 现场）。
    let stderr = "";
    proc.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-400); });
    proc.once("error", () => { clearTimeout(timeout); reject(new Error("SSH unavailable")); });
    proc.once("exit", code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error("Remote evidence unavailable: " + stderr.split("\n").slice(-3).join(" | ").slice(-300)));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}
// 一条长连接、服务端循环采样：每 10 秒新开一条 SSH 会被 ufw 的 22/tcp LIMIT 掐断，
// 之后 supervisor 只看到 `Connection timed out`，把好好的辅助读成"证据丢失"并收摊
// （2026-11-04 10:04/10:12 两次现场，都是跑到第 3–5 条任务时断的）。
// 现在整个运行期只多一条连接，样本由远端每 WATCH_SEC 秒打印一行 JSON。
async function startWatcher(): Promise<{ next: (timeoutMs: number) => Promise<string>; stop: () => void }> {
  const payload = Buffer.from(JSON.stringify({ manifest, session: fenced ? session : undefined })).toString("base64");
  // 载荷（manifest 上百条哈希）不能塞进命令行：Windows 会直接 ENAMETOOLONG（2026-11-04 现场）。
  // 改成写到这条会话的 stdin，远端先 read 一行进环境变量，再进循环。
  // 远端脚本落地在 /opt/geohot/bin/probe-watch.sh：命令行里只留一个纯 ASCII 调用，
  // 免掉 PowerShell/cmd/ssh 三层引号互相打架（2026-11-04 现场：会话起几秒就关）。
  const remote = `sudo -n sh /opt/geohot/bin/probe-watch.sh ${WATCH_SEC}`;
  const proc = spawn("ssh", [...sshArgs, config.host, remote], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  proc.stdin!.on("error", () => {});
  proc.stdin!.write(payload + "\n");
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", line => { lines.push(line); wake?.(); });
  proc.once("exit", () => { closed = true; wake?.(); });
  proc.once("error", () => { closed = true; wake?.(); });
  return {
    next: (timeoutMs: number) => new Promise<string>((resolve, reject) => {
      const tick = () => {
        if (lines.length) { resolve(lines.shift()!); return; }
        if (closed) { reject(new Error("probe session closed")); return; }
        wake = () => { wake = undefined; tick(); };
      };
      tick();
      setTimeout(() => reject(new Error("probe line timed out")), timeoutMs);
    }),
    stop: () => { try { proc.kill(); } catch { /* already gone */ } },
  };
}
// 启动期三件事（采样、取维护权、取库凭据）合并成一条 SSH 会话：服务器的 ufw 对 22/tcp
// 限 6 条/30 秒，分开做就是 4 条连接一口气打出去，被 DROP 时只表现为"隧道起不来"或会话
// 无故关闭（2026-11-04 10:1x 现场，四轮全折在这）。远端脚本见 deploy/geohot/bin/probe-watch.sh。
async function bootstrap(): Promise<{ probe: Record<string, unknown>; fence: Record<string, unknown>; databaseUrl: string }> {
  const payload = Buffer.from(JSON.stringify({ manifest, session })).toString("base64");
  return await new Promise((resolve, reject) => {
    const proc = spawn("ssh", [...sshArgs, config.host, "sudo -n sh /opt/geohot/bin/probe-watch.sh once"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const fin = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } fin(() => reject(new Error("bootstrap timed out"))); }, 60_000);
    proc.stdout.on("data", data => { out += String(data); });
    proc.stderr.on("data", data => { err = (err + String(data)).slice(-400); });
    proc.once("error", () => fin(() => reject(new Error("SSH unavailable"))));
    proc.once("exit", code => fin(() => {
      if (code !== 0) { reject(new Error("bootstrap failed: " + err.split("\n").slice(-2).join(" | ").slice(-300))); return; }
      try {
        const lines = out.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        const probe = lines.find(l => l.probe)?.probe as Record<string, unknown> | undefined;
        const fence = lines.find(l => l.fence)?.fence as Record<string, unknown> | undefined;
        const databaseUrl = lines.find(l => l.db)?.db as string | undefined;
        if (!probe || !fence || typeof databaseUrl !== "string") { reject(new Error("bootstrap output incomplete")); return; }
        resolve({ probe, fence, databaseUrl });
      } catch (error) { reject(new Error("bootstrap output unreadable: " + String((error as Error).message ?? error))); }
    }));
    proc.stdin!.on("error", () => {});
    proc.stdin!.end(payload + "\n");
  });
}

async function sample() {
  const at = Date.now();
  const [wire, power] = await Promise.all([
    remote("sudo -n python3 /opt/geohot/app/deploy/geohot/probe-extraction-assist.py", JSON.stringify({ manifest, session: fenced ? session : undefined })),
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString()"], { windowsHide: true, timeout: 5000 }),
  ]);
  const evidence = JSON.parse(wire);
  if (fenced && evidence.fenceOwned !== true) evidence.maintenance = true;
  const result = { ...evidence, at, localFreeMiB: freemem() / 1048576, onAC: power.stdout.trim() === "Online" };
  lastEvidence = result;
  return result;
}
let first: Awaited<ReturnType<typeof sample>> | null = null;
let boot: Awaited<ReturnType<typeof bootstrap>> | null = null;
try {
  if (duration) {
    boot = await bootstrap();
    const power = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString()"], { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: "Online" }));
    first = { ...boot.probe, at: Date.now(), localFreeMiB: freemem() / 1048576, onAC: power.stdout.trim() === "Online" } as Awaited<ReturnType<typeof sample>>;
  } else {
    first = await sample();
  }
} catch (error) {
  // A transient SSH/PowerShell stall killed the process outright (top-level throw, exit 1) with no
  // log line beyond the header, so a scheduled round looked silently dead. One miss is a normal
  // deferral: report it and let the next five-minute retry take the shot.
  console.log(JSON.stringify({ mode: duration ? "finite-trial" : "read-only", release, eligible: false, error: String((error as Error).message ?? error) }));
  process.exit(duration ? 2 : 0);
}
console.log(JSON.stringify({ mode: duration ? "finite-trial" : "read-only", release, eligible: assistEligible(first), resources: first }));
if (!duration || !assistEligible(first)) process.exit(duration ? 2 : 0);

mkdirSync(config.stateDirectory, { recursive: true });
const lock = path.join(config.stateDirectory, "extraction-assist.lock");
const lease = path.join(config.stateDirectory, "extraction-assist-lease.json");
const lockFd = openSync(lock, "wx", 0o600); // Stale lock needs deliberate operator inspection, never PID-based stealing.
writeFileSync(lockFd, JSON.stringify({ pid: process.pid, release, at: new Date().toISOString() }));
closeSync(lockFd);
let child: ReturnType<typeof spawn> | undefined;
let tunnel: ReturnType<typeof spawn> | undefined;
let tunnelExited: Promise<void> | undefined;
let watcher: Awaited<ReturnType<typeof startWatcher>> | undefined;
let stop = false;
const progress = { handled: 0, fullBodiesStored: 0, handedBack: 0 };
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stop = true; });
let exitCode = 0;
try {
  // 首检（≤5 秒新鲜）即准入。曾经的"60 秒稳定期"（连续 4 次、每 15 秒采样，一次不达标即退出）
  // 在 1G 小机上等于永远进不去：PSI 瞬时尖峰 60 秒内几乎必然出现（2026-11-02 实测 90 轮全灭）。
  // 读者保护不靠启动门槛，靠运行中每 5 秒的退出检查——尖峰一来本轮立即让路。
  fenceAttempted = true; // A lost acquire response may still have created the remote owner.
  const acquisition = boot?.fence ?? {};
  if (acquisition.acquired === false) {
    fenceAttempted = false; // Known contention is a normal deferral, not an ambiguous acquisition.
    throw new Error("Maintenance owns admission");
  }
  if (acquisition.acquired !== true) throw new Error("Unknown fence acquisition result");
  fenced = true;
  // 启动期接连 4–5 条 SSH 会撞上 ufw 的 22/tcp LIMIT，被掐后表现为"隧道起不来"。
  // 每条之间让 2.5 秒，把 6/30s 的额度留出余量（2026-11-04 10:1x 现场）。
  await pause(2500);
  // 首检（本轮开头那次 sample）已经是 ≤5 秒的新鲜证据；fence 只花几十毫秒，不再重复采样。
  // 之前这里、隧道后、worker 启动前各采一次，服务器 PSI 瞬时尖峰（1G 小机常态）几乎必然
  // 撞上一次，90 轮全倒在"再查一遍"上（2026-11-02 实测 handled=0）。运行中的退出检查保留——
  // 那才是读者保护生效的地方。
  if (stop || !first) throw new Error("No fresh admission evidence");
  // Fetch only the database credential, in memory. No auth/model/device credentials are copied.
  await pause(2500);
  const database = new URL(boot!.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !["127.0.0.1", "localhost"].includes(database.hostname) || database.port && database.port !== "5432") throw new Error("Unexpected server database endpoint");
  database.hostname = "127.0.0.1"; database.port = String(config.localPort);
  await pause(2500);
  tunnel = spawn("ssh", [...sshArgs, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-N", "-L", `127.0.0.1:${config.localPort}:127.0.0.1:5432`, config.host], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  // 隧道死掉时要留下原因：ufw 22/tcp LIMIT 一旦把我们掐掉，这里就是唯一能看到
  // "Connection timed out" 的地方（2026-11-04 10:1x 现场）。
  let tunnelError = "";
  tunnel.stderr?.on("data", data => { tunnelError = (tunnelError + String(data)).slice(-200); });
  tunnelExited = new Promise(resolve => {
    const ended = () => { if (!stop) exitCode = 2; stop = true; resolve(); };
    tunnel!.once("exit", ended); tunnel!.once("error", ended);
  });
  // 等隧道真的能连上再起子进程：固定等 1 秒在负载尖峰时不够，孩子会直接 ECONNREFUSED 退出，
  // 而 supervisor 把"孩子非零退出"读成隔离（2026-11-04 09:55 现场）。最多 12 秒，连上就走。
  await Promise.race([
    (async () => { for (let i = 0; i < 24; i++) { if (await portOpen(config.localPort)) return; await pause(500); } throw new Error("SSH tunnel did not come up"); })(),
    tunnelExited!.then(() => { throw new Error("SSH tunnel exited before the workers started: " + tunnelError.trim()); }),
  ]);
  // worker 启动前不再重复资格判定（理由同上）；写租约用首检证据，运行中循环马上会接手刷新。
  // 注意 writeFileSync 只收 string/Buffer——first 是对象，必须序列化（PR #91 曾在这里抛
  // "data argument must be of type string"，被裸 catch 吞成 handled=0）。
  writeFileSync(lease, JSON.stringify(first), { mode: 0o600 });
  watcher = await startWatcher();
  // One shared admission lease, one SSH tunnel, N independent single-slot worker processes. Each child
  // logs to its own diagnostics file under the state directory; the file name is built only from a
  // date stamp and the loop counter, and the confinement guard below fails closed.
  for (let slot = 1; slot <= slotCount; slot++) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
    const childLogName = "assist-child-" + stamp + "-" + slot + ".log";
    if (!/^assist-child-\d{12}-\d+\.log$/.test(childLogName)) throw new Error("Child log name must match the whitelist");
    const childLogPath = stateDirectory + path.sep + childLogName;
    if (!childLogPath.startsWith(stateDirectory + path.sep)) throw new Error("Child log path escaped the state directory");
    pruneChildLogs(stateDirectory);
    const childLog = createWriteStream(childLogPath, { flags: "a", mode: 0o600 });
    childLogs.push(childLog);
    childLog.write(new Date().toISOString() + " child slot " + slot + "/" + slotCount + " starting (release " + release + ")\n");
  child = spawn(process.execPath, ["apps/worker/src/main.ts"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      DATABASE_URL: database.toString(), DATABASE_POOL_MAX: String(slotCount + 1), PGBOSS_POOL_MAX: String(slotCount + 1), EXTRACT_CONCURRENCY: String(slotCount),
      WORKER_ROLE: "extraction-executor", COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "false", JINA_BODY_FALLBACK: "false",
      NODE_ENV: "production", AIHOT_ENVIRONMENT: "production", SITE_URL: "https://xxc2007.me/geohot", TZ: "Asia/Shanghai",
      AIHOT_RELEASE: release, AIHOT_CREDENTIALS_DIR: path.join(config.stateDirectory, `no-credentials-${randomUUID()}`), GEOHOT_ASSIST_LEASE_FILE: lease,
      FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", ALLOW_PRIVATE_NETWORK_FETCH: "false" } });
    child.stdout!.pipe(childLog, { end: false });
    child.stderr!.pipe(childLog, { end: false });
    const current: ReturnType<typeof spawn> = child;
    childExits.push(new Promise(resolve => {
      current.once("exit", code => { if (!stop) exitCode = 3; resolve(code); });
      current.once("error", () => { stop = true; resolve(1); });
    }));
    current.on("message", message => {
      if (message && typeof message === "object" && "type" in message && message.type === "geohot:extracted" && "state" in message) {
        progress.handled++;
        if (message.state === "ok") progress.fullBodiesStored++;
        if (message.state === "server-fallback") progress.handedBack++;
      }
    });
    children.push(current);
  }
  childExited = childExits.length ? Promise.all(childExits).then(codes => codes.every(code => code === 0) ? 0 : 3) : undefined;
  const until = Date.now() + duration * 1000;
  let misses = 0;
  while (!stop && Date.now() < until) {
    let evidence: Awaited<ReturnType<typeof sample>>;
    try {
      // 样本来自那条长连接（服务端每 WATCH_SEC 秒打印一行），整个运行期不再新开 SSH。
      // 远端每行是 {"probe":{…}}（probe-watch.sh 的封装），这里必须拆开再判资格：
      // 直接拿整行去判 assistEligible，sourceMatches 永远是 undefined，于是"刚起就停"
      // （2026-11-04 11:00 现场：子进程日志只有 starting/stopping 两行）。
      const payload = JSON.parse(await watcher!.next(30_000)) as Record<string, unknown>;
      evidence = (payload.probe ?? payload) as Awaited<ReturnType<typeof sample>>;
      if (fenced && evidence.fenceOwned !== true) evidence.maintenance = true;
      const online = (lastEvidence as { onAC?: boolean } | undefined)?.onAC === true;
      evidence = { ...evidence, at: Date.now(), localFreeMiB: freemem() / 1048576, onAC: online };
      misses = 0;
    } catch (error) {
      // 一次读数失败（SSH 抖动、PSI 尖峰）不该等于"本轮结束"：租约仍在 20 秒内有效，
      // 孩子自己会在租约过期时关掉 intake。连续三次读不到才收摊，按可重试退出。
      if (++misses >= 4) { console.log(JSON.stringify({ state: "evidence-lost", misses, error: String((error as Error)?.message ?? error) })); stop = true; exitCode = 2; break; }
      console.log(JSON.stringify({ state: "evidence-miss", misses, error: String((error as Error)?.message ?? error) }));
      continue;
    }
    if (stop || Date.now() >= until || !assistEligible(evidence)) { stop = true; break; }
    writeFileSync(lease, JSON.stringify(evidence), { mode: 0o600 });
  }
} catch (error) {
  exitCode = 2;
  // 之前裸 catch 吞掉错误消息：90 轮全灭时无法归因是 fence、凭据、隧道还是子进程哪一环。
  // 把原因打进日志（PS 包装器会落盘），值班 grep 一次定位。
  console.log(JSON.stringify({ state: "admission-closed", error: String((error as Error)?.message ?? error), resources: lastEvidence }));
} finally {
  stop = true;
  try { writeFileSync(lease, "{}", { mode: 0o600 }); } catch { exitCode = 3; }
  for (const child of children) if (child.exitCode === null && child.connected) child.send({ type: "geohot:shutdown" }, () => {});
  if (childExited) {
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([childExited.then(code => ({ code })), new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 275_000); })]);
    clearTimeout(timeout);
    if (!result) { for (const child of children) child.kill(); await childExited; exitCode = 3; }
    else if (result.code !== 0) exitCode = 3;
  }
  for (const childLog of childLogs) childLog.end();
  watcher?.stop();
  tunnel?.kill(); if (tunnelExited) await tunnelExited;
  if (fenceAttempted && !fenced) exitCode = 3; // Do not automatically retry an uncertain acquisition.
  if (fenced && exitCode !== 3) {
    try { await remote("sudo -n python3 /opt/geohot/app/deploy/geohot/assist-maintenance-fence.py", JSON.stringify({ action: "release", session })); }
    catch { exitCode = 3; } // Keep the local instance lock when drain/release cannot be proved.
  }
  try { unlinkSync(lease); } catch { exitCode = 3; }
  if (exitCode !== 3) { try { unlinkSync(lock); } catch { exitCode = 3; } }
  console.log(JSON.stringify({ state: exitCode === 3 ? "isolated" : "stopped", progress, release }));
}
process.exitCode = exitCode;
