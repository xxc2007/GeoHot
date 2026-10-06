// 门槛与真实分数的对照表：把「按现在的模型，门槛 T 一天会选几条」算出来给人看。
//
// 为什么需要它：`industry/selection.ts` 的头注释自己写着这组门槛"是推出来的、还没被 gold 集校准过"。
// 2026-10-06 接入真模型之后实测（生产库、只看 10-06 00:00+08 之后的 pass 条目）：
//   T1   n=350 均值 22  p90 33  p95 41  最大 61   —— 门槛 56
//   T1_5 n=14  均值 35  p90 49  p95 53  最大 53   —— 门槛 59
//   T2   n=49  均值 28  p90 45  p95 50  最大 57   —— 门槛 62
// 也就是说三个门槛都压在各自分布的 p95 之上，全站一天选出 3 条左右；日报因此多数日子没有内容。
// **这不是缺陷，是标定问题**：改门槛=改"什么算重要"，属站长决定（AGENTS.md 的规矩）。
// 这个脚本只做一件事：把选择摆出来，谁都能当场复算。
//
//   node --env-file-if-exists=.env scripts/eval-thresholds.ts
//   node --env-file-if-exists=.env scripts/eval-thresholds.ts --since=2026-10-06T00:00:00+08:00
//
// 只读：一条 SELECT，不写库、不调模型。
import { parseArgs } from "node:util";
import { SELECTION } from "@aihot/industry/selection";
import { closeDb, sql } from "@aihot/backend/db";

const THRESHOLDS = SELECTION.thresholds;

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "2026-10-06T00:00:00+08:00" },
    candidates: { type: "string", default: "40,44,46,48,50,52,54,56,58,60,62" },
  },
});
const since = new Date(values.since!);
if (Number.isNaN(since.getTime())) {
  console.error(`--since 不是个时间：${values.since}`);
  process.exit(2);
}

const perTier = await sql<{ tier: string; n: number; mean: number; p50: number; p75: number; p90: number; p95: number; max: number }[]>`
  SELECT s.tier,
         count(*)::int AS n,
         round(avg(a.score))::int AS mean,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY a.score) AS p50,
         percentile_disc(0.75) WITHIN GROUP (ORDER BY a.score) AS p75,
         percentile_disc(0.9) WITHIN GROUP (ORDER BY a.score) AS p90,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY a.score) AS p95,
         max(a.score) AS max
  FROM analyses a
  JOIN articles ar ON ar.id = a.article_id
  JOIN sources s ON s.id = ar.source_id
  WHERE a.relevance = 'pass' AND a.score IS NOT NULL AND a.created_at > ${since}
  GROUP BY s.tier ORDER BY s.tier`;
const days = Math.max(1, (Date.now() - since.getTime()) / 86_400_000);
console.log(`窗口：${since.toISOString()} 起（约 ${days.toFixed(1)} 天）。现行门槛：${Object.entries(THRESHOLDS).map(([k, v]) => `${k} ${v}`).join(" / ")}；understandFloor ${SELECTION.understandFloor}`);
console.log("\n分层与分布（pass 且已打分）：");
console.log("  tier   n    mean  p50  p75  p90  p95  max   现行门槛");
for (const t of perTier) {
  const threshold = (THRESHOLDS as Record<string, number | undefined>)[t.tier] ?? null;
  console.log(`  ${t.tier.padEnd(5)} ${String(t.n).padStart(4)}  ${String(t.mean).padStart(4)}  ${String(t.p50).padStart(3)}  ${String(t.p75).padStart(3)}  ${String(t.p90).padStart(3)}  ${String(t.p95).padStart(3)}  ${String(t.max).padStart(3)}   ${threshold ?? "（不参与精选）"}`);
}

const candidates = values.candidates!.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
console.log(`\n按「两次打分之和 ≥ 2 × 门槛」的口径，各候选门槛在窗口内的命中量（全部分层合计）：`);
console.log("  门槛  窗口内命中  平均每天");
for (const min of candidates) {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM analyses a
    WHERE a.relevance = 'pass' AND a.score IS NOT NULL AND a.created_at > ${since} AND a.score >= ${min}`;
  console.log(`  ${String(min).padStart(4)}  ${String(row!.n).padStart(9)}  ${(row!.n / days).toFixed(1).padStart(8)}${min === (THRESHOLDS as Record<string, number>).T1 ? "   ← 现行 T1 门槛" : ""}`);
}
console.log("\n改门槛＝改「什么算重要」，由站长定；这个脚本只把数摆出来。");
await closeDb();
