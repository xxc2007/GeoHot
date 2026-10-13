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
//     --apply --database-url-env=DATABASE_URL                                                # print them
// The pipeline env file is what production loads: without `MODEL_CALLS_ENABLED` an issue cannot be
// written up, and every period would fail the same way.
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange, isValidDate } from "@aihot/contracts/time";
import { candidates, composeDaily, composeMonthly, composeWeekly, dailyWindow, editionsAhead, monthlyWindow } from "@aihot/backend/reports/compose";
import { loadReport } from "@aihot/backend/publication/reports";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-01-01" },
    to: { type: "string", default: "" },
    kinds: { type: "string", default: "daily,weekly,monthly" },
    force: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "verify-complete": { type: "boolean", default: false },
    "database-url": { type: "string", default: "" },
    "database-url-env": { type: "string" },
    "summary-file": { type: "string" },
  },
});

const DAY = 86_400_000;
/**
 * The archive cycle kills this phase with SIGTERM at its own deadline, and `run_phase` exports that deadline
 * as `GEOHOT_PHASE_SECONDS`. Being killed *during* a paid call is not a harmless interruption: the receipt is
 * left `pending`, the sweeper marks it `unknown` (`providers/receipts.ts:markStalePendingReceipts`), and an
 * `unknown` outcome is never re-sent without an operator — by design, because the provider may have billed it.
 * That edition is then blocked on that door: the pool has to rotate to another service (whose logical key
 * is different) before the composition goes through — which is what finally freed 02-28 and 03-13 today, after
 * seven cycles of 「失败」 each. With only one door available for that step, the edition waits for an operator.
 * Measured 2026-10-13: `papers` exited 124 (timeout) in **every** cycle of the last 14, and two dates were
 * already locked that way (`report:daily:2026-02-28`, `2026-03-13`).
 * The fix is to stop *starting* work while one call still fits before the kill, and exit 0 so the phase
 * finishes as a normal round; the remaining editions are still un-published and the next cycle takes them.
 */
const PHASE_SECONDS = Number(process.env.GEOHOT_PHASE_SECONDS ?? "");
const CALL_HEADROOM_MS = 300_000; // the longest single model call is 240 s (`providers/llm.ts`), plus slack
const runStartedAt = Date.now();
const outOfPhaseBudget = () => Number.isFinite(PHASE_SECONDS) && PHASE_SECONDS > 0
  && Date.now() - runStartedAt > PHASE_SECONDS * 1000 - CALL_HEADROOM_MS;
let stoppedForBudget = false;
const requestedKinds = values.kinds!.split(",").map((k) => k.trim());
const allowedKinds = ["daily", "weekly", "monthly"];
if (requestedKinds.some((k) => !allowedKinds.includes(k))) {
  console.error("--kinds 必须是 daily、weekly、monthly 的非空逗号分隔列表，不能包含未知类型或空项");
  process.exit(2);
}
const kinds = [...new Set(requestedKinds)];
if (values["verify-complete"] && (values.apply || values.force || values.refresh ||
    process.argv.slice(2).some((arg) => ["--database-url", "--database-url-env"].includes(arg.split("=")[0]!)))) {
  console.error("--verify-complete 是只读验收，不能与 --apply/--force/--refresh/数据库写入确认参数一起使用");
  process.exit(2);
}
if (values["database-url-env"] !== undefined && (values["database-url-env"] !== "DATABASE_URL" || values["database-url"])) {
  console.error("--database-url-env 仅接受 DATABASE_URL，且与 --database-url 互斥");
  process.exit(2);
}
if (values["summary-file"] !== undefined && !values["summary-file"].trim()) {
  console.error("--summary-file 必须给出非空文件路径");
  process.exit(2);
}
const usage = "用法：--from=YYYY-MM-DD [--to=YYYY-MM-DD] [--kinds=daily,weekly,monthly] [--force] [--refresh] [--summary-file=path.json] [--apply --database-url-env=DATABASE_URL]";
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
  const givenUrl = values["database-url-env"] ? process.env.DATABASE_URL ?? "" : values["database-url"] ?? "";
  const given = targetOf(givenUrl);
  const live = targetOf(String(process.env.DATABASE_URL ?? ""));
  if (!givenUrl || !live || given !== live) {
    console.error(`--apply 必须显式给出 --database-url 或 --database-url-env=DATABASE_URL，且要与进程正在用的库同一个（给的是「${given || "空"}」，环境是「${live || "空"}」）`);
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
 * 这一期里还没定的条目，两种而不是一种：还没走的（`new`），以及判完但投影没跑成的
 * （`analyzed` 且没有 publications 行）——后者正是 sweepUnprocessed 几分钟后会补上的那段，
 * 只数前一种会让这一天在缺一条本该入刊的故事的情况下出刊，而下一轮还会说"已出刊"。
 *
 * `new` 不再要求"没有分析行"：一条 `new` 行**带着**分析行是真实存在的状态——发布失败之后状态被退回
 * `new`（jobs/content.ts 的重试路径），或者分析写完而状态更新被跳过（analyze.ts 的换版分支）。
 * 带上这个要求时它两种都不算，于是这一天按"判完了"出刊，永久缺那一条（补刊不会再碰已出刊的期）。
 * 一条 `new` 行迟早会离开 `new`（跑通或进 failed/blocked），所以按它算不会把某一天永远钉住——
 * 真要放行那一天，用 `--force`，那是操作者的明确选择。
 * 'failed' 故意不算未完成：它只有被操作者或 30 天重排救回来才会回到 'new'，那种情况交给 --refresh。
 */
async function unsettled(start: Date, end: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM articles a
     WHERE a.timeline_at >= ${start} AND a.timeline_at < ${end}
       AND (a.processing_state = 'new'
         OR (a.processing_state = 'analyzed' AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id)))`;
  return row?.n ?? 0;
}

const plan: Array<{ kind: string; key: string; items: number; note: string; waiting: number; exists: boolean; readable: boolean | null; entries: number | null; status?: string }> = [];
const blockers: Array<{ kind: string; key: string; code: string; waiting: number }> = [];
const failures: string[] = [];
const partial: string[] = []; // 不在区间内 / 窗口还没关的期次：要说出来，不许静悄悄消失
const behind: string[] = []; // 补在已出刊区间中间的空天：去重只看更早的期次，要重排谁得说清楚

/** One period, one line in the plan; `--apply` composes it and a broken period does not stop the run. */
async function consider(kind: "daily" | "weekly" | "monthly", key: string, start: Date, end: Date, compose: () => Promise<{ key: string; entries: number }>) {
  const items = (await candidates(start, end)).length;
  const existing = await loadReport(kind, key);
  const exists = existing !== null;
  // `items` is counted before the 7-day repeat dedupe and before the section caps, so an edition can still
  // come out with fewer entries — or none — than this number says.
  const waiting = values.force ? 0 : await unsettled(start, end);
  const state = { kind, key, items, waiting, exists, readable: existing?.readable ?? null,
    entries: existing ? existing.sections.reduce((n, section) => n + section.items.length, 0) + existing.flashes.length : null };
  if (values["verify-complete"]) {
    const status = waiting ? "waiting" : exists && !existing.readable ? "empty-not-published"
      : existing?.readable ? "readable" : items ? "missing-readable-report" : "zero-material";
    const blocked = ["waiting", "empty-not-published", "missing-readable-report"].includes(status);
    if (blocked) blockers.push({ kind, key, code: status, waiting });
    return plan.push({ ...state, status, note: status === "zero-material" ? "已判完但没有可刊候选（不代表来源覆盖完成）"
      : status === "empty-not-published" ? "已有空刊或不可读刊期，尚未出刊" : status });
  }
  if (waiting) return plan.push({ ...state, note: `等 ${waiting} 条判完` });
  if (exists && !values.refresh) return plan.push({ ...state, note: existing.readable ? "已有可读刊期（未重排）" : "已有不可读刊期（需 --refresh 复核）" });
  if (!items) return plan.push({ ...state, note: exists ? "无条目可重排" : "已判完但没有可刊条目" });
  const note = values.apply ? exists ? "已重排" : "已出刊" : exists ? "会重排" : "会出刊";
  if (kind === "daily" && !values.refresh) {
    const ahead = await editionsAhead("daily", key);
    if (ahead.length) behind.push(`daily ${key} 之后已有 ${ahead.length} 期出刊（${ahead.join(" ")}）：它的去重只看更早的期次，可能重印那几期发过的事，跑完 --refresh 重排它们`);
  }
  plan.push({ ...state, note });
  if (!values.apply) return;
  // The budget is spent composing, not planning: stop here, before a paid call that the cycle's own SIGTERM
  // would cut in half. One line for the period that got away, then the loops below break.
  if (outOfPhaseBudget()) {
    stoppedForBudget = true;
    plan[plan.length - 1] = { ...state, note: "本轮时间预算用完，这一期没开始" };
    return;
  }
  try {
    const out = await compose();
    const saved = await loadReport(kind, key);
    const readable = saved?.readable ?? false;
    const entries = saved ? saved.sections.reduce((n, section) => n + section.items.length, 0) + saved.flashes.length : out.entries;
    plan[plan.length - 1] = { ...state, exists: true, readable, entries,
      note: readable ? note : "已保存空刊或不可读刊期" };
    console.log(`  ${kind} ${out.key} entries=${out.entries}`);
  } catch (error) {
    // Provider exceptions can carry endpoint credentials. Persist only a safe failure category;
    // the protected job/receipt views retain detailed diagnostics for the operator.
    const category = error instanceof Error ? error.name : "Error";
    const why = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(category) ? category : "Error";
    failures.push(`${kind} ${key}: ${why}`);
    console.log(`  ! ${kind} ${key} 失败：${why}`);
    plan[plan.length - 1] = { ...state, note: "这一期失败" };
  }
}

for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)) && t <= Number(beijingMidnight(due)); t += DAY) {
  if (!kinds.includes("daily")) break;
  if (stoppedForBudget) break;
  const date = beijingDate(new Date(t));
  const { start, end } = dailyWindow(date);
  await consider("daily", date, start, end, () => composeDaily(date, "archive-backfill"));
}

const seenWeeks = new Set<string>();
for (let t = Number(beijingMidnight(from)); t <= Number(beijingMidnight(to)); t += DAY) {
  if (stoppedForBudget) break;
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
  if (stoppedForBudget) break;
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
if (stoppedForBudget) {
  console.log(`\n时间预算（GEOHOT_PHASE_SECONDS=${PHASE_SECONDS}s，留 ${(CALL_HEADROOM_MS / 1000) | 0}s 给在飞的那一次调用）用尽，后面还有期次没跑：本轮正常收尾，下一轮接着从旧到新做。`);
}
if (values["verify-complete"]) console.log(`\n报刊层验收：${blockers.length ? "未通过" : "通过"}；阻断 ${blockers.length} 期。该结果不验证来源覆盖、failed/unknown 处置、最终重排新鲜度或整个目标。`);
else if (!values.apply) console.log("\n默认只做计划不写库。确认后用 --apply --database-url-env=DATABASE_URL 跑。");
await closeDb();
process.exitCode = failures.length || blockers.length ? 1 : 0;
if (values["summary-file"]) {
  await writeFile(values["summary-file"], JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: values["verify-complete"] ? "verify" : values.apply ? "apply" : "plan",
    from, to, kinds,
    refresh: values.refresh, force: values.force,
    plan, failures, partial, behind,
    counts: Object.fromEntries(byNote),
    ...(values["verify-complete"] ? { verification: {
      scope: "closed-report-periods", passed: blockers.length === 0, blockers,
      zeroMaterialMeaning: "窗口没有可刊候选，不代表没有原始资料或完成来源检索",
      notEvaluated: ["source-archive-coverage", "failed-material-disposition", "unknown-analysis-disposition",
        "copy-factual-quality", "refresh-freshness", "website-functions", "deployment-sync"],
    } } : {}),
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
