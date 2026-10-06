// 用当前门槛重判存量条目的入选标记——**不花模型额度**。
//
// 为什么需要它：`analyses.selected` 是分析那一刻按当时门槛写下的布尔值（`editorial/analyze.ts:391`：
// `relevance === 'pass' && sum >= threshold * SCORE_CALLS`），之后改门槛不会回头改它。2026-10-06 站长把
// 门槛从 56/59/62 下移到 46/49/52（并补历史日报），要让 10-04～10-06 那几天已经分析过、分数其实够线的
// 条目重新入选，只能重判这一列；重跑分析要按条付模型的钱，而两次分数**已经存在库里**
// （`analyses.output->'scores'` 是那两次的原始数组），所以这里一次 SELECT + 一次 UPDATE 就够。
//
// 判据与运行时代码同源：`sum >= 2 × SELECTION.thresholds[tier]`，tier 取条目当前的信源分级。
// 不在 SQL 里再写一遍算式——门槛只有一处（industry/selection.ts），这里只是把同一句用在存量上。
//
//   node --env-file-if-exists=.env scripts/reselect-by-threshold.ts                     # dry-run
//   node --env-file-if-exists=.env scripts/reselect-by-threshold.ts --apply --database-url=postgres://…
//
// 写完按源重算 publication（`republishSource`，同样不花模型额度），所以列表/精选/RSS 会跟着变。
import { parseArgs } from "node:util";
import { SELECTION } from "@aihot/industry/selection";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { republishSource } from "@aihot/backend/publication/publish";

const SCORE_CALLS = 2;
const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "database-url": { type: "string" },
    since: { type: "string", default: new Date(Date.now() - 7 * 86_400_000).toISOString() },
  },
});
if (values.apply && !values["database-url"]) {
  console.error("--apply 必须显式给 --database-url=…");
  process.exit(2);
}
function sameTarget(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
if (values["database-url"] && !sameTarget(values["database-url"], config.databaseUrl)) {
  console.error("--database-url 指向的库与环境里的 DATABASE_URL 不是同一个");
  process.exit(2);
}
const since = new Date(values.since!);
if (Number.isNaN(since.getTime())) {
  console.error(`--since 不是个时间：${values.since}`);
  process.exit(2);
}

const rows = await sql<{ article_id: string; source_id: string; tier: string; relevance: string | null; selected: boolean | null; scores: unknown; score: string | null }[]>`
  SELECT a.article_id, ar.source_id, s.tier, a.relevance, a.selected, a.output->'scores' AS scores, a.score
  FROM analyses a
  JOIN articles ar ON ar.id = a.article_id
  JOIN sources s ON s.id = ar.source_id
  WHERE a.created_at > ${since} AND a.selected IS NOT NULL`;
const changes: Array<{ article_id: string; source_id: string; was: boolean; want: boolean; sum: number; threshold: number }> = [];
for (const r of rows) {
  const threshold = SELECTION.thresholds[r.tier];
  if (threshold === undefined) continue; // 不参与评分分级（EXCLUDE_MP 等）
  const vals = Array.isArray(r.scores) ? (r.scores as number[]) : [];
  const sum = vals.length === SCORE_CALLS ? vals.reduce((t, v) => t + Number(v), 0) : r.score === null ? null : Math.round(Number(r.score)) * SCORE_CALLS;
  if (sum === null) continue;
  const want = r.relevance === "pass" && sum >= threshold * SCORE_CALLS;
  if (want !== r.selected) changes.push({ article_id: r.article_id, source_id: r.source_id, was: !!r.selected, want, sum, threshold });
}
const gaining = changes.filter((c) => c.want).length;
const losing = changes.length - gaining;
const bySource = new Map<string, number>();
for (const c of changes) bySource.set(c.source_id, (bySource.get(c.source_id) ?? 0) + 1);
console.log(`窗口 ${since.toISOString()} 起：看了 ${rows.length} 条 analyses，其中 ${changes.length} 条要改（入选 +${gaining} / 退出 -${losing}），涉及 ${bySource.size} 个信源`);
for (const c of changes.slice(0, 8)) console.log(`  例：${c.article_id}  ${c.was} → ${c.want}（两次之和 ${c.sum}，门槛 ${c.threshold}×2）`);

if (!values.apply) {
  console.log("\nDRY-RUN：没有写库。要写加 --apply --database-url=…（写完按源重算 publication）");
  await closeDb();
  process.exit(0);
}

let written = 0;
for (const c of changes) {
  const res = await sql`UPDATE analyses SET selected = ${c.want}
                        WHERE article_id = ${c.article_id} AND selected IS DISTINCT FROM ${c.want}`;
  written += res.count;
}
console.log(`\n已改 ${written} 条 analyses.selected。按源重算 publication（不花模型额度）：`);
for (const sourceId of bySource.keys()) {
  const r = await republishSource(sourceId);
  console.log(`  ${sourceId}: 重算 ${r.total} 条，其中有变化 ${r.changed} 条`);
}
await closeDb();
