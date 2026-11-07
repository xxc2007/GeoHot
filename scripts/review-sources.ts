// The human half of discovery: tooling/discover-sources.ts only stages rows (enabled=false,
// discovered_via set, review_note carrying the readings). This script is the queue, and the two
// decisions an operator can make about a staged row.
//
//   node --env-file-if-exists=.env scripts/review-sources.ts
//   node --env-file-if-exists=.env scripts/review-sources.ts --enable ID [ID...]
//   node --env-file-if-exists=.env scripts/review-sources.ts --reject ID [ID...] --note "停更 / 不是地理向"
//
// --reject closes the review instead of leaving the row in the queue forever: discovered_via moves into
// review_note ("rejected url:host: reason"), so the address and why it was turned down survive even
// though the row no longer matches the pending query.
import process from "node:process";
import { sql, closeDb } from "@aihot/backend/db";

const args = process.argv.slice(2);
const note = (() => {
  const withEquals = args.find((a) => a.startsWith("--note="));
  if (withEquals) return withEquals.slice("--note=".length);
  const at = args.indexOf("--note");
  return at === -1 ? undefined : args[at + 1];
})();
const action = args.includes("--enable") ? "enable" : args.includes("--reject") ? "reject" : "list";

/** Ids are every bare argument except the value consumed by --note. */
const ids: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--note") {
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) continue;
  ids.push(arg);
}

if (!process.env.DATABASE_URL) {
  console.error("需要 DATABASE_URL（--env-file-if-exists=.env，或显式导出）");
  process.exit(2);
}
if (action !== "list" && ids.length === 0) {
  console.error(`--${action} 需要至少一个 id；先不带参数跑一次看队列`);
  process.exit(2);
}
if (action === "reject" && !note?.trim()) {
  console.error("--reject 需要 --note \"…\"：拒绝的理由要留在行上，否则三个月后没人知道为什么");
  process.exit(2);
}

try {
  if (action === "list") {
    const rows = await sql<{ id: string; name: string; lang: string | null; region: string | null; discovered_via: string; review_note: string | null }[]>`
      SELECT id, name, lang, region, discovered_via, review_note
      FROM sources
      WHERE NOT enabled AND discovered_via IS NOT NULL
      ORDER BY discovered_via, name, id`;
    if (rows.length === 0) {
      console.log("没有待审核的信源（enabled=false 且 discovered_via 非空）");
    } else {
      console.log("id\tname\tlang\tregion\t发现来源\t验证读数");
      for (const row of rows) {
        console.log([row.id, row.name, row.lang ?? "-", row.region ?? "-", row.discovered_via, row.review_note ?? "-"].join("\t"));
      }
      console.log(`\n共 ${rows.length} 条待审核`);
    }
  } else if (action === "enable") {
    const changed = await sql<{ id: string }[]>`
      UPDATE sources
      SET enabled = true, health = 'unknown', updated_at = now()
      WHERE id = ANY(${ids}::text[]) AND NOT enabled AND discovered_via IS NOT NULL
      RETURNING id`;
    const missing = ids.filter((id) => !changed.some((row) => row.id === id));
    console.log(`启用 ${changed.length} 条`);
    if (missing.length) console.log(`未变（不存在、已启用或不是发现来的）：${missing.join(", ")}`);
  } else {
    const changed = await sql<{ id: string }[]>`
      UPDATE sources
      SET enabled = false,
          review_note = 'rejected ' || discovered_via || ': ' || ${note!.trim()},
          discovered_via = NULL,
          updated_at = now()
      WHERE id = ANY(${ids}::text[]) AND discovered_via IS NOT NULL
      RETURNING id`;
    const missing = ids.filter((id) => !changed.some((row) => row.id === id));
    console.log(`拒绝 ${changed.length} 条`);
    if (missing.length) console.log(`未变（不存在或已经审过）：${missing.join(", ")}`);
  }
} finally {
  await closeDb();
}
