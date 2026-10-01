// Stops the detached development cluster started by `node scripts/dev-db.ts --daemon`: a clean
// `pg_ctl stop -m fast` on .pgdata, then it reaps the launcher process the PID file points at.
//   node scripts/dev-db-down.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, ".pgdata");
const PID_FILE = path.join(DATA_DIR, "dev-db.pid");
const BUNDLE_DIR = path.join(ROOT, "node_modules/@embedded-postgres/windows-x64");

/**
 * pg_ctl lives in the platform bundle `embedded-postgres` picked at install time. On a machine whose
 * project path is not pure ASCII, scripts/dev-db.ts mirrors the Windows bundle into an all-ASCII
 * directory (see the header there) — prefer that copy, since pg_ctl decodes paths the same way.
 */
function findPgCtl(): string | null {
  const exe = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  const bundles: Record<string, string> = {
    "win32-x64": "@embedded-postgres/windows-x64",
    "darwin-arm64": "@embedded-postgres/darwin-arm64",
    "darwin-x64": "@embedded-postgres/darwin-x64",
    "linux-x64": "@embedded-postgres/linux-x64",
    "linux-arm64": "@embedded-postgres/linux-arm64",
  };
  const pkg = bundles[`${process.platform}-${process.arch}`];
  if (!pkg) return null;
  const inBundle = path.join(ROOT, "node_modules", pkg, "native", "bin", exe);
  if (pkg !== "@embedded-postgres/windows-x64") return existsSync(inBundle) ? inBundle : null;

  let version = "";
  try {
    version = JSON.parse(readFileSync(path.join(BUNDLE_DIR, "package.json"), "utf8")).version;
  } catch {
    /* the bundle is not installed */
  }
  const shim = version ? path.join(path.parse(ROOT).root, "geohot-embedded-postgres", `windows-x64-${version}`, "native", "bin", exe) : null;
  return shim && existsSync(shim) ? shim : existsSync(inBundle) ? inBundle : null;
}

/** The PID recorded in the pid file, or null when the file is missing or unreadable. */
function recordedPid(): number | null {
  try {
    return Number(readFileSync(PID_FILE, "utf8").trim().replace(/\D.*$/, "")) || null;
  } catch {
    return null;
  }
}

const ctlPath = findPgCtl();
if (!ctlPath) {
  console.error("dev-db-down: no pg_ctl in node_modules — run npm i -D embedded-postgres@17.10.0-beta.17 first");
  process.exit(1);
}
if (!existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
  rmSync(PID_FILE, { force: true });
  console.log("dev-db-down: no cluster in .pgdata — nothing to stop");
  process.exit(0);
}

const status = spawnSync(ctlPath, ["status", "-D", DATA_DIR], { encoding: "utf8" });
if (status.status !== 0) {
  rmSync(PID_FILE, { force: true });
  console.log("dev-db-down: cluster is not running");
  process.exit(0);
}

/** Line 4 of postmaster.pid is the port the cluster answers on, so the message says which one went down. */
function clusterPort(): number | null {
  try {
    return Number(readFileSync(path.join(DATA_DIR, "postmaster.pid"), "utf8").split(/\r?\n/)[3]?.trim()) || null;
  } catch {
    return null;
  }
}
const port = clusterPort();

const stop = spawnSync(ctlPath, ["stop", "-D", DATA_DIR, "-m", "fast"], { encoding: "utf8" });
for (const line of `${stop.stdout ?? ""}${stop.stderr ?? ""}`.split(/\r?\n/)) if (line.trim()) console.log(`pg_ctl: ${line.trim()}`);
if (stop.status !== 0) {
  console.error(`dev-db-down: pg_ctl stop failed (exit ${stop.status})`);
  process.exit(1);
}

// The detached launcher only waits for a signal, so it needs reaping — but only when that PID really
// still is a node process, since a stale pid file could point at anything by now.
function launcherAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const listing = spawnSync("tasklist", ["/NH", "/FO", "CSV", "/FI", `PID eq ${pid}`], { encoding: "utf8" });
  const line = String(listing.stdout ?? "").split(/\r?\n/).find((row) => row.includes(`"${pid}"`)) ?? "";
  return /^"?node(\.exe)?/i.test(line);
}

const pid = recordedPid();
if (pid) {
  if (launcherAlive(pid)) process.kill(pid);
  else console.log(`dev-db-down: launcher pid ${pid} is already gone`);
}
rmSync(PID_FILE, { force: true });
console.log(`dev-db-down: stopped${port ? ` (127.0.0.1:${port})` : ""}`);
