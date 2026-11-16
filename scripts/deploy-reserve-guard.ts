// Pre-deployment check for migration 0121 (reserve pool guard).
// Safe to run on production at ANY schema state (before 0121 is applied).
//
// Usage:
//   npx tsx scripts/deploy-reserve-guard.ts           # dry-run: report duplicates/overlaps
//   npx tsx scripts/deploy-reserve-guard.ts --check   # same as dry-run, exits 1 if any issue found
//
// If clean, run: npm run db:migrate   (standard runner, records schema_migrations)
//
// This script NEVER executes the migration. It only checks that the preconditions are met.
import { sql } from "../packages/backend/src/db.ts";

const strict = process.argv.includes("--check");

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

async function main() {
  console.log("=== Reserve Pool Guard — Pre-Deployment Check ===\n");

  // 1. Current schema state (may be before 0121 — use information_schema).
  const hasCanonical = await columnExists("sources", "canonical_url");
  const hasQuarantined = await columnExists("source_reserves", "quarantined");
  const hasTargetReserves = await columnExists("source_registry_policy", "target_reserves");
  console.log(`Schema state: canonical_url=${hasCanonical}, quarantined=${hasQuarantined}, target_reserves=${hasTargetReserves}`);

  // 2. Active pool current count.
  const [active] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sources
    WHERE enabled = true
      AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = sources.id)
  `;
  console.log(`Active sources: ${active!.n}`);

  // 3. Reserve current count (without relying on quarantined column — fall back to total rows).
  const reserveTotal = hasQuarantined
    ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_reserves WHERE quarantined = false AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = source_reserves.source_id)`
    : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_reserves WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id = source_reserves.source_id)`;
  console.log(`Reserve candidates: ${reserveTotal[0]!.n}`);

  // 4. Active ∩ Reserve overlap (same id in both pools).
  const overlap = await sql`
    SELECT s.id FROM sources s
    JOIN source_reserves r ON r.source_id = s.id
    WHERE s.enabled = true
  `;
  console.log(`\nActive ∩ Reserve overlap: ${overlap.length}`);
  if (overlap.length > 0) {
    console.log("  IDs:");
    for (const o of overlap.slice(0, 10)) console.log(`    ${o.id}`);
  }

  // 5. Canonical URL duplicates in active pool.
  //    If canonical_url column doesn't exist yet, compute it on-the-fly from config.
  //    Same algorithm as migration: normalize(url) + "#" + discriminator (searchTopic/query/topic).
  let dupCount = 0;
  if (hasCanonical) {
    const dups = await sql`
      SELECT canonical_url, count(*)::int AS n
      FROM sources
      WHERE enabled = true AND canonical_url IS NOT NULL
      GROUP BY canonical_url HAVING count(*) > 1
    `;
    dupCount = dups.length;
    if (dupCount > 0) {
      console.log(`\nCanonical URL duplicates in active pool: ${dupCount} groups`);
      for (const d of dups.slice(0, 5)) console.log(`  ${d.canonical_url} (${d.n} sources)`);
    }
  } else {
    // Compute on-the-fly: normalize(url) + discriminator from config
    const dups = await sql`
      WITH normalized AS (
        SELECT
          id,
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    COALESCE(config->>'url', config->>'feedUrl', ''),
                    '#.*$', ''
                  ),
                  '/+$', ''
                ),
                '^([a-z]+://[^/]+)', lower('\1')
              ),
              '([?&])utm_[^&]*', '\1', 'g'
            ) ||
            COALESCE(
              '#' || lower(regexp_replace(COALESCE(config->>'searchTopic', config->>'query', config->>'topic', ''), '\s+', '-', 'g')),
              ''
            ) AS canon
        FROM sources
        WHERE enabled = true AND COALESCE(config->>'url', config->>'feedUrl', '') != ''
      )
      SELECT canon, count(*)::int AS n FROM normalized GROUP BY canon HAVING count(*) > 1
    `;
    dupCount = dups.length;
    if (dupCount > 0) {
      console.log(`\nCanonical URL duplicates (computed from config): ${dupCount} groups`);
      for (const d of dups.slice(0, 5)) console.log(`  ${d.canon} (${d.n} sources)`);
    }
  }

  // 6. Over-cap check.
  const targetReserves = hasTargetReserves
    ? (await sql<{ target: number }[]>`SELECT target_reserves AS target FROM source_registry_policy WHERE singleton`)[0]!.target
    : 1000;
  console.log(`\nTarget reserves: ${targetReserves}`);
  const over = reserveTotal[0]!.n - targetReserves;
  if (over > 0) {
    console.log(`WARNING: reserve candidates exceed target by ${over}`);
    console.log("  Migration will apply; trigger will block further inserts.");
    console.log("  To quarantine excess, run: SELECT quarantine_reserve_overcap(); (after migration)");
  }

  // 7. Summary.
  const issues = overlap.length + dupCount;
  console.log(`\n=== Pre-deployment check: ${issues === 0 ? "CLEAN" : `${issues} ISSUE(S) FOUND`} ===`);
  console.log("If clean, apply with: npm run db:migrate");
  console.log("Note: migration does NOT auto-delete the known NYT overlap (1 active + 1 ineligible reserve).");
  console.log("      Production deployment will explicitly backup+delete it and add 1 verified fulltext source.");

  if (strict && issues > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
