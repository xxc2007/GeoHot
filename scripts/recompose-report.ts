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
import { candidates, composeDaily, composeWeekly, composeMonthly } from "@aihot/backend/reports/compose";
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
const range = kind === "daily"
  ? (() => { const end = new Date(beijingMidnight(key).getTime() + 8 * 3600 * 1000); return { start: new Date(end.getTime() - 86400000), end }; })()
  : kind === "weekly"
    ? (() => { const r = isoWeekRange(key); return r ? { start: r.start, end: r.end } : null; })()
    : null;
if (range) {
  const list = await candidates(new Date(range.start), new Date(range.end));
  console.log(`按当前语料重排会取到 ${list.length} 条候选（标题全部含中文：${list.every((c) => hasChineseCopy(c.title))}）`);
} else {
  console.log("（周/月报的候选窗口由 composeWeekly/composeMonthly 内部计算，这里不预览）");
}

if (!values.apply) {
  console.log("（dry run：没有改库。要重排请加 --apply；旧版会写进 report_revisions，可回滚）");
} else {
  const res = kind === "daily" ? await composeDaily(key, "copy-refresh") : kind === "weekly" ? await composeWeekly(key, "copy-refresh") : await composeMonthly(key, "copy-refresh");
  console.log(`已重排：${JSON.stringify(res)}`);
}
await closeDb();
