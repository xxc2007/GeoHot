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
//    later paper already carried.
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
import { candidates, composeDaily, composeMonthly, composeWeekly, dailyWindow } from "@aihot/backend/reports/compose";

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

/** Articles in the window that are still waiting to be judged — not the ones that will never be. */
async function unsettled(start: Date, end: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles a
     WHERE a.timeline_at >= ${start} AND a.timeline_at < ${end} AND a.processing_state = 'new'
       AND NOT EXISTS (SELECT 1 FROM analyses x WHERE x.article_id = a.id)`;
  return row?.n ?? 0;
}

const hasReport = async (kind: string, key: string) => !!(await sql`SELECT 1 FROM reports WHERE kind = ${kind} AND key = ${key}`)[0];

const plan: Array<{ kind: string; key: string; items: number; note: string }> = [];
const failures: string[] = [];

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

for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  const week = isoWeekLabel(beijingDate(new Date(t)));
  const range = isoWeekRange(week);
  // A period counts only when it sits inside the requested span whole: half a week of January is not the
  // January week, and publishing it would print a week the reader cannot check against the dailies.
  if (!range || !kinds.includes("weekly") || range.start < from || range.end > to) continue;
  const start = beijingMidnight(range.start);
  const end = beijingMidnight(addDays(range.end, 1));
  if (Number(end) > now.getTime()) continue;
  await consider("weekly", week, start, end, () => composeWeekly(week, "archive-backfill"));
  t = Number(beijingMidnight(range.end));
}

for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  const ym = beijingDate(new Date(t)).slice(0, 7);
  if (!kinds.includes("monthly") || ym < from.slice(0, 7) || `${ym}-01` > to.slice(0, 7)) continue;
  const firstOfNext = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) + 1, 1));
  const lastDay = new Date(firstOfNext.getTime() - DAY).toISOString().slice(0, 10);
  const start = beijingMidnight(`${ym}-01`);
  const end = beijingMidnight(addDays(lastDay, 1));
  if (lastDay > to.slice(0, 10) || Number(end) > now.getTime()) continue;
  await consider("monthly", ym, start, end, () => composeMonthly(ym, "archive-backfill"));
  t = Number(beijingMidnight(firstOfNext.toISOString().slice(0, 10))) - DAY;
}

const byNote = new Map<string, number>();
for (const p of plan) byNote.set(p.note, (byNote.get(p.note) ?? 0) + 1);
console.log(`\n${values.apply ? "出刊" : "计划"} ${plan.length} 期（${kinds.join("/")}，${from} → ${to}）：`);
for (const [note, n] of byNote) console.log(`  ${String(n).padStart(4)} × ${note}`);
if (failures.length) console.log(`\n${failures.length} 期失败：\n` + failures.map((f) => `  ${f}`).join("\n"));
if (!values.apply) console.log("\n默认只做计划不写库。确认后用 --apply --database-url=… 跑。");
await closeDb();
