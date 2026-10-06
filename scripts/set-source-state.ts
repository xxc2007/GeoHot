// Push a handful of `industry/sources.json` fields back onto rows that are already in the database.
//
// Why this exists: scripts/seed.ts inserts with ON CONFLICT (id) DO NOTHING, on purpose — the pack is
// the first import, and after that the admin's 信源 page is the live switch. So editing the JSON to
// disable a source (or to fix a feedUrl) changes nothing for the running collector until someone moves
// the DB row too, and writing that UPDATE by hand in a psql session is exactly the unaudited production
// write this repo refuses. This is the reviewed path: it prints the pack-vs-DB difference for the named
// ids, and only writes those columns when both --apply and an explicit --database-url are given.
//
// Run it as: node scripts/set-source-state.ts --ids=a,b                         # dry run (needs a DB too)
//             node scripts/set-source-state.ts --ids=a,b --apply --database-url=postgres://…
// Fields it may write: enabled, config. Nothing else — tier, interval and the rest stay operator-owned.
import process from "node:process";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbArg = args.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length)
  ?? process.env.DATABASE_URL;
const ids = (args.find((a) => a.startsWith("--ids="))?.slice("--ids=".length) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!dbArg) {
  console.error("需要数据库地址：--database-url=… 或 DATABASE_URL（dry-run 也需要，它要读库）");
  process.exit(2);
}
if (apply && !args.some((a) => a.startsWith("--database-url="))) {
  // --apply against DATABASE_URL silently is how a dry run becomes a production change.
  console.error("--apply 必须显式给 --database-url=…（不接受从环境变量猜生产库）");
  process.exit(2);
}
if (!ids.length) {
  console.error("要 --ids=a,b 指名信源；本脚本不做整包对齐，后台里的开关不由信源包覆盖。");
  process.exit(2);
}

const pack = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as {
  sources: Array<{ id: string; enabled: boolean; config: Record<string, unknown> }>;
};
const unknown = ids.filter((id) => !pack.sources.some((s) => s.id === id));
if (unknown.length) {
  console.error(`信源包里没有这几条：${unknown.join(", ")}（先改 industry/sources.json，再同步库）`);
  process.exit(2);
}

const sql = postgres(dbArg, { max: 1 });

// Postgres' jsonb reorders object keys, so a raw JSON.stringify comparison reports every config as
// changed. Compare the canonical form instead: keys sorted at every depth, arrays left in order.
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]));
  }
  return value ?? null;
}
const shown = (value: unknown) => JSON.stringify(canon(value ?? {}));

try {
  const rows = await sql<{ id: string; enabled: boolean; config: Record<string, unknown> }[]>`
    SELECT id, enabled, config FROM sources WHERE id = ANY(${ids}::text[]) ORDER BY id`;
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) console.log(`库里没有：${missing.join(", ")}（这些行由 seed 首次导入，不用本脚本）`);

  const changes: Array<{ id: string; enabled: boolean; config: Record<string, unknown> }> = [];
  for (const r of rows) {
    const want = pack.sources.find((s) => s.id === r.id)!;
    const enabledDiff = r.enabled !== want.enabled;
    const configDiff = shown(r.config) !== shown(want.config);
    const note: string[] = [];
    if (enabledDiff) note.push(`enabled ${r.enabled} → ${want.enabled}`);
    if (configDiff) note.push(`config ${shown(r.config)} → ${shown(want.config)}`);
    console.log(`${r.id}: ${note.length ? note.join("；") : "与信源包一致"}`);
    if (note.length) changes.push({ id: r.id, enabled: want.enabled, config: want.config });
  }
  if (!changes.length) {
    console.log("库与信源包已一致，无需写入。");
  } else if (!apply) {
    console.log(`（dry run：${changes.length} 条待写。要执行请加 --apply --database-url=…）`);
  } else {
    await sql.begin(async (tx) => {
      for (const c of changes) {
        // Both pack-owned columns are written together, with the admin toggle's side effects
        // (admin/sources.ts:118): disabling parks health at 'paused', re-enabling clears a stale one.
        // `tx.json` is required — JSON.stringify here would make the driver send a JSON string, which
        // Postgres stores as a jsonb scalar, and then `config.feedUrl` is undefined at collect time.
        await tx`
          UPDATE sources
             SET enabled = ${c.enabled},
                 config = ${tx.json(c.config as never)},
                 health = CASE WHEN NOT ${c.enabled} THEN 'paused' WHEN health = 'paused' THEN 'unknown' ELSE health END,
                 updated_at = now()
           WHERE id = ${c.id}`;
      }
    });
    console.log(`已写入 ${changes.length} 条：${changes.map((c) => c.id).join(", ")}（只动 enabled / config / health / updated_at，可逆）`);
  }
} finally {
  await sql.end();
}
