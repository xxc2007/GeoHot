// Dated publisher listings enter the canonical archive -> extract -> analyze -> group pipeline.
// No list teaser is supplied as body/excerpt, preserving existing extracted article text.
import { readFile, mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { FetchError, type Candidate, type SourceRow } from "../packages/backend/src/sources/types.ts";
import type { MaterialInput, MaterialResult } from "../packages/backend/src/content/materials.ts";
import { identityKeyForUrl } from "../packages/backend/src/lib/url.ts";

const ROOT = resolve(import.meta.dirname, "..");
export interface ArchiveRule {
  sourceId: string;
  mode: "pages" | "months";
  /** Omitted means the existing HTML listing; RSS uses its registered feed parser. */
  format?: "html" | "rss";
  urlTemplate: string;
  firstPage?: number;
  firstPageUrl?: string;
  /** Present means a monthly archive paginates within the month: `{month}` substitutes as in urlTemplate, `{page}` starts at 2. */
  monthPageUrlTemplate?: string;
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
export async function fetchArchiveSource(source: SourceRow): Promise<Candidate[]> {
  if (source.kind === "rss") {
    const { fetchRss } = await import("../packages/backend/src/sources/rss.ts");
    const { applySourceFilters } = await import("../packages/backend/src/sources/collect.ts");
    // History must read actual page contents, never interpret a live-feed 304 as an empty archive.
    return applySourceFilters((await fetchRss(source, { force: true })).candidates, source);
  }
  const { fetchWebList } = await import("../packages/backend/src/sources/web-list.ts");
  return fetchWebList(source);
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
  // What one fetched listing did to the walk: "continue" goes to the next page, "stop-rule" ends the
  // rule's walk, "older-boundary-month" ends one month's continuation (older-boundary evidence or a
  // month-end signal) while the plan walks on to the next month, "error" fails the walk.
  type Verdict = "continue" | "stop-rule" | "older-boundary-month" | "error";
  outer: for (const rule of picked) {
    const registered = sources.find(s => s.id === rule.sourceId);
    if (!registered) throw new Error(`Source is not registered: ${rule.sourceId}`);
    if (!registered.enabled || registered.participation_mode !== "editorial") throw new Error(`Source is not enabled for editorial processing: ${rule.sourceId}`);
    if (rule.format && rule.format !== "html" && rule.format !== "rss") throw new Error(`Unsupported archive format: ${rule.format}`);
    if (rule.format === "rss" && registered.kind !== "rss") throw new Error(`RSS archive requires a registered RSS source: ${rule.sourceId}`);
    if (rule.monthPageUrlTemplate && (rule.mode !== "months" || !rule.monthPageUrlTemplate.includes("{month}") || !rule.monthPageUrlTemplate.includes("{page}"))) throw new Error(`Month pagination requires a months rule with {month} and {page} in the template: ${rule.sourceId}`);
    // Keep HTML identity/checkpoint behavior unchanged; RSS aliases use canonical material identity.
    const identity = (url: string) => rule.format === "rss" ? identityKeyForUrl(url) ?? url : url;
    let priorSignature = "";
    const prefix = `${o.from}:${o.to}:${rule.sourceId}:`;
    const completedPages = o.apply ? [...done].filter(k => k.startsWith(prefix)).length : 0;
    const plan = pages(rule, { ...o, maxPages: o.maxPages + completedPages });
    // Legacy checkpoints did not retain why a page walk stopped. Reobserve the latest acknowledged
    // frontier once, without trusting completed-page counts as evidence of an older-date boundary.
    const legacyFrontier = o.apply && rule.mode === "pages" && !state.boundaries?.[prefix]
      ? plan.findLast(url => done.has(`${prefix}${url}`)) : undefined;
    const monthPagination = rule.mode === "months" ? rule.monthPageUrlTemplate : undefined;
    // pages() walks one month per planned URL from o.from's month, so planned index i is that walk's
    // (i)th month; the within-month template substitutes the same month.
    const monthAt = (i: number) => {
      const [y, m] = o.from.slice(0, 7).split("-").map(Number);
      const t = m! - 1 + i;
      return `${y! + Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`;
    };
    // Pre-filter listing length of the page readPage processed last: 0 means it read nothing (a
    // skipped or failed page), otherwise the count the next continuation page is compared against.
    let raw = 0;
    const readPage = async (url: string, first: boolean, last: boolean, continuation?: { lastRaw: number }): Promise<Verdict> => {
      raw = 0;
      // Exact range keys deliberately prevent a wider/shifted span from reusing an old stopping point.
      // Reobserve the boundary itself: numbered pages can move when publishers prepend new articles.
      if (o.apply && (state.boundaries?.[prefix]?.url === url || legacyFrontier === url)) done.delete(`${prefix}${url}`);
      const key = `${o.from}:${o.to}:${rule.sourceId}:${url}`;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const openListing = (rule.mode === "pages" && first && o.to >= today)
        || (rule.mode === "months" && url.includes(today.slice(0, 7).replace("-", "/")));
      if (o.apply && done.has(key) && !openListing) return "continue";
      try {
        const completedItems = new Set((state.partial?.[key] ?? []).map(identity));
        const rss = rule.format === "rss";
        const items = await d.fetch({ ...registered, kind: rss ? "rss" : "web_list", config: {
          ...registered.config, ...rule.config, ...(rss ? { feedUrl: url } : { url }),
        } });
        stats.pages++;
        raw = items.length;
        if (!items.length) {
          // An empty continuation page is a monthly archive saying the month has no more pages, not a
          // coverage failure: nothing was read, so the URL stays pending and the next run re-checks it.
          if (continuation) { d.log?.({ source: rule.sourceId, stop: "month-exhausted", reason: "empty", url }); return "older-boundary-month"; }
          // In a months walk each planned URL is a different month, so an empty one ends only that month.
          // Returning "error" here used to `break` the whole rule — the plan is ordered oldest → newest, so
          // one gap in January silently cost February through October (2026-10-12 review). It is still
          // counted as an error: coverage for this month is unknown. Numbered pages of a single listing keep
          // the old stop, because an empty page 1 means there is no page 2 to go and look at.
          if (rule.mode === "months") {
            stats.errors++;
            d.log?.({ source: rule.sourceId, stop: "month-skipped", reason: "empty-month-page", url, error: "Empty archive listing: coverage is unknown; page remains pending" });
            return "older-boundary-month";
          }
          throw new Error("Empty archive listing: coverage is unknown; page remains pending");
        }
        // A CMS that ignores an out-of-range page must not masquerade as more history.
        const signature = items.map(c => identity(c.url)).join("\n");
        if (rule.mode === "pages" && signature === priorSignature) { stats.limited = true; d.log?.({ source: rule.sourceId, stop: "repeated-page", coverage: "unknown", url }); return "stop-rule"; }
        priorSignature = signature;
        let interrupted = false;
        const discoveredAt = new Date();
        const eligibleBefore = stats.eligible;
        for (const c of items) {
          stats.candidates++;
          const m = material(c, rule.sourceId, discoveredAt);
          if (!m) { stats.undated++; continue; }
          // Publisher instant, compared with the requested inclusive Beijing civil days.
          const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(m.publishedAt!);
          const itemKey = identity(c.url);
          if (day < o.from || day > o.to || m.publishedAt!.getTime() > discoveredAt.getTime() || seen.has(itemKey) || completedItems.has(itemKey)) continue;
          if (stats.eligible >= o.maxItems) { interrupted = true; stats.limited = true; break; }
          seen.add(itemKey); stats.eligible++;
          if (o.apply) {
            const result = await d.store!(m);
            if (result.created) stats.created++;
            if (result.revised) stats.revised++;
            // Queue even duplicates: a previous crash between insert and enqueue is repaired on resume.
            if (await d.queue!(result.articleId)) stats.queued++;
            // Persist only after both canonical storage and queue acknowledgement. URL identity survives
            // listing insertions/reordering, and a partial page no longer spends each rerun on duplicates.
            completedItems.add(itemKey);
            state.partial ??= {};
            state.partial[key] = [...completedItems];
            await d.checkpoint!(state);
          }
          d.log?.({ source: rule.sourceId, url: c.url, title: c.title, publishedAt: m.publishedAt!.toISOString(), apply: o.apply });
        }
        if (interrupted) return "stop-rule";
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
        // Only stop a walk when every listed item is dated and older than the range. A pages walk ends
        // there; a monthly walk only ends its month, the next month is still inside the range.
        const olderBoundary = (rule.mode === "pages" || monthPagination) && dated.length === items.length
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
          return rule.mode === "pages" ? "stop-rule" : "older-boundary-month";
        }
        if (o.apply && state.boundaries?.[prefix]?.url === url) {
          delete state.boundaries[prefix];
          await d.checkpoint!(state);
        }
        if (last && (rule.mode === "pages" || plan.length && !plan[plan.length - 1]!.includes(o.to.slice(0, 7).replace("-", "/")))) stats.limited = true;
        if (continuation) {
          // Speculative month-end signals, never errors: a page yielding nothing new in range —
          // including a CMS echoing the previous page for an out-of-range request — and a page
          // listing fewer raw items than its predecessor. Pages with items checkpoint as usual.
          if (stats.eligible === eligibleBefore) { d.log?.({ source: rule.sourceId, stop: "month-exhausted", reason: "no-new", url }); return "older-boundary-month"; }
          if (items.length < continuation.lastRaw) { d.log?.({ source: rule.sourceId, stop: "month-exhausted", reason: "partial", url }); return "older-boundary-month"; }
        }
        if (o.sleepMs) await delay(o.sleepMs);
        return "continue";
      } catch (error) {
        // A 404 or an unparseable continuation page is how a monthly archive ends the month:
        // speculative, not an error, no boundary, and the URL stays pending for a cheap re-check.
        if (continuation && error instanceof FetchError && (error.status === 404 || error.message.startsWith("no items matched"))) {
          d.log?.({ source: rule.sourceId, stop: "month-exhausted", reason: error.status === 404 ? "404" : "empty", url });
          return "older-boundary-month";
        }
        stats.errors++; d.log?.({ source: rule.sourceId, url, error: (error as Error).message }); return "error";
      }
    };
    for (const [pageIndex, url] of plan.entries()) {
      // Caps are re-checked here because "stop-rule" only ends one rule's walk: interrupted used to
      // break outer directly, and this head check reproduces that stop before the next rule fetches.
      if (stats.pages >= o.maxPages || stats.eligible >= o.maxItems) { stats.limited = true; break outer; }
      let verdict = await readPage(url, pageIndex === 0, pageIndex === plan.length - 1);
      if (verdict === "continue" && monthPagination) {
        // Follow the month's own {page} numbering from 2, inside the same page and item caps.
        // "已确认"只说明**这一页**读过，不说明它后面没有更旧的内容——所以这里不能因为
        // `raw === 0`（已确认页在 readPage 顶部就被置 0 并原样返回 continue）而停：
        // 那会让"第 2 页已确认、第 3 页从没读过"的月份每一轮都停在第 2 页，后面的页永远不再请求
        // （2026-10-12 评审实测：月有 4 页 41 条，run1 读到 page3 后 run2 请求数 0、11 条永久丢失）。
        // 真正的"本月完了"由 readPage 自己说：空页、404、或比前一页短的续页都返回 older-boundary-month。
        const month = monthAt(pageIndex).replace("-", "/");
        let page = 2, lastRaw = raw;
        while (stats.pages < o.maxPages && stats.eligible < o.maxItems) {
          verdict = await readPage(monthPagination.replace("{month}", month).replace("{page}", String(page++)), false, false, { lastRaw });
          if (verdict !== "continue") break;
          if (raw > 0) lastRaw = raw;
        }
        // Only `readPage` can say a month is finished; still being on "continue" means the loop left on a
        // page/item cap, i.e. older pages of this month exist but were not imported. `--max-pages` cuts a
        // month mid-walk on the production cycle, and this was the one cell where the report stayed silent.
        if (verdict === "continue") stats.limited = true;
      }
      if (verdict === "stop-rule" || verdict === "error") break;
    }
  }
  return stats;
}
async function main() {
  const o = options(process.argv.slice(2));
  if (o.apply && !process.env.DATABASE_URL) throw new Error("DATABASE_URL must be explicitly provided");
  const rules = JSON.parse(await readFile(resolve(ROOT, "industry/news-archives.json"), "utf8")).archives as ArchiveRule[];
  let sources = JSON.parse(await readFile(resolve(ROOT, "industry/sources.json"), "utf8")).sources as SourceRow[];
  let state: State = { version: 1, completed: [] };
  const d: Dependencies = { fetch: fetchArchiveSource, log: v => console.log(JSON.stringify(v)) };
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
