// Local development database for GEOHOT: a persistent PostgreSQL 17 cluster in .pgdata, started with
// the binaries bundled by `embedded-postgres`. No admin rights, no service install, no Docker.
//   node scripts/dev-db.ts              # foreground (Ctrl-C stops it cleanly)
//   node scripts/dev-db.ts --daemon     # detached; PID in .pgdata/dev-db.pid, log in $TMPDIR
//   node scripts/dev-db.ts --port=5455  # spare port (also honours DEV_DB_PORT)
//   node scripts/dev-db-down.ts         # stop the detached cluster
// Cluster: port 5433 unless overridden, superuser geohot/geohot, database geohot — see .env (DATABASE_URL).
// Two clones must not fight over 5433: pass --port=<n> (or DEV_DB_PORT=<n>) and point DATABASE_URL at the
// same number, e.g. `npm run env:init -- --db-port=5455`, which rewrites DATABASE_URL for you.
//
// Two Windows quirks this file works around, both needed for a Chinese-named project folder:
//  - `initdb` wants an empty data directory, so the daemon log lives outside .pgdata and the PID file
//    is only written once the cluster exists.
//  - PostgreSQL turns the argv/CWD bytes it gets from the C runtime into text in the cluster encoding,
//    so a non-ASCII *binary* path aborts initdb with `invalid byte sequence for encoding "UTF8"`
//    (GBK bytes). The fix is a pure-ASCII lookup package junctioned into node_modules below; the data
//    directory itself may stay non-ASCII. `npm ci` removes that lookup entry, and this script rebuilds
//    it on the next run.
import { openSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, ".pgdata");
const PID_FILE = path.join(DATA_DIR, "dev-db.pid");
const LOG_FILE = path.join(os.tmpdir(), "geohot-dev-db.log");
const VERSION_FILE = path.join(DATA_DIR, "PG_VERSION");
const BUNDLE_DIR = path.join(ROOT, "node_modules/@embedded-postgres/windows-x64");
/** Home of the ASCII lookup package; named by bundle version, so an upgrade cannot reuse a stale copy. */
const SHIM_ROOT = path.join(path.parse(ROOT).root, "geohot-embedded-postgres");

const DEFAULT_PORT = 5433;

/** Cluster port: `--port=<n>` / `--port <n>` beats `DEV_DB_PORT`, which beats the 5433 default. */
function resolvePort(): number {
  const inline = process.argv.find((a) => a.startsWith("--port="));
  const flagIndex = process.argv.indexOf("--port");
  const raw = inline ? inline.slice("--port=".length) : flagIndex > -1 ? process.argv[flagIndex + 1] : process.env.DEV_DB_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`dev-db: --port must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  return port;
}

/**
 * The port also lives in `.env` as `DATABASE_URL`, so an override here is only half the story; warn
 * instead of letting migrate/seed silently talk to whatever cluster answers on the old port.
 */
function warnOnEnvPortMismatch(): void {
  try {
    const url = /^DATABASE_URL=(\S+)/m.exec(readFileSync(path.join(ROOT, ".env"), "utf8"))?.[1];
    const old = url && /:(\d+)\//.exec(url);
    if (old && Number(old[1]) !== PORT) {
      console.log(`dev-db: WARNING — .env DATABASE_URL points at port ${old[1]}, not ${PORT}. Start on ${old[1]}, or regenerate: npm run env:init -- --db-port=${PORT}`);
    }
  } catch {
    /* no .env yet — nothing to compare against */
  }
}

const PORT = resolvePort();
const USER = "geohot";
const PASSWORD = "geohot";
const DATABASE = "geohot";

const verbose = process.argv.includes("--verbose");

const isAscii = (value: string) => !/[^ -~]/.test(value);

/** Create (or repair) a Windows junction, which needs no admin rights and no copying. */
function junction(target: string, link: string, probe?: string): void {
  let current: string | null = null;
  try {
    current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "not a link";
  } catch {
    current = null;
  }
  if (current === target) {
    if (probe && !existsSync(path.join(link, probe))) throw new Error(`junction ${link} -> ${target} does not resolve`);
    return;
  }
  if (current !== null) rmSync(link, { force: true });
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
  if (probe && !existsSync(path.join(link, probe))) throw new Error(`junction ${link} -> ${target} does not resolve`);
}

/**
 * The bundled binaries sit under a Chinese project path on this machine, which PostgreSQL cannot
 * decode; expose them through an all-ASCII package that node resolves before the real one.
 * Returns the directory the binaries are reached through, or null when the plain path is fine.
 */
function ensureAsciiBinaries(): string | null {
  if (process.platform !== "win32") return null;
  if (!existsSync(path.join(BUNDLE_DIR, "native/bin/postgres.exe"))) {
    throw new Error("embedded-postgres binaries missing — run npm i -D embedded-postgres@17.10.0-beta.17 first");
  }
  const nativeDir = path.join(BUNDLE_DIR, "native");
  if (isAscii(nativeDir)) return nativeDir;

  const version = JSON.parse(readFileSync(path.join(BUNDLE_DIR, "package.json"), "utf8")).version as string;
  const shim = path.join(SHIM_ROOT, `windows-x64-${version}`);
  if (!isAscii(shim)) throw new Error(`no ASCII location available for the postgres binaries (${shim})`);

  // A real copy of the tiny JS payload, so the resolved module URL — and therefore the binary paths it
  // builds from it — stay ASCII; `native` (100 MB) is only junctioned.
  const distDir = path.join(shim, "dist");
  mkdirSync(distDir, { recursive: true });
  copyFileSync(path.join(BUNDLE_DIR, "package.json"), path.join(shim, "package.json"));
  for (const file of readdirSync(path.join(BUNDLE_DIR, "dist"))) copyFileSync(path.join(BUNDLE_DIR, "dist", file), path.join(distDir, file));
  junction(nativeDir, path.join(shim, "native"), "bin/postgres.exe");

  // Node resolves from the importer outwards, so this lookup entry wins over node_modules/@embedded-postgres.
  junction(shim, path.join(ROOT, "node_modules/embedded-postgres/node_modules/@embedded-postgres/windows-x64"), "native/bin/postgres.exe");

  const binaries = path.join(shim, "native");
  if (!existsSync(path.join(binaries, "bin/postgres.exe"))) throw new Error(`ascii binary shim did not resolve: ${binaries}`);
  if (verbose) console.log(`dev-db: postgres binaries reached through ${binaries}`);
  return binaries;
}

/** True when something already accepts connections on the cluster port. */
function listening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

ensureAsciiBinaries();
warnOnEnvPortMismatch();

/** True when this checkout's own cluster exists — a busy port without it means someone else's server. */
const ownClusterExists = () => existsSync(VERSION_FILE);
const collisionHint = () => (ownClusterExists() ? "" : ` — this .pgdata holds no cluster, so that server belongs to another checkout; start yours on a free port: npm run db:up -- --daemon --port=5455`);

// ---- daemon: re-spawn this same file detached, record its PID, wait for readiness, then exit ----
if (process.argv.includes("--daemon")) {
  if (await listening()) {
    console.log(`dev-db: already listening on 127.0.0.1:${PORT} — nothing to do${collisionHint()}`);
    process.exit(0);
  }
  const log = openSync(LOG_FILE, "a");
  // The detached child re-derives everything from argv, so the port override has to travel with it.
  const child = spawn(process.execPath, [import.meta.filename, `--port=${PORT}`], { cwd: ROOT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  if (!child.pid) {
    console.error("dev-db: could not start the detached process");
    process.exit(1);
  }
  console.log(`dev-db: launching pid ${child.pid} (log: ${LOG_FILE})`);
  // The first run creates the cluster with initdb, which takes minutes on a spinning disk, so the
  // timeout is generous. The PID file is only written once the port answers: initdb needs .pgdata empty.
  if (!(await waitFor(() => listening(), 600_000))) {
    console.error(`dev-db: nothing listening on ${PORT} after 10 min — see ${LOG_FILE}`);
    process.exit(1);
  }
  writeFileSync(PID_FILE, `${child.pid}\n`);
  console.log(`dev-db: ready — postgres://${USER}:****@127.0.0.1:${PORT}/${DATABASE} (pid ${child.pid})`);
  process.exit(0);
}

if (await listening()) {
  console.log(`dev-db: already listening on 127.0.0.1:${PORT} — nothing to do${collisionHint()}`);
  process.exit(0);
}
mkdirSync(DATA_DIR, { recursive: true });

// postgres.exe output is kept so a failed start can be told with its own words.
const captured: string[] = [];
const relay = (message: unknown) => {
  const text = String(message).trim();
  if (!text) return;
  captured.push(text);
  if (captured.length > 400) captured.shift();
  if (verbose) console.log(`pg: ${text}`);
};

const { default: EmbeddedPostgres } = await import("embedded-postgres");

/**
 * initdb would otherwise take collation/ctype — and often the encoding — from the Windows locale, and
 * could end up with SQL_ASCII or GBK; UTF8 is not negotiable for this site's content. The ctype also has
 * to be multibyte-aware: under the plain C locale `show_trgm('三角洲')` returns nothing, so every
 * gin_trgm_ops index (migrations 0001 and 0014) would silently never match a Chinese search. ICU gives
 * Chinese text real trigrams, and pinyin ordering for lists.
 */
const INITDB_FLAGS = ["--locale-provider=icu", "--icu-locale=zh-CN", "--encoding=UTF8"];

const cluster = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  port: PORT,
  user: USER,
  password: PASSWORD,
  initdbFlags: INITDB_FLAGS,
  authMethod: "scram-sha-256",
  persistent: true,
  onLog: relay,
  onError: relay,
});

// PG_VERSION is written by initdb and is the only reliable "this cluster exists" marker.
const alreadyInitialised = existsSync(VERSION_FILE);

let stopping = false;

/** The PID recorded in the pid file, or null when there is none — so we only ever clean up our own. */
function recordedPid(): number | null {
  try {
    return Number(readFileSync(PID_FILE, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

const clearPidFile = () => {
  if (recordedPid() === process.pid) rmSync(PID_FILE, { force: true });
};

const stop = async (reason: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`dev-db: stopping (${reason})`);
  try {
    await cluster.stop();
  } catch (error) {
    relay(error);
  }
  clearPidFile();
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void stop(signal));

try {
  if (!alreadyInitialised) {
    // A pid file left by a launcher that died would make initdb refuse the directory.
    rmSync(PID_FILE, { force: true });
    console.log(`dev-db: initialising a new cluster in ${path.relative(ROOT, DATA_DIR)} (${INITDB_FLAGS.join(" ")})`);
    await cluster.initialise();
  }
  console.log(`dev-db: starting postgres on 127.0.0.1:${PORT} as ${USER}`);
  await cluster.start();

  const client = cluster.getPgClient("postgres");
  await client.connect();
  if ((await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE])).rowCount === 0) {
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(DATABASE)} OWNER ${client.escapeIdentifier(USER)} ENCODING 'UTF8'`);
    console.log(`dev-db: created database ${DATABASE}`);
  }
  const encoding: string = (await client.query("SHOW server_encoding")).rows[0].server_encoding;
  const version: string = (await client.query("SHOW server_version")).rows[0].server_version;
  await client.end();
  if (encoding !== "UTF8") throw new Error(`cluster encoding is ${encoding}, expected UTF8`);

  writeFileSync(PID_FILE, `${process.pid}\n`);
  console.log(`dev-db: ready — postgres://${USER}:****@127.0.0.1:${PORT}/${DATABASE} (pid ${process.pid}, PostgreSQL ${version}, encoding ${encoding}). Ctrl-C stops it.`);
  // The server is a child process; keep the event loop alive so this can run as a foreground dev process.
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(`dev-db: failed to start — ${error instanceof Error ? error.message : String(error)}`);
  console.error(captured.slice(-15).join("\n"));
  clearPidFile();
  process.exit(1);
}
