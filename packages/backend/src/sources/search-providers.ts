// Search provider adapter layer for GEOHOT.
//
// Status: NO provider is wired in the default chain. HTML-scraping providers (Bing SERP, DuckDuckGo
// results page) are NOT implemented here: their terms of service do not grant automated scraping, and
// robots.txt Allow is not a substitute. Official APIs (e.g. Azure Bing Search API, Exa, Tavily) may be
// added later behind env flags with a legal key; they do not require the local DSH bridge.
//
// This module provides the shared infrastructure (circuit breaker, cache, semaphore, metrics) that any
// future provider implementation will use. The default chain is empty; the feature flag is off.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export type FailureKind = "network" | "timeout" | "http_status" | "parse" | "circuit_open";

export interface ProviderFailure {
  kind: FailureKind;
  message: string;
  at: number;
}

export interface ProviderMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  lastFailure?: ProviderFailure;
}

export interface Provider {
  readonly name: string;
  search(query: string, opts?: { maxResults?: number; lang?: string }): Promise<SearchResult[]>;
  fetchPage(url: string, opts?: { maxChars?: number }): Promise<{ url: string; text: string; status: number }>;
}

// --- Circuit breaker (5 failures → 10 min cooldown) ------------------------

interface BreakerState { failures: number; openedAt: number | null; }
const breakers = new Map<string, BreakerState>();
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 10 * 60_000;

export function breakerAllow(name: string): boolean {
  const b = breakers.get(name);
  if (!b || b.openedAt === null) return true;
  if (Date.now() - b.openedAt > COOLDOWN_MS) { b.openedAt = null; b.failures = 0; return true; }
  return false;
}
function recordSuccess(name: string): void {
  const b = breakers.get(name);
  if (b) { b.failures = 0; b.openedAt = null; }
}
function recordFailure(name: string, kind: FailureKind, message: string): void {
  const b = breakers.get(name) ?? { failures: 0, openedAt: null };
  b.failures += 1;
  if (b.failures >= FAILURE_THRESHOLD) b.openedAt = Date.now();
  breakers.set(name, b);
  metrics(name).failures += 1;
  metrics(name).lastFailure = { kind, message, at: Date.now() };
}

// --- Metrics ----------------------------------------------------------------

const metricsMap = new Map<string, ProviderMetrics>();
function metrics(name: string): ProviderMetrics {
  let m = metricsMap.get(name);
  if (!m) { m = { calls: 0, successes: 0, failures: 0, totalLatencyMs: 0 }; metricsMap.set(name, m); }
  return m;
}

// --- Feature flag (default OFF) ---------------------------------------------

export function searchProviderEnabled(): boolean {
  return process.env.SEARCH_PROVIDER_FALLBACK === "true";
}

// --- Auto router (empty by default) ----------------------------------------

export class AutoSearchProvider {
  readonly name = "auto";
  // No providers wired in. Add a Provider implementation here only after confirming the official
  // API's terms of service permit server-side use and a legal key is configured.
  readonly chain: Provider[] = [];

  async search(query: string, opts: { maxResults?: number; lang?: string } = {}): Promise<SearchResult[]> {
    if (!searchProviderEnabled()) return [];
    if (this.chain.length === 0) return [];
    const errors: string[] = [];
    for (const p of this.chain) {
      try {
        const r = await p.search(query, opts);
        if (r.length > 0) return r;
        errors.push(`${p.name}: no results`);
      } catch (e) { errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return [];
  }

  async fetchPage(url: string, opts: { maxChars?: number } = {}): Promise<{ url: string; text: string; status: number } | null> {
    if (!searchProviderEnabled()) return null;
    if (this.chain.length === 0) return null;
    for (const p of this.chain) {
      try { return await p.fetchPage(url, opts); } catch { /* try next */ }
    }
    return null;
  }
}

// --- Test / observability hooks --------------------------------------------

export function resetSearchProviderState(): void {
  breakers.clear(); metricsMap.clear();
}
export function getProviderMetrics(name: string): ProviderMetrics | null { return metricsMap.get(name) ?? null; }
export function __testRecordFailure(name: string, kind: FailureKind = "network", message = "test"): void { recordFailure(name, kind, message); }
export function __testRecordSuccess(name: string): void { recordSuccess(name); }
