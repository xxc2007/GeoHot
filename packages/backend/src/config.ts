// Runtime configuration. Secrets are loaded per group (models, collectors, integrations, auth)
// from dotenv files, and only by the backend processes that need them.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { SITE } from "@aihot/industry/site";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const env = process.env;

export const isProduction = env.NODE_ENV === "production";

/**
 * Whether this process is meant to answer public traffic. The two gates disagree by design today —
 * `assertProductionSecrets` below keys off NODE_ENV, the dev-login bypass keys off AIHOT_ENVIRONMENT
 * (`environmentName`, and `admin/auth.ts` with it) — so a deployment that sets only one of them is half
 * hardened. Anything that would leak the deployment's own public address to readers checks both.
 */
const servesPublicTraffic = isProduction || env.AIHOT_ENVIRONMENT === "production";

function str(name: string, fallback?: string): string {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

/**
 * One rule for "a positive whole number somebody configured", for the numbers that are *tuning* rather
 * than required: an unparseable or non-positive value keeps running on the default and prints one line
 * naming the number actually in force. Taking a bad value literally here is not a crash-on-config — it is
 * a silent shape change: `ANALYZE_CONCURRENCY=two` reached pg-boss as `localConcurrency: NaN`,
 * `DATABASE_POOL_MAX=auto` would reach the pool as `max: NaN`, `ALERT_QUIET_MINUTES=` a NaN millisecond
 * window, and `initialBackfillLimit=3O` (letter O) made `slice(0, NaN)` store nothing while the round still
 * reported `ok` and closed that source's history window. `publication/pool.ts` wrote this rule for its two
 * 503 guards after living through exactly that ("an unparseable value used to become NaN, which makes both
 * guards false"); this is the same rule in one place, and it takes the value rather than only an
 * environment name because the config that can be wrong is not always in the environment.
 */
export function positiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  // A boolean is not a number wearing a costume: `true` would read as 1 and quietly halve a concurrency.
  const value = typeof raw === "boolean" ? Number.NaN : Number(raw);
  if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  console.log(JSON.stringify({ level: "warn", msg: `${name}=${JSON.stringify(raw)}: using ${fallback} (not a positive whole number)` }));
  return fallback;
}

/**
 * The one rule for a boolean environment valve, shared by every gate in the project. `1` and `true` (any
 * case) mean on; every other non-empty value — `0`, `off`, `false`, `FALSE`, a typo — means off; an empty or
 * missing value falls back to what the caller decides. Read it where the decision is made (`isCollectEnabled`
 * below) rather than storing it, so a process never argues with itself about the same variable name.
 */
export function envFlag(name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * `COLLECT_ENABLED`: may this process reach the 82 pollable upstream sources at all? Off means off — no
 * `sources.schedule`, no source jobs, no alerting about a collection that was never asked to run.
 * An empty or missing value means on, which is what a deployment writes down explicitly (`.env.example`
 * ships `false`, and the deploy bootstrap refuses to rely on the default); development gets "off" from the file
 * (when started with --env-file=.env). The suite does NOT: `npm test` is plain `node --test` with no
 * --env-file, so there the flag reads its "on" fallback — what keeps tests off the internet is that no
 * test registers the schedules, and the ones that call models point *_BASE_URL at a local stub. `0`/`off`/`FALSE` all read as off, as the valve intends.
 */
export const isCollectEnabled = () => envFlag("COLLECT_ENABLED", true);

/** The same rule as `config.modelCallsEnabled`, read where it is used (that field is a snapshot, and tests flip it). */
export const isModelCallsEnabled = () => envFlag("MODEL_CALLS_ENABLED", true);

/** Loopback addresses: right on the developer's machine, wrong for anything a reader can reach. */
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/**
 * Every generated absolute link uses this address, whatever Host a request arrives with. With no
 * SITE_URL it falls back to the development address in `industry/site.ts`, which is correct in
 * development and silently wrong in production: canonical tags, OpenGraph URLs, the RSS `<link>`, the
 * sitemap `<loc>` entries, robots' Sitemap line and security.txt would all publish localhost, and the
 * MCP host lock (apps/api/src/routes/mcp.ts:219) would then reject the real host. A public deployment
 * that forgot the variable, or copied the template value, refuses to boot instead.
 */
function siteUrl(): string {
  const value = str("SITE_URL", SITE.defaultUrl).replace(/\/+$/, "");
  if (!servesPublicTraffic) return value;
  let host = "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    host = "";
  }
  if (!host || LOCAL_HOST.test(host)) {
    throw new Error(`Refusing to start in production: SITE_URL is ${JSON.stringify(value)} — set it to the address readers actually use (https://example.com, or https://example.com/<prefix> behind a prefixing proxy). A missing or localhost SITE_URL publishes localhost into canonical tags, OpenGraph URLs, RSS, sitemap <loc>, robots' Sitemap line and security.txt, and makes the MCP host lock reject the real host.`);
  }
  return value;
}

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://127.0.0.1:5432/aihot"),
  apiPort: int("API_PORT", 3001),
  webPort: int("WEB_PORT", 3000),
  apiBaseUrl: str("API_BASE_URL", "http://127.0.0.1:3001"),
  // Every generated absolute link uses this address, whatever Host a request arrives with. In
  // production a missing or loopback value refuses to boot (see `siteUrl()` above).
  siteUrl: siteUrl(),
  selectedVisibleAfterSeconds: int("SELECTED_VISIBLE_AFTER_SECONDS", 180),
  egressProxyUrl: env.EGRESS_PROXY_URL || null,
  allowPrivateNetworkFetch: envFlag("ALLOW_PRIVATE_NETWORK_FETCH", false),
  feishuContentPushEnabled: envFlag("FEISHU_CONTENT_PUSH_ENABLED", false),
  indexNowSubmitEnabled: envFlag("INDEXNOW_SUBMIT_ENABLED", false),
  /** IndexNow key (32 hex characters); without one nothing is submitted and no key file is served. */
  indexNowKey: /^[0-9a-f]{32}$/.test(env.INDEXNOW_KEY ?? "") ? env.INDEXNOW_KEY! : null,
  /** Optional directory of per-group dotenv files (models.env, collectors.env, …); normally everything is in .env. */
  credentialsDir: env.AIHOT_CREDENTIALS_DIR || null,
  dataDir: str("AIHOT_DATA_DIR", path.join(REPO_ROOT, ".data")),
  // Name of this deployment in alerts ("production" sends them without a prefix).
  environmentName: str("AIHOT_ENVIRONMENT", isProduction ? "production" : "development"),
  // Model calls are live unless explicitly disabled (tests, replays).
  modelCallsEnabled: envFlag("MODEL_CALLS_ENABLED", true),
  devAdmin: env.DEV_AUTH_ROLE === "admin" ? { displayName: env.DEV_AUTH_DISPLAY_NAME || "Dev Admin" } : null,
  /** The admin password (at least 12 characters). Feishu sign-in below is optional. */
  adminPassword: env.ADMIN_PASSWORD || null,
  adminUnionIds: (env.ADMIN_FEISHU_UNION_IDS || "").split(",").map((v) => v.trim()).filter(Boolean),
  adminEmails: (env.ADMIN_EMAILS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
};

export type CredentialGroup = "models" | "collectors" | "integrations" | "auth";

const groupCache = new Map<CredentialGroup, Record<string, string>>();

/**
 * Loads one credential group from an optional dotenv file (AIHOT_CREDENTIALS_DIR/<group>.env). Values
 * in the environment always win; a normal deployment only uses environment variables (.env).
 */
export function credentials(group: CredentialGroup): Record<string, string> {
  const cached = groupCache.get(group);
  if (cached) return cached;
  const file = config.credentialsDir ? path.join(config.credentialsDir, `${group}.env`) : null;
  const parsed: Record<string, string> = file && existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>) : {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) merged[key] = env[key] ?? value;
  groupCache.set(group, merged);
  return merged;
}

export function credential(group: CredentialGroup, name: string): string | null {
  const value = env[name] ?? credentials(group)[name];
  return value && value.trim() !== "" ? value : null;
}

const PLACEHOLDER = /^(changeme|placeholder|dummy|test|xxx+|your[-_ ].*|<.*>)$/i;

/** Production refuses to start with missing or placeholder critical secrets, or dev-login bypasses. */
export function assertProductionSecrets(names: Array<[CredentialGroup, string]>): void {
  if (!isProduction) return;
  const problems: string[] = [];
  for (const [group, name] of names) {
    const value = credential(group, name);
    if (!value || PLACEHOLDER.test(value) || value.length < 8) problems.push(name);
  }
  for (const key of Object.keys(env)) if (key.startsWith("DEV_AUTH_")) problems.push(`${key} (dev login bypass)`);
  if (config.allowPrivateNetworkFetch) problems.push("ALLOW_PRIVATE_NETWORK_FETCH");
  if (problems.length > 0) throw new Error(`Refusing to start in production: ${problems.join(", ")}`);
}
