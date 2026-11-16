// READ-ONLY manifest preflight. Never writes to the DB or the manifest.
//   node --env-file-if-exists=.env scripts/check-reserve-manifest.ts
//
// Reports:
//   1. id overlaps between source-reserves.json and sources.json (active or not)
//   2. entries whose validation.checkedAt is older than 7 days (freshness gate)
//   3. entries whose kind is not rss/json_list (provision refuses them)
//   4. entries with validation.ok !== true
//   5. duplicate ids inside the manifest itself
//   6. missing feedUrl/url
//
// Exit code 0 = clean; 1 = problems found (still prints the report).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const WEEK_MS = 7 * 86_400_000;

const packPath = path.join(REPO_ROOT, "industry", "sources.json");
const reservesPath = path.join(REPO_ROOT, "industry", "source-reserves.json");

const pack = JSON.parse(readFileSync(packPath, "utf8")) as { sources: Array<{ id: string; enabled?: boolean }> };
const manifest = JSON.parse(readFileSync(reservesPath, "utf8")) as {
  generatedAt: string;
  sources: Array<{
    id: string;
    kind: string;
    config: { feedUrl?: string; url?: string };
    validation?: { ok?: boolean; checkedAt?: string; items?: number };
  }>;
};

const packIds = new Map(pack.sources.map((s) => [s.id, !!s.enabled]));
const seen = new Map<string, number>();
const overlapsActive: Array<{ id: string; inPackEnabled: boolean }> = [];
const overlapsAlreadyExcluded: Array<{ id: string; reason: string }> = [];
const staleFreshness: Array<{ id: string; checkedAt: string; ageDays: number; excluded: boolean }> = [];
const badKind: Array<{ id: string; kind: string }> = [];
const notOk: Array<{ id: string; ok: boolean | undefined }> = [];
const missingUrl: string[] = [];

const now = Date.now();
for (const s of manifest.sources) {
  seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  const excluded = typeof (s as { _excludedReason?: string })._excludedReason === "string";
  const enabledInPack = packIds.get(s.id);
  if (enabledInPack !== undefined) {
    if (excluded) overlapsAlreadyExcluded.push({ id: s.id, reason: (s as Record<string, unknown>)._excludedReason as string });
    else overlapsActive.push({ id: s.id, inPackEnabled: enabledInPack });
  }
  if (s.kind !== "rss" && s.kind !== "json_list" && !excluded) badKind.push({ id: s.id, kind: s.kind });
  if (s.validation?.ok !== true && !excluded) notOk.push({ id: s.id, ok: s.validation?.ok });
  const checkedAt = s.validation?.checkedAt ? Date.parse(s.validation.checkedAt) : NaN;
  if (!excluded) {
    if (!Number.isFinite(checkedAt)) {
      staleFreshness.push({ id: s.id, checkedAt: "(missing)", ageDays: Number.POSITIVE_INFINITY, excluded });
    } else if (now - checkedAt > WEEK_MS) {
      staleFreshness.push({ id: s.id, checkedAt: new Date(checkedAt).toISOString(), ageDays: Math.round((now - checkedAt) / 86_400_000 * 10) / 10, excluded });
    }
  }
  if (!s.config?.feedUrl && !s.config?.url && !excluded) missingUrl.push(s.id);
}
const dupIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

console.log(`manifest generatedAt: ${manifest.generatedAt}`);
console.log(`manifest total:       ${manifest.sources.length}`);
console.log(`manifest excluded:    ${(manifest as { excluded?: unknown[] }).excluded?.length ?? 0}`);
console.log(`pack total:           ${pack.sources.length}`);
console.log("");
console.log(`1. id overlap with sources.json AND not excluded: ${overlapsActive.length}`);
for (const o of overlapsActive) console.log(`   - ${o.id}  (in pack, enabled=${o.inPackEnabled})`);
console.log(`   (already-excluded overlap entries: ${overlapsAlreadyExcluded.length})`);
console.log("");
console.log(`2. validation older than 7d (active, not excluded): ${staleFreshness.length}`);
for (const s of staleFreshness.slice(0, 20)) console.log(`   - ${s.id}  checkedAt=${s.checkedAt}  age=${s.ageDays}d`);
if (staleFreshness.length > 20) console.log(`   ... and ${staleFreshness.length - 20} more`);
console.log("");
console.log(`3. kind not in (rss, json_list) and not excluded: ${badKind.length}`);
for (const b of badKind) console.log(`   - ${b.id}  kind=${b.kind}`);
console.log("");
console.log(`4. validation.ok !== true and not excluded: ${notOk.length}`);
for (const n of notOk) console.log(`   - ${n.id}  ok=${String(n.ok)}`);
console.log("");
console.log(`5. duplicate ids inside manifest: ${dupIds.length}`);
for (const id of dupIds) console.log(`   - ${id} (×${seen.get(id)})`);
console.log("");
console.log(`6. missing feedUrl/url and not excluded: ${missingUrl.length}`);
for (const id of missingUrl) console.log(`   - ${id}`);

const problems = overlapsActive.length + staleFreshness.length + badKind.length + notOk.length + dupIds.length + missingUrl.length;
console.log("");
console.log(`ACTIVE PROBLEMS (excluded entries already handled): ${problems}`);
process.exit(problems ? 1 : 0);
