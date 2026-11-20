// Operator-only reserve replacement: retire candidates that failed their public-feed probe and
// install freshly verified replacements. Default dry-run; every write happens in one registry
// transaction, with an audit row and a final count check.
//
//   node --env-file=.env scripts/replenish-reserve-candidates.ts --manifest=/path/to/candidates.json
//   node --env-file=.env scripts/replenish-reserve-candidates.ts --manifest=... --apply \
//     --retire-extra=web-thepaper-topnews
//
// The manifest is a JSON array in the same shape as one entry of industry/source-reserves.json:
// id/name/kind/config/tier/first_party/tags/default_category/validation. Entries are used in order;
// the script only consumes as many as there are currently ineligible reserves.
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { lockRegistry } from "@aihot/backend/sources/registry";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { audit } from "@aihot/backend/admin/auth";

const apply = process.argv.includes("--apply");
const rawManifest = process.argv.find((x) => x.startsWith("--manifest="))?.slice(11) ?? "";
// Operator input is a local file path. Reject traversal and keep it inside the operator's working
// tree or /tmp; the script never writes to it, but a typo must not read arbitrary host files.
const resolved = rawManifest ? path.resolve(rawManifest) : "";
const allowedRoots = [process.cwd(), "/tmp", "/opt/geohot/app/.data"].map((p) => path.resolve(p));
if (!resolved || rawManifest.includes("..") || !allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
  throw new Error("Pass --manifest= with an absolute path inside the repository, /tmp, or the app data directory");
}
const retireExtra = (process.argv.find((x) => x.startsWith("--retire-extra="))?.slice(15) ?? "")
  .split(",").map((x) => x.trim()).filter(Boolean);
if (!process.env.DATABASE_URL) throw new Error("Explicit DATABASE_URL required");

const manifest = JSON.parse(readFileSync(resolved, "utf8")) as Array<Record<string, any>>;
if (!Array.isArray(manifest) || !manifest.length) throw new Error("Manifest must be a non-empty array");
const now = Date.now();
for (const entry of manifest) {
  const kind = String(entry.kind);
  if (!["rss", "json_list"].includes(kind)) throw new Error(`Unsupported reserve kind: ${entry.id}`);
  assertSupportedConfig(kind as "rss" | "json_list", entry.config);
  const checked = Date.parse(String(entry.validation?.checkedAt ?? ""));
  if (entry.validation?.ok !== true || !Number.isFinite(checked) || now - checked > 7 * 86400_000) {
    throw new Error(`Fresh successful verification required: ${entry.id}`);
  }
  if (!entry.id || !entry.name) throw new Error("Every candidate needs id and name");
}
if (new Set(manifest.map((x) => x.id)).size !== manifest.length) throw new Error("Duplicate candidate ids in manifest");

const SUMMARY = sql`
  SELECT
    (SELECT count(*)::int FROM sources s WHERE s.enabled AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS active,
    (SELECT count(*)::int FROM source_reserves r WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=r.source_id)
       AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.enabled)) AS reserves,
    (SELECT count(*)::int FROM sources s WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS nonretired,
    (SELECT count(*)::int FROM source_reserves r JOIN sources s ON s.id=r.source_id
       WHERE r.eligible=false AND s.enabled=false AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS ineligible`;

try {
  const [before] = await sql<{ active: number; reserves: number; nonretired: number; ineligible: number }[]>`${SUMMARY}`;
  if (!before) throw new Error("Could not read source pool counts");
  const candidates = manifest.slice(0, before.ineligible);
  if (before.ineligible > manifest.length) throw new Error(`Need ${before.ineligible} replacements, manifest has ${manifest.length}`);
  const plan = {
    mode: apply ? "apply" : "dry-run",
    before,
    replace: before.ineligible,
    candidates: candidates.map((x) => x.id),
    retireExtra,
    nonretiredAfter: before.nonretired - before.ineligible - retireExtra.length + candidates.length,
  };
  if (plan.nonretiredAfter > 2000) throw new Error(`Source pool would exceed 2000 non-retired rows (${plan.nonretiredAfter}); add --retire-extra`);
  if (!apply) { console.log(JSON.stringify(plan)); process.exit(0); }

  const result = await sql.begin(async (tx) => {
    await lockRegistry(tx);
    await tx`SET LOCAL lock_timeout='5s'`;
    await tx`SET LOCAL statement_timeout='30s'`;

    const old = await tx<(Record<string, any> & { id: string })[]>`
      SELECT s.*, r.validated_at AS reserve_validated_at, r.validation AS reserve_validation
      FROM source_reserves r JOIN sources s ON s.id=r.source_id
      WHERE r.eligible=false AND s.enabled=false
        AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)
      ORDER BY r.validated_at, s.id
      FOR UPDATE OF s, r`;
    if (old.length !== before.ineligible) throw new Error(`Ineligible set changed during planning (${old.length} vs ${before.ineligible}); retry`);
    if (old.length > candidates.length) throw new Error(`Need ${old.length} replacements, manifest has ${candidates.length}`);

    const extra = retireExtra.length
      ? await tx<(Record<string, any> & { id: string })[]>`SELECT * FROM sources WHERE id=ANY(${retireExtra}::text[]) FOR UPDATE`
      : [];
    if (extra.length !== retireExtra.length) throw new Error("retire-extra id not found");

    const oldIds = old.map((x) => x.id);
    const newIds = candidates.map((x) => x.id);
    const overlap = await tx<{ id: string }[]>`SELECT id FROM sources WHERE id=ANY(${newIds}::text[])`;
    if (overlap.length) throw new Error(`Candidate ids already exist: ${overlap.map((x) => x.id).join(", ")}`);
    const canonicalOverlap = await tx<{ id: string }[]>`
      SELECT s.id FROM sources s JOIN (SELECT unnest(${candidates.map((x) => String(x.config.url ?? x.config.feedUrl))}::text[]) AS url) c
        ON s.canonical_url = c.url
      WHERE s.enabled`;
    if (canonicalOverlap.length) throw new Error(`Candidate URLs overlap the active pool: ${canonicalOverlap.map((x) => x.id).join(", ")}`);

    for (const o of old) {
      await tx`INSERT INTO source_retirements(source_id, source_snapshot, reason)
        VALUES(${o.id}, ${tx.json(o)}, 'Reserve verification failed; replaced by a freshly probed public RSS/JSON candidate')
        ON CONFLICT(source_id) DO NOTHING`;
    }
    for (const o of extra) {
      await tx`INSERT INTO source_retirements(source_id, source_snapshot, reason)
        VALUES(${o.id}, ${tx.json(o)}, 'Paused legacy source outside active and reserve pools; capacity correction')
        ON CONFLICT(source_id) DO NOTHING`;
    }
    if (oldIds.length) await tx`DELETE FROM source_reserves WHERE source_id=ANY(${oldIds}::text[])`;

    for (const [index, c] of candidates.entries()) {
      const validation = { ...c.validation, replacedAt: new Date().toISOString() };
      const url = String(c.config.url ?? c.config.feedUrl);
      await tx`INSERT INTO sources(id,name,kind,config,tier,participation_mode,interval_minutes,first_party,tags,enabled,health,default_category,site_fulltext,syndicate_fulltext,canonical_url)
        VALUES(${c.id},${c.name},${c.kind},${tx.json(c.config)},${c.tier ?? "T1_5"},"editorial",${c.interval_minutes ?? 720},${c.first_party ?? false},${c.tags ?? []},false,'paused',${c.default_category ?? null},false,false,${url})`;
      await tx`INSERT INTO source_reserves(source_id,validated_at,validation,eligible,next_check_at,priority)
        VALUES(${c.id},${new Date(c.validation.checkedAt)},${tx.json(validation)},true,now()+make_interval(mins=>${index % 1440}),${c.priority ?? 75})`;
    }
    await tx`SELECT refresh_reserve_count()`;

    const [after] = await tx<{ active: number; reserves: number; fresh: number; nonretired: number }[]>`
      SELECT
        (SELECT count(*)::int FROM sources s WHERE s.enabled AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS active,
        (SELECT count(*)::int FROM source_reserves r WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=r.source_id)
           AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.enabled)) AS reserves,
        (SELECT count(*)::int FROM source_reserves r WHERE r.eligible AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=r.source_id)
           AND r.validated_at > now()-interval '7 days'
           AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.enabled)) AS fresh,
        (SELECT count(*)::int FROM sources s WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS nonretired`;
    if (!after || after.active !== 1000 || after.reserves !== 1000 || after.fresh !== 1000 || after.nonretired > 2000) {
      throw new Error(`Final pool check failed: ${JSON.stringify(after)}`);
    }
    await audit("operator:reserve-replenish", "source.reserve-replenish", null,
      `Replace ${old.length} unusable reserve candidates with ${candidates.length} freshly verified public feeds; ${retireExtra.length} extra retired`,
      before, { ...after, retired: old.length + retireExtra.length, replaced: candidates.length }, undefined, tx);
    return { mode: "applied", before, after, retired: old.length + retireExtra.length, replaced: candidates.length };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
