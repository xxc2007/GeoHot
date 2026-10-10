// Print the papers for a span the site already gathered but never laid out.
//
// Why a separate runner and not `catchUpReports`: catch-up covers the last seven days plus last week and
// month, because that is what a live site needs. The archive window is different — material for a March day
// arrives in October, as `backfill_reason = 'archive'` rows whose `timeline_at` is their own publication
// date. Those items are eligible for a March edition (see the archive branch of `candidates()`), but nothing
// ever asks for a March edition to be composed.
//
// Three rules this script carries from `reports/compose.ts`, none of them style:
//  - **chronological order.** `recentlyCovered("daily", key)` looks back at *older keys* within seven days
//    to decide what a fact key may not repeat. Run newest-first and an old edition reprint something a
//    later paper already carried. The loop below does go old→new, but a day that is missing *inside* an
//    already-published span still gets filled behind its neighbours — `editionsAhead` names those
//    neighbours in the plan so the operator re-lays them (`--refresh` over the span needs no warning).
//  - **only closed periods, on the real window.** A daily for D closes at D 08:00 Beijing and a weekly's
//    last day runs to midnight after it — checking the wrong hour prints a period that is still gathering.
//  - **only settled days.** An article with no judgement yet cannot be selected, so a day whose archive
//    articles are still queued would be laid out twice: once now, once when the judgement lands. `--force`
//    prints anyway and `scripts/recompose-report.ts` can re-lay the day afterwards, versioning the old
//    edition into `report_revisions`. Articles that will *never* be judged (`skipped`, `failed`) must not
//    hold a day shut, so the gate looks at what is actually waiting, not at what has no row yet.
//
//   node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01                        # the plan
//   node --env-file=.env --env-file=.env.pipeline scripts/backfill-papers.ts --from=... \
//     --apply --database-url="$DATABASE_URL"                                                 # print them
// The pipeline env file is what production loads: without `MODEL_CALLS_ENABLED` an issue cannot be
// written up, and every period would fail the same way.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange, isValidDate } from "@aihot/contracts/time";
import { candidates, composeDaily, composeMonthly, composeWeekly, dailyWindow, editionsAhead, monthlyWindow } from "@aihot/backend/reports/compose";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-01-01" },
    to: { type: "string", default: "" },
    kinds: { type: "string", default: "daily,weekly,monthly" },
    force: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "database-url": { type: "string", default: "" },
  },
});

const DAY = 86_400_000;
const kinds = values.kinds!.split(",").map((k) => k.trim()).filter((k) => ["daily", "weekly", "monthly"].includes(k));
const usage = "用法：--from=YYYY-MM-DD [--to=YYYY-MM-DD] [--kinds=daily,weekly,monthly] [--force] [--refresh] [--apply --database-url=…]";
if (!isValidDate(values.from!) || (values.to && !isValidDate(values.to))) {
  console.error(usage);
  process.exit(2);
}
if (values.to && values.from! > values.to) {
  console.error(`--from(${values.from}) 晚于 --to(${values.to})，这样跑下去是 0 期，不是一批`);
  process.exit(2);
}
// The same guard the other operator scripts carry: the pool reads DATABASE_URL from the environment, so the
// parameter cannot redirect anything — it exists to catch "you aimed --apply at the wrong database". With
// this script that mistake writes reader-visible newspapers, so it refuses rather than warns.
const targetOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "";
  }
};
if (values.apply) {
  const given = targetOf(values["database-url"] ?? "");
  const live = targetOf(String(process.env.DATABASE_URL ?? ""));
  if (!values["database-url"] || !live || given !== live) {
    console.error(`--apply 必须显式给出 --database-url，且要与进程正在用的库同一个（给的是「${given || "空"}」，环境是「${live || "空"}」）`);
    await closeDb();
    process.exit(2);
  }
}

const now = new Date();
const today = beijingDate(now);
// The last daily whose window has shut: D's paper closes at D 08:00 Beijing.
const due = Number(beijingMidnight(today)) + 8 * 3600 * 1000 <= now.getTime() ? today : addDays(today, -1);
const from = values.from!;
const to = values.to || due;

/**
 * 这一期里还没定的条目，两种而不是一种：还没判的（'new' 且没有分析行），以及判完但投影没跑成的
 * （'analyzed' 且没有 publications 行）——后者正是 sweepUnprocessed 几分钟后会补上的那段，
 * 只数前一种会让这一天在缺一条本该入刊的故事的情况下出刊，而下一轮还会说"已出刊"。
 * 'failed' 故意不算未完成：它只有被操作者或 30 天重排救回来才会回到 'new'，那种情况交给 --refresh。
 */
async function unsettled(start: Date, end: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles a
     WHERE a.timeline_at >= ${start} AND a.timeline_at < ${end}
       AND ((a.processing_state = 'new' AND NOT EXISTS (SELECT 1 FROM analyses x WHERE x.article_id = a.id))
         OR (a.processing_state = 'analyzed' AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id)))`;
  return row?.n ?? 0;
}

const hasReport = async (kind: string, key: string) => !!(await sql`SELECT 1 FROM reports WHERE kind = ${kind} AND key = ${key}`)[0];

const plan: Array<{ kind: string; key: string; items: number; note: string }> = [];
const failures: string[] = [];
const partial: string[] = []; // 不在区间内 / 窗口还没关的期次：要说出来，不许静悄悄消失
const behind: string[] = []; // 补在已出刊区间中间的空天：去重只看更早的期次，要重排谁得说清楚

/** One period, one line in the plan; `--apply` composes it and a broken period does not stop the run. */
async function consider(kind: "daily" | "weekly" | "monthly", key: string, start: Date, end: Date, compose: () => Promise<{ key: string; entries: number }>) {
  const items = (await candidates(start, end)).length;
  const exists = await hasReport(kind, key);
  if (exists && !values.refresh) return plan.push({ kind, key, items, note: "已出刊" });
  if (!items) return plan.push({ kind, key, items, note: exists ? "无条目可重排" : "没有可刊条目" });
  // `items` is counted before the 7-day repeat dedupe and before the section caps, so an edition can still
  // come out with fewer entries — or none — than this number says.
  const waiting = values.force ? 0 : await unsettled(start, end);
  if (waiting) return plan.push({ kind, key, items, note: `等 ${waiting} 条判完` });
  const note = values.apply ? exists ? "已重排" : "已出刊" : exists ? "会重排" : "会出刊";
  if (kind === "daily" && !values.refresh) {
    const ahead = await editionsAhead("daily", key);
    if (ahead.length) behind.push(`daily ${key} 之后已有 ${ahead.length} 期出刊（${ahead.join(" ")}）：它的去重只看更早的期次，可能重印那几期发过的事，跑完 --refresh 重排它们`);
  }
  plan.push({ kind, key, items, note });
  if (!values.apply) return;
  try {
    const out = await compose();
    console.log(`  ${kind} ${out.key} entries=${out.entries}`);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    failures.push(`${kind} ${key}: ${why.slice(0, 120)}`);
    console.log(`  ! ${kind} ${key} 失败：${why.slice(0, 120)}`);
    plan[plan.length - 1] = { kind, key, items, note: "这一期失败" };
  }
}

for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)) && t <= Number(beijingMidnight(due)); t += DAY) {
  const date = beijingDate(new Date(t));
  const { start, end } = dailyWindow(date);
  await consider("daily", date, start, end, () => composeDaily(date, "archive-backfill"));
}

const seenWeeks = new Set<string>();
for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  const week = isoWeekLabel(beijingDate(new Date(t)));
  if (!kinds.includes("weekly") || seenWeeks.has(week)) continue;
  seenWeeks.add(week);
  const range = isoWeekRange(week);
  // A period counts only when it sits inside the requested span whole: half a week of January is not the
  // January week, and publishing it would print a week the reader cannot check against the dailies.
  // 2026-W01 starts 2025-12-29, so a span opening 2026-01-01 loses it. That used to vanish without a line,
  // which is how an operator reads "39 weeks planned" and thinks four are missing.
  if (!range || range.start < from || range.end > to) { if (range) partial.push(`weekly ${week}（${range.start}→${range.end} 不在区间内）`); continue; }
  const start = beijingMidnight(range.start);
  const end = beijingMidnight(addDays(range.end, 1));
  if (Number(end) > now.getTime()) { partial.push(`weekly ${week} 窗口还没关`); continue; }
  await consider("weekly", week, start, end, () => composeWeekly(week, "archive-backfill"));
  t = Number(beijingMidnight(range.end));
}

const seenMonths = new Set<string>();
for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  const ym = beijingDate(new Date(t)).slice(0, 7);
  if (!kinds.includes("monthly") || seenMonths.has(ym)) continue;
  seenMonths.add(ym);
  // 月窗只在 monthlyWindow 一处算。这里原来写 Date.UTC(y, m + 1, 1) 而 m 已经是 1 起的月份号，
  // 于是每个月都往后多算一个月：计划只出 01/03/05/07（02/04/06/08 被跨月的循环步进吃掉），
  // 而被数到的那几个月又各自横跨两个月。整期在区间内 + 窗口已关，两条都与周报同一条规矩。
  const w = monthlyWindow(ym);
  if (w.start < from || w.end > to) { partial.push(`monthly ${ym}（${w.start}→${w.end} 不在区间内）`); continue; }
  if (w.closes.getTime() > now.getTime()) { partial.push(`monthly ${ym} 窗口还没关`); continue; }
  await consider("monthly", ym, beijingMidnight(w.start), w.closes, () => composeMonthly(ym, "archive-backfill"));
}

const byNote = new Map<string, number>();
for (const p of plan) byNote.set(p.note, (byNote.get(p.note) ?? 0) + 1);
console.log(`\n${values.apply ? "出刊" : "计划"} ${plan.length} 期（${kinds.join("/")}，${from} → ${to}）：`);
for (const [note, n] of byNote) console.log(`  ${String(n).padStart(4)} × ${note}`);
if (failures.length) console.log(`\n${failures.length} 期失败：\n` + failures.map((f) => `  ${f}`).join("\n"));
if (partial.length) {
  console.log("\n另有 " + partial.length + " 个整期没排（区间边界或窗口未关）：");
  for (const s of partial.slice(0, 12)) console.log("  " + s);
  if (partial.length > 12) console.log("  …另 " + (partial.length - 12) + " 个");
}
if (behind.length) {
  console.log("\n" + behind.length + " 个空天补在已出刊的区间中间（去重只看更早的期次）：");
  for (const s of behind.slice(0, 12)) console.log("  " + s);
  if (behind.length > 12) console.log("  …另 " + (behind.length - 12) + " 个");
}
if (!values.apply) console.log("\n默认只做计划不写库。确认后用 --apply --database-url=… 跑。");
await closeDb();
