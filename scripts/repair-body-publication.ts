// 正文污染 hotfix 的有界回流脚本。
//
// 2026-11-16：四条生产记录被应急改成 visibility='summary-only'，详情页因此 404。本脚本把这些行
// （以及任何 classifier 判为 defect 的行）重新走一遍：清洗存储正文 → 重跑 classifyBodyQuality →
// 合格则把 extractBody/analyze/group 重新入队，等下游流水线落定后由 publishArticle 恢复 public；
// 不合格则保持隐藏，记录 reasons 与 rule_version。
//
// 跑法（默认 DRY-RUN，一行都不写）：
//   node --env-file=.env scripts/repair-body-publication.ts                          # 只数 + 抽样
//   node --env-file=.env scripts/repair-body-publication.ts --apply --database-url-env=DATABASE_URL --limit=50
// 参数：
//   --summary-only           只挑被应急下拉的 visibility='summary-only' 行（默认包含）
//   --defective              额外挑 classifier 已判 defect 的行
//   --reprocess-requested     额外挑人工标记 reprocess 的行
//   --limit=N                封顶（默认 50）
//
// 不伪造完成：入队失败/模型不可用时写一条 'failed' 日志并跳过，绝不动 visibility。
// 写完一篇立刻 purgePublicationCaches（进程缓存 + 落盘底稿），并 bump publication.epoch 让 edge 再校验。
import process from "node:process";
import { closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { listRepairCandidates, driveRepair } from "@aihot/backend/publication/body-repair";
import { shutdownSignal } from "@aihot/backend/jobs/queue";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const num = (name: string, dflt: number) => Number(args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? dflt);
const limit = num("--limit", 50);
const wantSummaryOnly = !args.includes("--defective") && !args.includes("--reprocess-requested") || args.includes("--summary-only");

if (apply) {
  const envFlag = args.find((a) => a.startsWith("--database-url-env="))?.slice("--database-url-env=".length);
  if (envFlag !== "DATABASE_URL") {
    console.error("--apply 必须同时给 --database-url-env=DATABASE_URL（别把带口令的 DSN 放上命令行）");
    process.exit(2);
  }
} else {
  console.log(`DRY-RUN：只数不改。要真回流请加 --apply --database-url-env=DATABASE_URL`);
}
if (!config.databaseUrl) {
  console.error("没有 DATABASE_URL，本脚本连不上库");
  process.exit(2);
}

const candidates = await listRepairCandidates({
  summaryOnly: wantSummaryOnly,
  defective: args.includes("--defective"),
  reprocessRequested: args.includes("--reprocess-requested"),
  limit,
});
console.log(`候选 ${candidates.length} 行（summary-only=${wantSummaryOnly}, defective=${args.includes("--defective")}, reprocess=${args.includes("--reprocess-requested")}）`);
for (const c of candidates.slice(0, 10)) {
  console.log(`  · ${c.source_name}｜${String(c.title).slice(0, 40)}｜vis=${c.visibility}｜body=${c.body_chars}字｜reasons=${c.quality_reasons.join(",") || "-"}`);
}

if (!apply) {
  console.log("DRY-RUN 结束（上面是样本，没有写库）");
  await closeDb();
  process.exit(0);
}

let requeued = 0, stillDefective = 0, failed = 0;
for (const c of candidates) {
  if (shutdownSignal.signal.aborted) { console.log(`收到停止信号，已处理 ${requeued + stillDefective + failed}/${candidates.length}`); break; }
  try {
    const r = await driveRepair(c.article_id, true);
    if (r.action === "requeued") requeued += 1;
    else if (r.action === "still-defective") stillDefective += 1;
    else failed += 1;
    console.log(`  ${r.articleId}：${r.action}（${r.reasons.join(",") || "ok"}）`);
  } catch (error) {
    failed += 1;
    console.error(`  ! ${c.article_id}: ${(error as Error).message.slice(0, 160)}`);
  }
}
console.log(`完成：requeued=${requeued} still-defective=${stillDefective} failed=${failed}`);
console.log("下游 extractBody/analyze/group 落定后，publishArticle 会自动把合格行翻回 public；清单见 publication_body_repair_log。");
await closeDb();
