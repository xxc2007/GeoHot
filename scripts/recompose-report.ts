// Recompose one existing issue (daily/weekly/monthly) from the material as it is *now*.
//
// Why: an edition is a snapshot of the copy at compose time. Correcting an item's Chinese copy afterwards
// leaves the paper showing the old text — on 2026-10-02 the daily still printed seven English titles hours
// after those items had been translated, while their own pages were Chinese. `saveReport` overwrites the
// content and files the previous version into `report_revisions`, so recomposing is versioned and reversible.
//
//   node --env-file=.env --env-file=.env.pipeline scripts/recompose-report.ts --kind daily --key 2026-10-02
//   node --env-file=.env --env-file=.env.pipeline scripts/recompose-report.ts --kind daily --key 2026-10-02 --apply
//
// Local dev needs both env files (the model endpoint — the brain stub on 3055 — lives in `.env.pipeline`;
// without it the call fails with "Model default is not configured"). Production has a single `.env` with the
// LLM_* values inside it; passing a missing `.env.pipeline` there makes node exit with "file not found".
import { parseArgs } from "node:util";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { closeDb, sql } from "@aihot/backend/db";
import { candidates, composeDaily, composeMonthly, composeWeekly, dailyWindow, editionsAhead, monthlyWindow } from "@aihot/backend/reports/compose";
import { beijingMidnight, isoWeekRange } from "@aihot/contracts/time";

const { values } = parseArgs({
  options: {
    kind: { type: "string" },
    key: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const kind = values.kind ?? "";
const key = values.key?.trim() ?? "";
if (!["daily", "weekly", "monthly"].includes(kind) || !key) {
  console.error("用法：--kind daily|weekly|monthly --key <期次>（如 2026-10-02、2026-W39、2026-09）[--apply]");
  process.exit(2);
}

const [row] = await sql<{ content: Record<string, any>; revision: number; generated_at: Date }[]>`
  SELECT content, revision, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`;
if (!row) {
  console.error(`没有 ${kind} ${key} 这一期`);
  await closeDb();
  process.exit(1);
}
const items = (row.content.sections ?? []).flatMap((s: any) => s.items ?? []);
const flashes = row.content.flashes ?? [];
console.log(`${kind} ${key}：第 ${row.revision} 版（${row.generated_at.toISOString()}），正文 ${items.length} 条 / 快讯 ${flashes.length} 条`);
const english = [...items, ...flashes].filter((i: any) => !hasChineseCopy(String(i.title ?? "")));
console.log(`其中标题不含中文的：${english.length} 条${english.length ? `（如「${String(english[0].title).slice(0, 50)}」）` : ""}`);

// What the current material would yield — a preview that does not write anything.
// 窗口必须由 beijingMidnight 换算：`isoWeekRange` 给的是日期字符串，`new Date("2026-01-04")` 读成 UTC 零点，
// 比真窗口早 8 小时——以前这里数出来的候选条数说的不是这一期实际看到的区间。月报现在也预览（monthlyWindow 同源）。
const range = kind === "daily"
  ? dailyWindow(key)
  : kind === "weekly"
    ? (() => { const r = isoWeekRange(key); return r ? { start: beijingMidnight(r.start), end: beijingMidnight(r.end) } : null; })()
    : kind === "monthly"
      ? (() => { const w = monthlyWindow(key); return { start: beijingMidnight(w.start), end: beijingMidnight(w.end) }; })()
      : null;
if (range) {
  const list = await candidates(new Date(range.start), new Date(range.end));
  console.log(`按当前语料重排会取到 ${list.length} 条候选（标题全部含中文：${list.every((c) => hasChineseCopy(c.title))}）`);
} else {
  // 走到这里只剩一种可能：周号本身不合法（`isoWeekRange` 拒 W00/W54/2025-W53 这类）。窗口算不出来，
  // 所以预览没有——重排仍会跑，只是它取哪段区间这里说不清。
  console.log(`（${kind} ${key}：这一期的窗口算不出来，只报告上面那一版）`);
}

if (kind === "daily") {
  const ahead = await editionsAhead("daily", key);
  if (ahead.length) console.log(`注意：${key} 之后已出刊 ${ahead.length} 期（${ahead.join(" ")}）。日报的去重只看更早的期次，重排这一期可能把那些期已经发过的事再印一遍；要版面一致，那几期也各跑一次本脚本。`);
}

if (!values.apply) {
  console.log("（dry run：没有改库。要重排请加 --apply；旧版会写进 report_revisions，可回滚）");
} else {
  const res = kind === "daily" ? await composeDaily(key, "copy-refresh") : kind === "weekly" ? await composeWeekly(key, "copy-refresh") : await composeMonthly(key, "copy-refresh");
  console.log(`已重排：${JSON.stringify(res)}`);
}
await closeDb();
