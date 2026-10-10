// Dated publisher listings enter the canonical archive -> extract -> analyze -> group pipeline.
// No list teaser is supplied as body/excerpt, preserving existing extracted article text.
import { readFile, mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Candidate, SourceRow } from "../packages/backend/src/sources/types.ts";
import type { MaterialInput, MaterialResult } from "../packages/backend/src/content/materials.ts";

const ROOT = resolve(import.meta.dirname, "..");
export interface ArchiveRule {
  sourceId: string;
  mode: "pages" | "months";
  urlTemplate: string;
  firstPage?: number;
  firstPageUrl?: string;
  config: Record<string, unknown>;
}
export interface Options {
  from: string; to: string; sources: string[]; maxPages: number; maxItems: number;
  sleepMs: number; apply: boolean; databaseUrlEnv?: string; state: string;
}
export interface State {
  version: 1; completed: string[]; partial?: Record<string, string[]>;
  // Range-scoped observations of a fully dated older page; not a claim that every article was selected.
  boundaries?: Record<string, { url: string; observedAt: string }>;
}
export function strictDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
    throw new Error(`Invalid calendar date: ${day}`);
  return day;
}
export function options(args: string[]): Options {
  const { values } = parseArgs({ args, options: {
    from: { type: "string", default: "2026-01-01" }, to: { type: "string", default: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) },
    sources: { type: "string", default: "" }, "max-pages": { type: "string", default: "100" }, "max-items": { type: "string", default: "5000" },
    "sleep-ms": { type: "string", default: "1000" }, apply: { type: "boolean", default: false },
    "database-url-env": { type: "string" }, state: { type: "string", default: ".data/backfill-news-state.json" },
  }});
  const count = (s: string, allowZero = false) => {
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) < (allowZero ? 0 : 1)) throw new Error(`Invalid limit: ${s}`);
    return Number(s);
  };
  const from = strictDay(values.from!), to = strictDay(values.to!);
  if (from > to) throw new Error("from must not be after to");
  if (values.apply && values["database-url-env"] !== "DATABASE_URL") throw new Error("Apply requires --database-url-env=DATABASE_URL");
  return { from, to, sources: values.sources!.split(",").filter(Boolean), maxPages: count(values["max-pages"]!), maxItems: count(values["max-items"]!), sleepMs: count(values["sleep-ms"]!, true), apply: values.apply!, databaseUrlEnv: values["database-url-env"], state: resolve(ROOT, values.state!) };
}
export function pages(rule: ArchiveRule, o: Options): string[] {
  if (rule.mode === "pages") return Array.from({ length: o.maxPages }, (_, i) => i === 0 && rule.firstPageUrl ? rule.firstPageUrl : rule.urlTemplate.replace("{page}", String((rule.firstPage ?? 0) + i)));
  const out: string[] = [];
  let month = o.from.slice(0, 7);
  while (month <= o.to.slice(0, 7) && out.length < o.maxPages) {
    out.push(rule.urlTemplate.replace("{month}", month.replace("-", "/")));
    const [y, m] = month.split("-").map(Number);
    month = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
  }
  return out;
}
export function material(c: Candidate, sourceId: string, discoveredAt: Date): MaterialInput | null {
  if (!c.publishedAt || !Number.isFinite(c.publishedAt.getTime())) return null;
  return { sourceId, url: c.url, title: c.title, publishedAt: c.publishedAt, discoveredAt,
    via: "import", backfill: "archive", bodyStatus: "pending" };
}
export interface Dependencies {
  fetch: (source: SourceRow) => Promise<Candidate[]>;
  store?: (m: MaterialInput) => Promise<MaterialResult>;
  queue?: (id: string) => Promise<unknown>;
  checkpoint?: (state: State) => Promise<void>;
  log?: (v: unknown) => void;
}
export async function run(o: Options, rules: ArchiveRule[], sources: SourceRow[], d: Dependencies, state: State = { version: 1, completed: [] }) {
  if (state.version !== 1 || !Array.isArray(state.completed) || state.completed.some(v => typeof v !== "string")) throw new Error("Invalid checkpoint");
  if (state.partial && (typeof state.partial !== "object" || Array.isArray(state.partial) || Object.values(state.partial).some(v => !Array.isArray(v) || v.some(url => typeof url !== "string")))) throw new Error("Invalid partial checkpoint");
  if (state.boundaries && (typeof state.boundaries !== "object" || Array.isArray(state.boundaries)
    || Object.values(state.boundaries).some(v => !v || typeof v.url !== "string" || typeof v.observedAt !== "string"))) throw new Error("Invalid boundary checkpoint");
  if (o.apply && (!d.store || !d.queue || !d.checkpoint)) throw new Error("Apply requires store, queue and private checkpoint dependencies");
  const stats = { pages: 0, candidates: 0, eligible: 0, undated: 0, created: 0, revised: 0, queued: 0, errors: 0, limited: false,
    boundaries: [] as Array<{ source: string; url: string; reused: boolean }> };
  const seen = new Set<string>();
  const done = new Set(state.completed);
  const picked = rules.filter(r => {
    if (o.sources.length) return o.sources.includes(r.sourceId);
    const registered = sources.find(s => s.id === r.sourceId);
    return !registered || (registered.enabled && registered.participation_mode === "editorial");
  });
  for (const id of o.sources) if (!picked.some(r => r.sourceId === id)) throw new Error(`Unsupported archive: ${id}`);
  outer: for (const rule of picked) {
    const registered = sources.find(s => s.id === rule.sourceId);
    if (!registered) throw new Error(`Source is not registered: ${rule.sourceId}`);
    if (!registered.enabled || registered.participation_mode !== "editorial") throw new Error(`Source is not enabled for editorial processing: ${rule.sourceId}`);
    let priorSignature = "";
    const prefix = `${o.from}:${o.to}:${rule.sourceId}:`;
    const completedPages = o.apply ? [...done].filter(k => k.startsWith(prefix)).length : 0;
    const plan = pages(rule, { ...o, maxPages: o.maxPages + completedPages });
    // Legacy checkpoints did not retain why a page walk stopped. Reobserve the latest acknowledged
    // frontier once, without trusting completed-page counts as evidence of an older-date boundary.
    const legacyFrontier = o.apply && rule.mode === "pages" && !state.boundaries?.[prefix]
      ? plan.findLast(url => done.has(`${prefix}${url}`)) : undefined;
    for (const [pageIndex, url] of plan.entries()) {
      // Exact range keys deliberately prevent a wider/shifted span from reusing an old stopping point.
      // Reobserve the boundary itself: numbered pages can move when publishers prepend new articles.
      if (o.apply && (state.boundaries?.[prefix]?.url === url || legacyFrontier === url)) done.delete(`${prefix}${url}`);
      const key = `${o.from}:${o.to}:${rule.sourceId}:${url}`;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const openListing = (rule.mode === "pages" && pageIndex === 0 && o.to >= today)
        || (rule.mode === "months" && url.includes(today.slice(0, 7).replace("-", "/")));
      if (o.apply && done.has(key) && !openListing) continue;
      if (stats.pages >= o.maxPages || stats.eligible >= o.maxItems) { stats.limited = true; break outer; }
      try {
        const completedItems = new Set(state.partial?.[key] ?? []);
        const items = await d.fetch({ ...registered, kind: "web_list", config: { ...registered.config, ...rule.config, url } });
        stats.pages++;
        if (!items.length) throw new Error("Empty archive listing: coverage is unknown; page remains pending");
        // A CMS that ignores an out-of-range page must not masquerade as more history.
        const signature = items.map(c => c.url).join("\n");
        if (rule.mode === "pages" && signature === priorSignature) { stats.limited = true; d.log?.({ source: rule.sourceId, stop: "repeated-page", coverage: "unknown", url }); break; }
        priorSignature = signature;
        let interrupted = false;
        const discoveredAt = new Date();
        for (const c of items) {
          stats.candidates++;
          const m = material(c, rule.sourceId, discoveredAt);
          if (!m) { stats.undated++; continue; }
          // Publisher instant, compared with the requested inclusive Beijing civil days.
          const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(m.publishedAt!);
          if (day < o.from || day > o.to || m.publishedAt!.getTime() > discoveredAt.getTime() || seen.has(c.url) || completedItems.has(c.url)) continue;
          if (stats.eligible >= o.maxItems) { interrupted = true; stats.limited = true; break; }
          seen.add(c.url); stats.eligible++;
          if (o.apply) {
            const result = await d.store!(m);
            if (result.created) stats.created++;
            if (result.revised) stats.revised++;
            // Queue even duplicates: a previous crash between insert and enqueue is repaired on resume.
            if (await d.queue!(result.articleId)) stats.queued++;
            // Persist only after both canonical storage and queue acknowledgement. URL identity survives
            // listing insertions/reordering, and a partial page no longer spends each rerun on duplicates.
            completedItems.add(c.url);
            state.partial ??= {};
            state.partial[key] = [...completedItems];
            await d.checkpoint!(state);
          }
          d.log?.({ source: rule.sourceId, url: c.url, title: c.title, publishedAt: m.publishedAt!.toISOString(), apply: o.apply });
        }
        if (interrupted) break outer;
        if (o.apply) {
          // The newest paged listing, the open monthly listing and pages with unknown dates need
          // another observation. A checkpoint is a transport ledger, never proof of full coverage.
          const refresh = openListing
            || items.some(c => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()));
          if (refresh) done.delete(key); else done.add(key);
          state.completed = [...done];
          if (state.partial) delete state.partial[key];
          await d.checkpoint!(state);
        }
        const dated = items.filter(c => c.publishedAt && Number.isFinite(c.publishedAt.getTime()));
        // Only stop a paged source when every listed item is dated and older than the range.
        const olderBoundary = rule.mode === "pages" && dated.length === items.length
          && dated.every(c => c.publishedAt!.getTime() < Date.parse(`${o.from}T00:00:00+08:00`));
        if (olderBoundary) {
          const reused = state.boundaries?.[prefix]?.url === url;
          stats.boundaries.push({ source: rule.sourceId, url, reused });
          d.log?.({ source: rule.sourceId, stop: "older-boundary", url, reused });
          if (o.apply) {
            state.boundaries ??= {};
            state.boundaries[prefix] = { url, observedAt: discoveredAt.toISOString() };
            await d.checkpoint!(state);
          }
          break;
        }
        if (o.apply && state.boundaries?.[prefix]?.url === url) {
          delete state.boundaries[prefix];
          await d.checkpoint!(state);
        }
        if (pageIndex === plan.length - 1 && (rule.mode === "pages" || plan.length && !plan[plan.length - 1]!.includes(o.to.slice(0, 7).replace("-", "/")))) stats.limited = true;
      } catch (error) { stats.errors++; d.log?.({ source: rule.sourceId, url, error: (error as Error).message }); break; }
      if (o.sleepMs) await delay(o.sleepMs);
    }
  }
  return stats;
}
async function main() {
  const o = options(process.argv.slice(2));
  if (o.apply && !process.env.DATABASE_URL) throw new Error("DATABASE_URL must be explicitly provided");
  const rules = JSON.parse(await readFile(resolve(ROOT, "industry/news-archives.json"), "utf8")).archives as ArchiveRule[];
  let sources = JSON.parse(await readFile(resolve(ROOT, "industry/sources.json"), "utf8")).sources as SourceRow[];
  const { fetchWebList } = await import("../packages/backend/src/sources/web-list.ts");
  let state: State = { version: 1, completed: [] };
  const d: Dependencies = { fetch: fetchWebList, log: v => console.log(JSON.stringify(v)) };
  let close = async () => {};
  if (o.apply) {
    if (!o.state.startsWith(resolve(ROOT, ".data") + "/") && !o.state.startsWith(resolve(ROOT, ".data") + "\\")) throw new Error("Checkpoint must stay inside private .data/");
    try { state = JSON.parse(await readFile(o.state, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const { upsertMaterial } = await import("../packages/backend/src/content/materials.ts");
    const { queueProcessing } = await import("../packages/backend/src/jobs/content.ts");
    const { closeDb, sql } = await import("../packages/backend/src/db.ts");
    const { stopBoss } = await import("../packages/backend/src/jobs/queue.ts");
    // Administrative source switches take effect immediately, without waiting for a pack redeploy.
    sources = await sql<SourceRow[]>`SELECT id,name,kind,config,tier,participation_mode,first_party,interval_minutes,enabled,cursor,fail_count FROM sources`;
    d.store = upsertMaterial;
    d.queue = async id => {
      // Completed or rejected duplicates must never start fresh paid analysis.
      const [pending] = await sql`SELECT id FROM articles WHERE id = ${id} AND processing_state = 'new'`;
      return pending ? queueProcessing(id) : null;
    };
    close = async () => { await stopBoss(); await closeDb(); };
    d.checkpoint = async v => {
      await mkdir(dirname(o.state), { recursive: true, mode: 0o700 });
      const temp = `${o.state}.tmp`;
      await writeFile(temp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
      await rename(temp, o.state); await chmod(o.state, 0o600);
    };
  }
  try { const result = await run(o, rules, sources, d, state); console.log(JSON.stringify({ mode: o.apply ? "apply" : "dry-run", from: o.from, to: o.to, ...result })); if (result.errors) process.exitCode = 1; }
  finally { await close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
