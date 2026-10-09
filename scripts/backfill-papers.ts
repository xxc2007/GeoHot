// Print the papers for a span the site already gathered but never laid out.
//
// Why a separate runner and not `catchUpReports`: catch-up covers the last seven days plus last week and
// month, because that is what a live site needs. The archive window is different — material for a March day
// arrives in October, as `backfill_reason = 'archive'` rows whose `timeline_at` is their own publication
// date. Those items are eligible for a March edition (see the archive branch of `candidates()`), but nothing
// ever asks for a March edition to be composed.
//
// Two invariants this script carries, both from `reports/compose.ts`:
//  - **chronological order.** `recentlyCovered("daily", key)` looks back at *older keys* within seven days to
//    decide what a fact may not repeat. Run newest-first and an old edition would happily reprint something a
//    later paper already carried.
//  - **only settled days.** A day whose archive articles have not all been judged yet would print an edition
//    that changes under the reader. Until an article has an analysis row it cannot be selected, so waiting for
//    the judgement is what makes the printed day final. `--force` prints anyway; `scripts/recompose-report.ts`
//    can re-lay a day afterwards, versioning the old one into `report_revisions`.
//
//   node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01                     # dry run: the plan
//   node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01 --to=2026-06-30 \
//     --kinds=daily --apply --database-url=postgres://…                                   # print them
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@aihot/contracts/time";
import { candidates, composeDaily, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { shutdownSignal } from "@aihot/backend/jobs/queue";

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
if (!/^\d{4}-\d{2}-\d{2}$/.test(values.from!) || (values.to && !/^\d{4}-\d{2}-\d{2}$/.test(values.to))) {
  console.error("用法：--from=YYYY-MM-DD [--to=YYYY-MM-DD] [--kinds=daily,weekly,monthly] [--force] [--refresh] [--apply --database-url=…]");
  process.exit(2);
}
if (values.apply && !values["database-url"]) {
  console.error("--apply 必须同时显式给出 --database-url=（与进程 DATABASE_URL 同一个库）");
  await closeDb();
  process.exit(2);
}
if (String(process.env.DATABASE_URL ?? "").includes("/geohot") && values.apply) {
  // Same warning the other operator scripts carry: this writes reader-visible papers, so the operator says
  // the target out loud rather than inheriting whatever the environment happened to point at.
  console.log("注意：正在对进程指向的库出刊（--database-url 与 DATABASE_URL 必须同库，见 deploy/geohot/DEPLOYMENT.md）。");
}

// A daily for D gathers [D-1 08:00, D 08:00) Beijing and closes at D 08:00: the last day whose window has
// shut is the one we may still print. Today's own paper is the scheduled job's business, not this script's.
const now = new Date();
const todayBeijing = beijingDate(now);
const due = now.getTime() >= Number(beijingMidnight(todayBeijing)) + 8 * 3600 * 1000 ? todayBeijing : addDays(todayBeijing, -1);
const from = values.from!;
const to = values.to || due;

/** The window a daily for `date` gathers, in the same arithmetic composeDaily uses. */
const dayWindow = (date: string) => {
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  return { start: new Date(end.getTime() - DAY), end };
};

/** Articles in the window that no editor — human or model — has recorded a judgement for yet. */
async function unsettled(start: Date, end: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles a
     WHERE a.timeline_at >= ${start} AND a.timeline_at < ${end}
       AND NOT EXISTS (SELECT 1 FROM analyses x WHERE x.article_id = a.id)`;
  return row?.n ?? 0;
}

async function hasReport(kind: string, key: string): Promise<boolean> {
  return !!(await sql`SELECT 1 FROM reports WHERE kind = ${kind} AND key = ${key}`)[0];
}

let printed = 0;
const plan: Array<{ kind: string; key: string; items: number; note: string }> = [];

for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  if (shutdownSignal.signal.aborted) {
    console.log("收到停止信号，已出刊的部分保留，下次从这里继续。");
    break;
  }
  const date = beijingDate(new Date(t));
  if (Number(beijingMidnight(date)) + 8 * 3600 * 1000 > now.getTime()) break; // the window is still open
  const { start, end } = dayWindow(date);
  const items = (await candidates(start, end)).length;
  const waiting = await unsettled(start, end);
  const exists = await hasReport("daily", date);
  if (kinds.includes("daily")) {
    if (!items) plan.push({ kind: "daily", key: date, items, note: "没有可刊条目" });
    else if (exists && !values.refresh) plan.push({ kind: "daily", key: date, items, note: "已出刊" });
    else if (waiting && !values.force) plan.push({ kind: "daily", key: date, items, note: `等 ${waiting} 条判完` });
    else {
      plan.push({ kind: "daily", key: date, items, note: values.apply ? "已出刊" : "会出刊" });
      if (values.apply) {
        const out = await composeDaily(date, "archive-backfill");
        printed++;
        console.log(`  daily ${out.key} entries=${out.entries}`);
      }
    }
  }
}

// Weeks and months come after the dailies, in the same order: their candidates are the same query over a
// longer window, and an issue is only worth printing once the period it covers has closed.
for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  const date = beijingDate(new Date(t));
  const week = isoWeekLabel(date);
  const range = isoWeekRange(week);
  if (!range || !kinds.includes("weekly") || range.start > to) continue; // only periods inside the span
  if (new Date(`${range.end}T08:00:00+08:00`).getTime() > now.getTime()) continue;
  const { start, end } = { start: beijingMidnight(range.start), end: beijingMidnight(addDays(range.end, 1)) };
  const items = (await candidates(start, end)).length;
  const exists = await hasReport("weekly", week);
  if (!items) plan.push({ kind: "weekly", key: week, items, note: "没有可刊条目" });
  else if (exists && !values.refresh) plan.push({ kind: "weekly", key: week, items, note: "已出刊" });
  else {
    plan.push({ kind: "weekly", key: week, items, note: values.apply ? "已出刊" : "会出刊" });
    if (values.apply) {
      const out = await composeWeekly(week, "archive-backfill");
      printed++;
      console.log(`  weekly ${out.key} entries=${out.entries}`);
    }
  }
  t = Number(beijingMidnight(range.end)); // one row per week, not per day
}

for (let cursor = `${from.slice(0, 7)}-01`; cursor.slice(0, 7) <= to.slice(0, 7); ) {
  if (!kinds.includes("monthly")) break;
  const ym = cursor.slice(0, 7);
  const nextMonth = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) + 1, 1));
  const lastDay = new Date(nextMonth.getTime() - DAY).toISOString().slice(0, 10);
  if (new Date(`${lastDay}T08:00:00+08:00`).getTime() > now.getTime()) break; // the month is still running
  const { start, end } = { start: beijingMidnight(`${ym}-01`), end: beijingMidnight(addDays(lastDay, 1)) };
  const items = (await candidates(start, end)).length;
  const exists = await hasReport("monthly", ym);
  if (!items) plan.push({ kind: "monthly", key: ym, items, note: "没有可刊条目" });
  else if (exists && !values.refresh) plan.push({ kind: "monthly", key: ym, items, note: "已出刊" });
  else {
    plan.push({ kind: "monthly", key: ym, items, note: values.apply ? "已出刊" : "会出刊" });
    if (values.apply) {
      const out = await composeMonthly(ym, "archive-backfill");
      printed++;
      console.log(`  monthly ${out.key} entries=${out.entries}`);
    }
  }
  cursor = nextMonth.toISOString().slice(0, 10);
}

const byNote = new Map<string, number>();
for (const p of plan) byNote.set(p.note, (byNote.get(p.note) ?? 0) + 1);
console.log(`\n${values.apply ? "出刊" : "计划"} ${plan.length} 期（${kinds.join("/")}，${from} → ${to}）：`);
for (const [note, n] of byNote) console.log(`  ${String(n).padStart(4)} × ${note}`);
if (!values.apply) console.log("\n默认只做计划不写库。确认后用 --apply --database-url=… 跑。");
await closeDb();
