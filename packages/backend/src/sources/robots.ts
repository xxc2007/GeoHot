// robots.txt fetch / parse / cache. Fail-closed on admission (caller decides), fail-open on already-running
// collection (a site's robots going down must not freeze the whole pool). RFC 9309: 404/410 means allow all.
import { guardedFetch } from "../lib/http-fetch.ts";

export interface RobotsRule { path: string; allow: boolean }

export interface RobotsEntry {
  fetchedAt: number;
  status: "ok" | "missing" | "error";
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
  error?: string;
}

export interface RobotsDecision {
  /** true when we positively know the URL is allowed; false when a Disallow rule matched. */
  allowed: boolean;
  /** null when robots.txt said nothing or we could not fetch it. */
  crawlDelaySeconds: number | null;
  /** false when robots.txt could not be fetched (network/timeout); caller must decide fail-open vs fail-closed. */
  known: boolean;
  reason: string;
}

const cache = new Map<string, RobotsEntry>();
const OK_TTL_MS = 24 * 3600_000;
const ERROR_TTL_MS = 3600_000;

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function robotsUrlOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/robots.txt`;
}

/** Parse a robots.txt body into the * and GeoHot user-agent groups. Other agent groups are ignored:
 *  we are one crawler, and mixing groups would let a Disallow for "Twitterbot" silently block us. */
function parseRobots(text: string, entry: RobotsEntry): void {
  let applyToStar = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      const v = value.trim().toLowerCase();
      applyToStar = v === "*" || v.includes("geohot");
      continue;
    }
    if (!applyToStar) continue;
    if (field === "disallow") {
      if (value) entry.rules.push({ path: value, allow: false });
    } else if (field === "allow") {
      if (value) entry.rules.push({ path: value, allow: true });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) entry.crawlDelaySeconds = Math.min(n, 3600);
    }
  }
}

/**
 * Pure decision from a fetched entry. Exported for tests.
 *  - missing (404/410) → allow all
 *  - error → known=false, allowed=true (caller decides)
 *  - longest-path rule wins (Allow overrides Disallow when more specific)
 */
export function decideFromEntry(url: string, entry: RobotsEntry): RobotsDecision {
  let u: URL;
  try { u = new URL(url); } catch {
    return { allowed: false, crawlDelaySeconds: null, known: false, reason: "invalid url" };
  }
  if (entry.status === "missing") {
    return { allowed: true, crawlDelaySeconds: null, known: true, reason: "robots.txt 404/410, allow all" };
  }
  if (entry.status === "error") {
    return { allowed: true, crawlDelaySeconds: null, known: false, reason: `robots.txt unavailable: ${entry.error ?? "unknown"}` };
  }
  const path = u.pathname || "/";
  let matched: RobotsRule | null = null;
  for (const rule of entry.rules) {
    if (path.startsWith(rule.path)) {
      if (!matched || rule.path.length > matched.path.length) matched = rule;
    }
  }
  const allowed = matched ? matched.allow : true;
  return {
    allowed,
    crawlDelaySeconds: entry.crawlDelaySeconds,
    known: true,
    reason: matched ? `matched ${matched.allow ? "Allow" : "Disallow"} ${matched.path}` : "no matching rule",
  };
}

/** Fetch (or return cached) robots.txt for the URL's host. Never throws. */
export async function fetchRobots(url: string): Promise<RobotsEntry> {
  let host: string;
  try { host = hostOf(url); } catch {
    return { fetchedAt: Date.now(), status: "error", rules: [], crawlDelaySeconds: null, error: "invalid url" };
  }
  const cached = cache.get(host);
  if (cached && Date.now() - cached.fetchedAt < (cached.status === "error" ? ERROR_TTL_MS : OK_TTL_MS)) {
    return cached;
  }
  const entry: RobotsEntry = { fetchedAt: Date.now(), status: "error", rules: [], crawlDelaySeconds: null };
  try {
    const res = await guardedFetch(robotsUrlOf(url), { timeoutMs: 10_000, maxBytes: 64 * 1024, route: "direct" });
    if (res.status === 404 || res.status === 410) {
      entry.status = "missing";
    } else if (res.status >= 200 && res.status < 300) {
      entry.status = "ok";
      parseRobots(res.text(), entry);
    } else {
      entry.error = `HTTP ${res.status}`;
    }
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
  }
  cache.set(host, entry);
  return entry;
}

/**
 * Decide whether fetching `url` is allowed by that host's robots.txt.
 *  - 404/410 → allowed (RFC 9309)
 *  - network error → known=false, allowed=true (caller must treat unknown as its own policy)
 *  - matching rule → longest-path wins (Allow overrides Disallow when more specific)
 */
export async function checkUrl(url: string): Promise<RobotsDecision> {
  let u: URL;
  try { u = new URL(url); } catch {
    return { allowed: false, crawlDelaySeconds: null, known: false, reason: "invalid url" };
  }
  void u;
  const entry = await fetchRobots(url);
  return decideFromEntry(url, entry);
}

/** Test hook: drop the in-memory cache between cases. */
export function clearRobotsCache(): void { cache.clear(); }

/** Read the cached robots entry for a URL's host without re-fetching. Returns null when never fetched. */
export function getCachedRobots(url: string): RobotsEntry | null {
  try {
    const host = hostOf(url);
    return cache.get(host) ?? null;
  } catch {
    return null;
  }
}
