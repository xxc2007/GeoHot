// Ingests the curated geography corpus (tooling/corpus/curated-materials.jsonl, rebuilt by
// tooling/merge-corpus.mjs from the fragments beside it) through the framework's own
// entrance, so identity, revisions, the timeline rule and the whole pipeline (analysis → clustering →
// heat → publication → daily report) run over it exactly as they do over a collected article.
//
//   node --env-file=.env scripts/seed-curated.ts --input tooling/corpus/curated-materials.jsonl --dry-run
//   node --env-file=.env scripts/seed-curated.ts --enforce-source
//   node --env-file=.env scripts/seed-curated.ts --as-of 2026-10-01T08:00:00+08:00
//   node --env-file=.env scripts/seed-curated.ts --route http --batch-size 20
//
// Two routes to the same entrance:
//   --route inproc (default)  calls upsertMaterial + queueProcessing directly — the same two functions
//     the webhook itself calls, from a script that talks to the backend the way scripts/seed.ts and
//     scripts/regroup-events.ts already do. It carries the curated body text and sets the discovery
//     time, which the webhook cannot: ingestItems() sends only title/url/publishedAt/author/raw and
//     discovers everything at server "now".
//   --route http              exercises the real webhook (POST /api/ingest/items, Bearer INGEST_TOKEN,
//     ≤ 50 items per request, 10 requests per minute per IP). Use it for a single manual item; see
//     scripts/README-ingest.md for the one-liner the fieldwork/考察 sources need.
//
// The 48 h rule (events/group.ts through STALE_ON_DISCOVERY_MS): material discovered more than 48 h
// after its source time is archived as history — it founds no event and adds no heat, so 热点榜 and the
// event pages stay empty. A corpus whose authored times span months is therefore re-anchored onto one
// arrival day by default (order and relative spacing kept, authored times stored in raw._geohot).
// --keep-times ingests the authored times as written and reports how much falls out of the live window.
// Re-runnable: identity is the normalised URL and the discovery lag is derived from it, so the same
// input creates nothing on a second run and no revision is queued twice.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { credential, REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { identityKeyFor, upsertMaterial, type MaterialInput } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { normalizeUrl } from "@aihot/backend/lib/url";

const { values: opt } = parseArgs({
  options: {
    input: { type: "string", default: "tooling/corpus/curated-materials.jsonl" },
    route: { type: "string", default: "inproc" },
    "as-of": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "keep-times": { type: "boolean", default: false },
    "enforce-source": { type: "boolean", default: false },
    "allow-unknown-source": { type: "boolean", default: false },
    "no-queue": { type: "boolean", default: false },
    "batch-size": { type: "string", default: "50" },
    "base-url": { type: "string" },
    limit: { type: "string" },
  },
});

if (opt.route !== "inproc" && opt.route !== "http") throw new Error(`--route must be inproc or http, got ${opt.route}`);
const route = opt.route;
const anchor = opt["as-of"] ? new Date(opt["as-of"]) : new Date();
if (!Number.isFinite(anchor.getTime())) throw new Error(`--as-of is not a time: ${opt["as-of"]}`);
const dryRun = opt["dry-run"];
const keepTimes = opt["keep-times"];
/** Kept in step with STALE_ON_DISCOVERY_MS in packages/backend/src/content/materials.ts. */
const STALE_MS = 48 * 3600 * 1000;
/** The newest ingested item lands this far before the anchor, so nothing sits on the edge of the window. */
const LEAD_MS = 60 * 60 * 1000;
/** Material is "discovered" this many minutes after its own event time: derived from the identity, so a re-run is identical. */
const arrivalLagMs = (key: string) => 3 * 60_000 + (parseInt(sha256(key).slice(0, 6), 16) % 23) * 60_000;

interface CuratedLine {
  kind?: string; id?: string; sourceId?: string; sourceName?: string; url?: string; title?: string; originalTitle?: string;
  bodyText?: string; publishedAt?: string; timelineAt?: string; language?: string; author?: string | null;
  sourceTier?: string; firstParty?: boolean; discoveredAt?: string; raw?: Record<string, unknown>;
}
/** The corpus agent labels its lines "material"; the merged file labels them "item". Both are this script's input. */
const MATERIAL_KINDS = new Set(["material", "item"]);

// --------------------------------------------------------------------------- read the input
// The default input lives in the repo, but a relative --input is still resolved against the cwd, the repo
// root and the directory beside it, so a scratch corpus outside the tree can be named the old way.
const wanted = opt.input!;
const inputPath = [/^[A-Za-z]:[\\/]/.test(wanted) ? wanted : "",
  path.resolve(wanted), path.resolve(REPO_ROOT, wanted), path.resolve(REPO_ROOT, "..", wanted)].find((p) => p && existsSync(p));
if (!inputPath) throw new Error(`--input not found: tried ${[path.resolve(wanted), path.resolve(REPO_ROOT, wanted), path.resolve(REPO_ROOT, "..", wanted)].join(", ")}`);
const problems: string[] = [];
const raw: CuratedLine[] = [];
readFileSync(inputPath, "utf8").split(/\r?\n/).forEach((line, i) => {
  const text = line.trim();
  if (!text || text.startsWith("//")) return;
  if (!text.startsWith("{")) { problems.push(`line ${i + 1}: not a JSON object, skipped`); return; }
  let obj: CuratedLine;
  try { obj = JSON.parse(text) as CuratedLine; }
  catch { problems.push(`line ${i + 1}: JSON parse failed, skipped`); return; }
  if (!MATERIAL_KINDS.has(String(obj.kind))) { problems.push(`line ${i + 1}: kind "${String(obj.kind)}" is not material/item, skipped`); return; }
  raw.push(obj);
});

// --------------------------------------------------------------------------- plan every item
const via: MaterialInput["via"] = route === "http" ? "ingest" : "import";
const time = (v: string | undefined) => { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; };
const authoredOf = (l: CuratedLine) => time(l.timelineAt) ?? time(l.publishedAt);
/** How long after its event time the corpus says this material surfaced (the corpus's own gap, ≤ 48 h). */
const gapOf = (l: CuratedLine) => {
  const p = time(l.publishedAt), d = time(l.discoveredAt);
  if (!p || !d) return null;
  const gap = d.getTime() - p.getTime();
  return gap > 0 && gap <= STALE_MS - LEAD_MS ? gap : null;
};
const authored = raw.map(authoredOf);
const stamps = authored.filter((d): d is Date => !!d);
const spanStart = stamps.length ? new Date(Math.min(...stamps.map((t) => t.getTime()))) : null;
const spanEnd = stamps.length ? new Date(Math.max(...stamps.map((t) => t.getTime()))) : null;
// One affine map for the whole corpus: re-anchoring only the late half would interleave the halves and
// pull apart the reports that belong to one event.
const needsRescale = !keepTimes && !!spanStart && !!spanEnd
  && (anchor.getTime() - spanStart.getTime() > STALE_MS || spanEnd.getTime() - spanStart.getTime() > STALE_MS - 3 * LEAD_MS);
const srcSpan = spanStart && spanEnd ? Math.max(1, spanEnd.getTime() - spanStart.getTime()) : 1;
const remap = (t: Date) => new Date(anchor.getTime() - LEAD_MS - Math.round((spanEnd!.getTime() - t.getTime())
  * ((STALE_MS - 3 * LEAD_MS) / srcSpan)));

interface Planned { key: string; sourceId: string; url: string; title: string; input: MaterialInput; authored: Date | null }
/** The corpus names its sources; both routes pass that name on instead of inventing one. */
const sourceNameOf = (p: Planned) => (p.input.raw as { _geohot?: { sourceName?: string } } | null | undefined)?._geohot?.sourceName ?? undefined;
const seen = new Map<string, string>();
const usedIds = new Set<string>();
const plan: Planned[] = [];
const dropped = { noTitle: 0, noUrl: 0, badUrl: 0, duplicateUrl: 0, duplicateId: 0, unknownSource: 0 };
for (let i = 0; i < raw.length; i++) {
  const l = raw[i]!;
  const sourceId = (l.sourceId ?? "").trim();
  const authoredTitle = (l.title ?? "").trim();
  // W2-B2: articles.title carries the ORIGINAL title, never the authored Chinese one. This column is what
  // the scorer is handed (buildScoreInput → editorial/analyze.ts:96-100), so a Chinese title here silently
  // un-matches the人工 score fixtures and they fall back to the rule default; publication/publish.ts:194
  // reads the same column back as original_title, so the English original would vanish from the UI too.
  // The Chinese title/summary the reader sees is the writing step's output (understand/summarize fixture →
  // analyses.title_zh → publications.title), and structure/prefilter fixtures key on the url anyway.
  const originalTitle = (l.originalTitle ?? "").trim();
  const title = originalTitle || authoredTitle;
  const url = normalizeUrl((l.url ?? "").trim());
  if (!title) { dropped.noTitle++; problems.push(`no title (source ${sourceId || "?"}): ${l.url ?? ""}`); continue; }
  if (!url) { if (l.url) dropped.badUrl++; else dropped.noUrl++; problems.push(`no usable url: ${title.slice(0, 60)}`); continue; }
  const key = identityKeyFor({ sourceId, url, title, via });
  const held = seen.get(key);
  if (held) { dropped.duplicateUrl++; problems.push(`duplicate url, first one wins (kept source ${held}): ${url}`); continue; }
  seen.set(key, sourceId);
  // The corpus's own stable id becomes the article id when it is usable and not already taken.
  const rowId = l.id && /^[a-zA-Z0-9_-]{1,80}$/.test(l.id) && !usedIds.has(l.id) ? l.id : undefined;
  if (l.id && !rowId) { dropped.duplicateId++; problems.push(`id "${l.id}" is not a usable article id or repeats an earlier line: the url identity still decides`); continue; }
  if (rowId) usedIds.add(rowId);
  // Coherent by construction: the event time stands, the discovery follows it by the corpus's own gap
  // (or by minutes derived from the identity), so nothing is ever stale-on-discovery.
  const publishedAt = needsRescale ? remap(authoredOf(l) ?? anchor) : authoredOf(l);
  const discoveredAt = publishedAt
    ? new Date(Math.min(publishedAt.getTime() + (gapOf(l) ?? arrivalLagMs(key)), anchor.getTime()))
    : anchor;
  plan.push({
    key, sourceId, url, title, authored: authoredOf(l),
    input: {
      id: rowId, sourceId, url, title, via, language: originalTitle ? (l.language ?? "en") : l.language ?? null,
      author: typeof l.author === "string" && l.author.trim() ? l.author.trim().slice(0, 200) : null,
      publishedAt, discoveredAt,
      bodyText: l.bodyText ?? null, bodyStatus: l.bodyText ? "ok" : "pending",
      // Upstream provenance (theme, fragment, its own _aihot flags) is kept; the ingest decisions are added.
      raw: {
        ...(l.raw ?? {}),
        _geohot: {
          curated: true, originalTitle: l.originalTitle ?? null,
          // The corpus's Chinese title/summary line survives here; the storefront shows the writing step's
          // analyses.title_zh, which the understand/summarize fixtures author from this same material.
          titleZh: originalTitle ? authoredTitle : null,
          sourceName: l.sourceName ?? null,
          sourceTier: l.sourceTier ?? null, firstParty: l.firstParty ?? null,
          authoredPublishedAt: l.publishedAt ?? null, authoredTimelineAt: l.timelineAt ?? null,
          authoredDiscoveredAt: l.discoveredAt ?? null, input: inputPath, ingestedAsOf: anchor.toISOString(),
          rescaled: needsRescale, keepTimes,
        },
      },
    },
  });
}
if (opt.limit && Number(opt.limit) > 0) plan.splice(Number(opt.limit), Number.MAX_SAFE_INTEGER);
// A line flagged as backfill would be archived as history on purpose; the webhook honours it, this script
// never sets it. Say so when the input carries it, because those items found no event and get no heat.
const flagged = raw.filter((l) => (l.raw?._aihot as { backfill?: boolean; baseline?: boolean } | undefined)?.backfill === true
  || (l.raw?._aihot as { baseline?: boolean } | undefined)?.baseline === true).length;
if (flagged) console.log(`!! ${flagged} line(s) carry raw._aihot.backfill/baseline: --route http will file them as history `
  + `(no event, no heat); --route inproc ignores that flag and keeps them live, which is the deliberate difference.`);

// --------------------------------------------------------------------------- the sources must be real
const wantedIds = [...new Set(plan.map((p) => p.sourceId))];
const known = new Map<string, { kind: string; tier: string; participation_mode: string }>();
if (wantedIds.length) {
  const rows = await sql<{ id: string; kind: string; tier: string; participation_mode: string }[]>`
    SELECT id, kind, tier, participation_mode FROM sources WHERE id = ANY(${wantedIds})`;
  for (const r of rows) known.set(r.id, r);
}
const missing = wantedIds.filter((id) => !known.has(id));
const nonEditorial = wantedIds.filter((id) => known.has(id) && known.get(id)!.participation_mode !== "editorial");
const ingestedTimes = plan.map((p) => p.input.publishedAt).filter((d): d is Date => !!d);
console.log(`input ${inputPath}: ${raw.length} material line(s), ${plan.length} to ingest; dropped `
  + `${dropped.noTitle} without title, ${dropped.noUrl + dropped.badUrl} without a usable url, ${dropped.duplicateUrl} duplicate url`);
console.log(`sources: ${known.size}/${wantedIds.length} registered in the sources table`
  + `, ${missing.length} missing, ${nonEditorial.length} not editorial`);
if (missing.length) console.log(`!! MISSING SOURCE: ${missing.join(", ")} — without registration the item lands in an `
  + `auto-created 'external' source whose participation mode is 'isolated', so it is never published. `
  + `(--enforce-source stops here, --allow-unknown-source reproduces the webhook.)`);
if (nonEditorial.length) console.log(`!! NOT EDITORIAL: ${nonEditorial.map((id) => `${id}:${known.get(id)!.participation_mode}`).join(", ")} `
  + `— settleNonEditorial() marks those articles 'skipped': recorded, no analysis, never 精选. Switch them to `
  + `editorial in /admin (or in industry/sources.json plus npm run db:migrate && seed) before expecting them on the site.`);
if (problems.length) console.log(problems.slice(0, 25).map((p) => `   · ${p}`).join("\n") + (problems.length > 25 ? `\n   · …and ${problems.length - 25} more` : ""));
if (missing.length && opt["enforce-source"]) {
  console.error(`--enforce-source: ${missing.length} sourceId(s) not in the sources table — nothing was written.`);
  await closeDb();
  process.exit(2);
}
if (missing.length && !opt["allow-unknown-source"]) {
  dropped.unknownSource = plan.filter((p) => !known.has(p.sourceId)).length;
  for (let i = plan.length - 1; i >= 0; i--) if (!known.has(plan[i]!.sourceId)) plan.splice(i, 1);
  console.log(`skipped ${dropped.unknownSource} item(s) of unregistered source(s); nothing was created for them.`);
}

console.log(`times: authored ${spanStart?.toISOString() ?? "-"} .. ${spanEnd?.toISOString() ?? "-"}`  + (needsRescale
    ? ` → re-anchored ${ingestedTimes.length ? new Date(Math.min(...ingestedTimes.map((t) => t.getTime()))).toISOString() : "-"} .. `
      + `${ingestedTimes.length ? new Date(Math.max(...ingestedTimes.map((t) => t.getTime()))).toISOString() : "-"} `
      + `(as of ${anchor.toISOString()}; order and relative spacing kept, authored times in raw._geohot, `
      + `discovery = each event time + the corpus's own gap, clamped at the anchor ⇒ never stale-on-discovery)`
    : keepTimes
      ? ` → kept as written (as of ${anchor.toISOString()}); ${plan.filter((p) => p.input.publishedAt && p.input.publishedAt.getTime() < anchor.getTime() - STALE_MS).length} of ${plan.length} `
        + `sit outside the live 48 h heat window and will not reach 热点榜 today (their events still form)`
      : ` → already inside the 48 h window of ${anchor.toISOString()}, kept as written`));
if (route === "http" && opt["as-of"] && Math.abs(Date.now() - anchor.getTime()) > STALE_MS) {
  console.log(`!! route http cannot set the discovery time: the api stamps "now", so an --as-of ${anchor < new Date() ? "in the past" : "far in the future"} `
    + "leaves items older than 48 h at real now flagged historical. Use --route inproc to re-anchor a back-dated corpus.");
}

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true, route, asOf: anchor.toISOString(), rescaled: needsRescale, keepTimes,
    toIngest: plan.length, dropped, sources: { registered: known.size, missing, nonEditorial },
    queued: !opt["no-queue"],
    historicalAfterIngest: plan.filter((p) => p.input.publishedAt && p.input.discoveredAt!.getTime() - p.input.publishedAt.getTime() > STALE_MS).length,
  }));
  await closeDb();
  process.exit(0);
}

// --------------------------------------------------------------------------- write through the entrance
let created = 0, revised = 0, unchanged = 0, queued = 0, autoCreated = 0, webhookReported = 0, realigned = 0;
const perSource = new Map<string, { created: number; revised: number; unchanged: number }>();
const note = (id: string, kind: "created" | "revised" | "unchanged") => {
  const s = perSource.get(id) ?? { created: 0, revised: 0, unchanged: 0 };
  s[kind]++;
  perSource.set(id, s);
};

/**
 * The corpus is re-anchored as a whole (see the header), but upsertMaterial will never move an existing
 * row's times — an aggregator re-listing last month's article must not make it news — and its UPDATE branch
 * writes neither `raw` (content/materials.ts:196-205). So a curated line whose url the collector had already
 * fetched keeps its collected published_at/discovered_at, reads as stale-on-discovery history, drops out of
 * the event graph, 热点榜 and the selected window, and carries no provenance at all.
 * This script owns the re-anchoring decision, so it writes the planned times and its own `raw._geohot` block
 * back onto exactly the rows it ingested (matched by identity key, which is the URL) and nothing else; the
 * collector's other raw keys and `published_at_claim` survive untouched. --keep-times is the case where the
 * authored times are the point: skip.
 */
async function realignPlannedTimes() {
  if (keepTimes) return;
  const rows = await sql<{ identity_key: string; id: string; published_at: Date | null; discovered_at: Date; backfill: boolean; curated: boolean }[]>`
    SELECT identity_key, id, published_at, discovered_at, backfill,
      coalesce(raw->'_geohot'->>'curated', 'false') = 'true' AS curated
    FROM articles WHERE identity_key = ANY(${plan.map((p) => p.key)})`;
  const byKey = new Map(rows.map((r) => [r.identity_key, r]));
  for (const p of plan) {
    const row = byKey.get(p.key);
    const planned = p.input.publishedAt, discover = p.input.discoveredAt;
    if (!row || !planned || !discover) continue;
    // Only repair what is actually broken: a row filed as history, or one whose stored times fall outside the
    // live window the plan put them in. A second run then changes nothing (the times it wrote are inside).
    const outsideWindow = !row.published_at || !row.discovered_at
      || row.published_at.getTime() < anchor.getTime() - STALE_MS
      || row.discovered_at.getTime() - row.published_at.getTime() > STALE_MS;
    const needsTimes = row.backfill || outsideWindow;
    const needsRaw = !row.curated;
    if (!needsTimes && !needsRaw) continue;
    const provenance = (p.input.raw as { _geohot?: unknown } | null | undefined)?._geohot ?? {};
    if (needsTimes) {
      // published_at_claim keeps what the collector was told; the authored time is in raw._geohot too.
      await sql`
        UPDATE articles SET published_at = ${planned}, discovered_at = ${discover}, timeline_at = ${discover},
          backfill = false, backfill_reason = NULL,
          raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{_geohot}', ${sql.json(provenance as never)}, true)
        WHERE id = ${row.id}`;
    } else {
      await sql`
        UPDATE articles SET raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{_geohot}', ${sql.json(provenance as never)}, true)
        WHERE id = ${row.id}`;
    }
    realigned++;
  }
}

if (route === "inproc") {
  const toQueue: string[] = [];
  for (const p of plan) {
    if (!known.has(p.sourceId)) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
        VALUES (${p.sourceId}, ${sourceNameOf(p)?.slice(0, 200) ?? p.sourceId}, 'external', '{}'::jsonb, 'T2', 'isolated', 1440, true, 'ok', ${["ingest:auto-created"]})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (row) autoCreated++;
      known.set(p.sourceId, { kind: "external", tier: "T2", participation_mode: "isolated" });
    }
    const res = await upsertMaterial(p.input);
    const kind = res.created ? "created" : res.revised ? "revised" : "unchanged";
    if (res.created) created++; else if (res.revised) revised++; else unchanged++;
    note(p.sourceId, kind);
    if ((res.created || res.revised) && !opt["no-queue"]) toQueue.push(res.articleId);
  }
  // Re-anchor before queueing, so the analysis and every surface downstream see one arrival day.
  await realignPlannedTimes();
  for (const id of toQueue) { await queueProcessing(id); queued++; }
} else {
  const token = credential("auth", "INGEST_TOKEN");
  if (!token || token.length < 16 || /^(changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i.test(token)) {
    console.error(`--route http needs a real INGEST_TOKEN in .env (≥16 chars, not a placeholder): the api answers 401 otherwise.`);
    process.exit(2);
  }
  const base = (opt["base-url"] ?? process.env.API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const size = Math.min(50, Math.max(1, Number(opt["batch-size"]) || 50));
  // One sourceId per webhook call, and the batch limit is per call: group, then chunk.
  const groups = new Map<string, Planned[]>();
  for (const p of plan) (groups.get(p.sourceId) ?? groups.set(p.sourceId, []).get(p.sourceId)!).push(p);
  let requests = 0;
  for (const [sourceId, items] of groups) {
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      if (requests++) await new Promise((r) => setTimeout(r, 6_500)); // the api allows 10 requests per minute per IP
      // The webhook answers with `created` only, so each batch is compared against the rows around it.
      const keys = batch.map((p) => p.key);
      const read = async () => (await sql<{ identity_key: string; revision: number }[]>`
        SELECT identity_key, revision FROM articles WHERE identity_key = ANY(${keys})`);
      const before = new Map((await read()).map((r) => [r.identity_key, r.revision]));
      const res = await fetch(`${base}/api/ingest/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, sourceName: sourceNameOf(batch[0]!), items: batch.map((p) => ({
          title: p.title, url: p.url, publishedAt: p.input.publishedAt?.toISOString(), raw: p.input.raw as never,
        })) }),
      });
      const text = await res.text();
      if (!res.ok) { console.error(`!! ${res.status} on ${sourceId} batch ${Math.floor(i / size) + 1}: ${text.slice(0, 240)}`); problems.push(`${sourceId} batch failed with ${res.status}`); continue; }
      const answered = (JSON.parse(text) as { created: number }).created;
      webhookReported += answered;
      for (const r of await read()) {
        const was = before.get(r.identity_key);
        const kind = was === undefined ? "created" : r.revision > was ? "revised" : "unchanged";
        if (kind === "created") created++; else if (kind === "revised") revised++; else unchanged++;
        note(sourceId, kind);
      }
    }
  }
  console.log(`route http: ${requests} webhook call(s). The webhook carries no body text, so each new item is queued for `
    + `content.extract-body and re-read from its live url — only reachable pages get a body (docs/sources.md).`);
  // The webhook stamps "now" and cannot carry the discovery time, so the re-anchoring is written back here.
  await realignPlannedTimes();
}

for (const [sourceId, s] of perSource) console.log(`   ${sourceId}: ${s.created} created, ${s.revised} updated, ${s.unchanged} unchanged`);
if (realigned) console.log(`re-anchored + re-stamped ${realigned} row(s) (planned times and raw._geohot): upsertMaterial keeps an `
  + `existing row's times and its raw, so without this they would stay stale-on-discovery history (no event, no heat).`);
// Read the rows back: what the framework itself decided about history and about the live heat window.
const allKeys = plan.map((p) => p.key);
const check = allKeys.length ? (await sql<{ rows: number; historical: number; outside_heat_window: number }[]>`
  SELECT count(*)::int AS rows,
         count(*) FILTER (WHERE backfill AND (published_at IS NULL OR discovered_at - published_at > make_interval(secs => ${STALE_MS / 1000})))::int AS historical,
         count(*) FILTER (WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => ${STALE_MS / 1000}))::int AS outside_heat_window
  FROM articles WHERE identity_key = ANY(${allKeys})`)[0] : { rows: 0, historical: 0, outside_heat_window: 0 };
console.log(JSON.stringify({
  route, dryRun, asOf: anchor.toISOString(), rescaled: needsRescale, keepTimes, input: inputPath,
  read: raw.length, planned: plan.length, created, updated: revised, skipped: unchanged, dropped,
  queued, autoCreatedSources: autoCreated, webhookReported, realignedToPlannedTimes: realigned,
  inDb: check,
}));
console.log(check.historical
  ? `!! ${check.historical} row(s) are flagged historical: they found no event and add no heat. Drop --keep-times or use --as-of.`
  : `historical: 0 — every row is eligible to found an event and carry heat.`);
await stopBoss();
await closeDb();
if (dropped.unknownSource) process.exitCode = 1;
