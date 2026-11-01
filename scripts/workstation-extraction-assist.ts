// Finite, foreground supervisor. No scheduled task and no production credentials on disk.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, createWriteStream, type WriteStream } from "node:fs";
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
// Slots are separate single-slot worker processes: the backend asserts one slot and one pooled
// connection per process (extraction-assist.ts), and pg-boss's SKIP LOCKED claim keeps two processes
// from taking the same job. Cap of 2 mirrors the 2026-11-01 second authorization; more needs fresh
// PSI-clean weeks on the server. Default stays 1 so every existing caller behaves as before.
const slotCount = values.slots === undefined ? 1 : Number(values.slots);
if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 2) throw new Error("--slots must be 1 or 2");
// Child diagnostics and per-child bookkeeping; all child log files live inside the validated state
// directory and carry only digits in their names, so no path fragment ever reaches open().
const children: Array<ReturnType<typeof spawn>> = [];
const childExits: Array<Promise<number | null>> = [];
const childLogs: WriteStream[] = [];
let childExited: Promise<number | null> | undefined;
if (process.platform !== "win32") throw new Error("This supervisor currently verifies Windows AC power only");
const sshArgs = ["-i", config.identityFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=2", "-o", `HostKeyAlias=${config.hostKeyAlias}`];
const clean = await exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root });
if (clean.stdout.trim()) throw new Error("Refusing a dirty runtime checkout");
const release = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const files = (await exec("git", ["ls-files", "apps/worker/src", "packages/backend/src", "packages/contracts/src", "industry", "package-lock.json"], { cwd: root })).stdout.trim().split(/\r?\n/)
  .filter(file => /\.(ts|json|md)$/.test(file));
const manifest = files.map(file => ({ file, sha256: createHash("sha256").update(readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n")).digest("hex") }));
const session = randomUUID().replaceAll("-", "");
let fenced = false;
let fenceAttempted = false;
let lastEvidence: unknown;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function remote(command: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [...sshArgs, config.host, command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Remote evidence timed out")); }, 10_000);
    proc.stdout.on("data", data => { output += data; if (output.length > 256_000) proc.kill(); });
    proc.stderr.resume(); // Never echo remote environment or credential diagnostics.
    proc.once("error", () => { clearTimeout(timeout); reject(new Error("SSH unavailable")); });
    proc.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error("Remote evidence unavailable")); });
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
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
try {
  first = await sample();
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
let stop = false;
const progress = { handled: 0, fullBodiesStored: 0, handedBack: 0 };
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stop = true; });
let exitCode = 0;
try {
  // A single good snapshot cannot open intake after a pressure spike.
  for (let n = 0; n < 4; n++) {
    await pause(15_000);
    if (stop || !assistEligible(await sample())) throw new Error("Admission did not stay healthy for 60 seconds");
  }
  fenceAttempted = true; // A lost acquire response may still have created the remote owner.
  const acquisition = JSON.parse(await remote("sudo -n python3 /opt/geohot/app/deploy/geohot/assist-maintenance-fence.py", JSON.stringify({ action: "acquire", session })));
  if (acquisition.acquired === false) {
    fenceAttempted = false; // Known contention is a normal deferral, not an ambiguous acquisition.
    throw new Error("Maintenance owns admission");
  }
  if (acquisition.acquired !== true) throw new Error("Unknown fence acquisition result");
  fenced = true;
  if (stop || !assistEligible(await sample())) throw new Error("Fenced admission closed");
  // Fetch only the database credential, in memory. No auth/model/device credentials are copied.
  const credentials = JSON.parse(await remote("cd /opt/geohot/app && sudo -n -u geohot node --env-file=.env --input-type=module -e 'console.log(JSON.stringify({databaseUrl:process.env.DATABASE_URL}))'")) as { databaseUrl: string };
  const database = new URL(credentials.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !["127.0.0.1", "localhost"].includes(database.hostname) || database.port && database.port !== "5432") throw new Error("Unexpected server database endpoint");
  database.hostname = "127.0.0.1"; database.port = String(config.localPort);
  tunnel = spawn("ssh", [...sshArgs, "-o", "ExitOnForwardFailure=yes", "-N", "-L", `127.0.0.1:${config.localPort}:127.0.0.1:5432`, config.host], { windowsHide: true, stdio: "ignore" });
  tunnelExited = new Promise(resolve => {
    const ended = () => { if (!stop) exitCode = 2; stop = true; resolve(); };
    tunnel!.once("exit", ended); tunnel!.once("error", ended);
  });
  await pause(1000);
  const evidence = await sample();
  if (stop || !assistEligible(evidence)) throw new Error("Admission closed before worker startup");
  writeFileSync(lease, JSON.stringify(evidence), { mode: 0o600 });
  // One shared admission lease, one SSH tunnel, N independent single-slot worker processes. Each child
  // logs to its own diagnostics file under the state directory; the file name is built only from a
  // date stamp and the loop counter, and the confinement guard below fails closed.
  for (let slot = 1; slot <= slotCount; slot++) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const childLogName = "assist-child-" + stamp + "-" + slot + ".log";
    if (!/^assist-child-\d{8}-\d+\.log$/.test(childLogName)) throw new Error("Child log name must match the whitelist");
    const childLogPath = stateDirectory + path.sep + childLogName;
    if (!childLogPath.startsWith(stateDirectory + path.sep)) throw new Error("Child log path escaped the state directory");
    const childLog = createWriteStream(childLogPath, { flags: "a", mode: 0o600 });
    childLogs.push(childLog);
    childLog.write(new Date().toISOString() + " child slot " + slot + "/" + slotCount + " starting (release " + release + ")\n");
  child = spawn(process.execPath, ["apps/worker/src/main.ts"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      DATABASE_URL: database.toString(), DATABASE_POOL_MAX: "1", PGBOSS_POOL_MAX: "1", EXTRACT_CONCURRENCY: "1",
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
  while (!stop && Date.now() < until) {
    await pause(5000);
    const evidence = await sample();
    if (stop || Date.now() >= until || !assistEligible(evidence)) { stop = true; break; }
    writeFileSync(lease, JSON.stringify(evidence), { mode: 0o600 });
  }
} catch {
  exitCode = 2;
  console.log(JSON.stringify({ state: "admission-closed", resources: lastEvidence }));
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
