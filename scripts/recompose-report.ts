// Recompose one existing issue (daily/weekly/monthly) from the material as it is *now*.
//
// Why: an edition is a snapshot of the copy at compose time. Correcting an item's Chinese copy afterwards
// leaves the paper showing the old text — on 2026-10-02 the daily still printed seven English titles hours
// after those items had been translated, while their own pages were Chinese. `saveReport` overwrites the
// content and files the previous version into `report_revisions` — keep that in mind, but nothing reads a
// revision back: rolling an issue back is manual SQL (the --apply path says so too).
//
//   node --env-file=.env --env-file=.env.pipeline scripts/recompose-report.ts --kind daily --key 2026-10-02
//   node --env-file=.env --env-file=.env.pipeline scripts/recompose-report.ts --kind daily --key 2026-10-02 --apply
//   批量按天重排时加 --skip-unchanged：组稿输入及去重依赖指纹完全相同就退出，不花导语调用。
//
// Local dev needs both env files (the model endpoint — the brain stub on 3055 — lives in `.env.pipeline`;
// without it the call fails with "Model default is not configured"). Production has a single `.env` with the
// LLM_* values inside it; passing a missing `.env.pipeline` there makes node exit with "file not found".
import { parseArgs } from "node:util";
import { hasChineseCopy } from "@aihot/contracts/copy";
import { closeDb, sql } from "@aihot/backend/db";
import { composeDaily, composeMonthly, composeWeekly, editionsAhead, reportInput, reportInputUnchanged } from "@aihot/backend/reports/compose";

const { values } = parseArgs({
  options: {
    kind: { type: "string" },
    key: { type: "string" },
    apply: { type: "boolean", default: false },
    skipUnchanged: { type: "boolean", default: false },
    "skip-unchanged": { type: "boolean", default: false },
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

// Use the exact composition windows (including the final day of weekly/monthly editions).
const input = await reportInput(kind as "daily" | "weekly" | "monthly", key);
console.log(`按当前语料重排会取到 ${input.all.length} 条候选（标题全部含中文：${input.all.every((c) => hasChineseCopy(c.title))}）`);

if (kind === "daily") {
  const ahead = await editionsAhead("daily", key);
  if (ahead.length) console.log(`注意：${key} 之后已出刊 ${ahead.length} 期（${ahead.join(" ")}）。日报的去重只看更早的期次，重排这一期可能把那些期已经发过的事再印一遍；要版面一致，那几期也各跑一次本脚本。`);
}

// The same fingerprint as actual composition; old editions without it rebuild once.
const skipUnchanged = values.skipUnchanged || values["skip-unchanged"];
if (skipUnchanged) {
  if (await reportInputUnchanged(kind as "daily" | "weekly" | "monthly", key, input.fingerprint)) {
    console.log("组稿输入及依赖完全相同——跳过，不花这次模型调用");
    await closeDb();
    process.exit(0);
  }
}

if (!values.apply) {
  console.log("（dry run：没有改库。要重排请加 --apply；旧版会写进 report_revisions，但仓库里没有回退通道——回退要手写 SQL 把那一行的 content 写回 reports）");
} else {
  const res = kind === "daily" ? await composeDaily(key, "copy-refresh", skipUnchanged) : kind === "weekly" ? await composeWeekly(key, "copy-refresh", skipUnchanged) : await composeMonthly(key, "copy-refresh", skipUnchanged);
  console.log(`已重排：${JSON.stringify(res)}`);
}
await closeDb();
