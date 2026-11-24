// Seeds a fresh site from the industry pack: the topics (industry/topics.json, updated in place), the
// demo sources (industry/sources.json; rows absent from the table are inserted whole, rows already there
// only get their `name_en` backfilled — every other column stays as the operator left it) and,
// with the leaderboard on, its model directory (only models and names not there yet).
// Re-runnable:  node --env-file=.env scripts/seed.ts   (--topics-only: just the topics, as the tests use)
import { readFileSync } from "node:fs";
import path from "node:path";
import { FEATURES } from "@aihot/industry/features";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { importModelDirectory } from "@aihot/backend/leaderboard/directory";
import { seedTopics } from "@aihot/backend/publication/topics";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { registryChange } from "@aihot/backend/sources/registry";

interface SeedSource {
  id: string;
  name: string;
  /** English display name from the pack; `/en` falls back to the host when this is missing. */
  nameEn?: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  first_party?: boolean;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
  /** Section this source's items belong to when no explicit judgement exists (taxonomy key). */
  defaultCategory?: string;
}

console.log(`topics: ${await seedTopics()}`);
if (process.argv.includes("--topics-only")) {
  await closeDb();
  process.exit(0);
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
let added = 0;
let candidates = 0;
for (const s of sources) {
  assertSupportedConfig(s.kind, s.config);
  if (s.defaultCategory !== undefined && !isCategoryKey(s.defaultCategory)) {
    throw new Error(`${s.id}: defaultCategory "${s.defaultCategory}" is not a category key (see industry/taxonomy.ts)`);
  }
  const inserted = await registryChange(async (tx, policy) => {
  const [capacity] = await tx`SELECT target_total,(SELECT count(*)::int FROM sources s WHERE NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)) AS actual FROM source_registry_policy WHERE singleton`;
  if ((await tx`SELECT 1 FROM source_retirements WHERE source_id=${s.id}`).length || (capacity?.target_total != null && capacity.actual >= capacity.target_total)) return [];
  const enabled = policy.target_enabled === null && (s.enabled ?? true);
  const result = await tx`
    INSERT INTO sources (id, name, name_en, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at, default_category)
    VALUES (${s.id}, ${s.name}, ${s.nameEn?.trim() || null}, ${s.kind}, ${tx.json(s.config as never)}, ${s.tier ?? "T2"}, ${s.first_party ?? false}, ${s.owner_entity_id ?? null},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            ${enabled}, now(), ${s.defaultCategory ?? null})
    -- 冲突时只补英文名这一列。「ON CONFLICT DO NOTHING」对老行等于"英文名永远补不上"——生产库
    -- 668 条信源的 name_en 全空、而包里 668 条都有 nameEn，差别就出在这一句。name / config / tier /
    -- enabled 这些后台可能人工改过的列仍然"只增不改"（改配置是 scripts/sync-source-config.ts 的事）。
    -- 包里没给 nameEn 时保留库里的值（可能来自人工补写），不反手清空。
    ON CONFLICT (id) DO UPDATE
      SET name_en = coalesce(EXCLUDED.name_en, sources.name_en),
          updated_at = CASE WHEN sources.name_en IS NOT DISTINCT FROM coalesce(EXCLUDED.name_en, sources.name_en)
                            THEN sources.updated_at ELSE now() END
    RETURNING id, (xmax = 0) AS inserted`;
  // 冲突更新同样会 RETURNING，所以不能直接用结果行数：`xmax = 0` 只对真正新插进去的行成立。
  // 不区分的话 "N added" 与容量候选（candidates）都会跟着虚增。
  const rows = result.filter((r) => r.inserted);
  if (policy.target_enabled !== null) candidates += rows.length;
  return rows;
  });
  added += inserted.length;
}
console.log(`sources: ${added} added, ${sources.length - added} already there; ${candidates} disabled candidates pending review`);
if (FEATURES.leaderboard) {
  const { models, aliases } = await importModelDirectory();
  console.log(`leaderboard directory: ${models} models, ${aliases} names added`);
}
await closeDb();
