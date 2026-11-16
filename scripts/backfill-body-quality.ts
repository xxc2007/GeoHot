// 正文污染 hotfix 的预回填脚本：给所有现存公开行打上 body_quality_status/reasons/rule_version。
//
// 为什么要在部署新 API/worker 之前跑：新公开条件要求 body_quality_status='ok'。如果先部署代码，
// 还没打标的行（body_quality_status IS NULL）会瞬间全部不公开 —— 全站空白。所以先把存量全部打标，
// 再发版；发版后新写入由 refreshWorkflowReadinessTx 自动打标。
//
// 跑法（默认 DRY-RUN，只计数不写）：
//   node --env-file=.env scripts/backfill-body-quality.ts
//   node --env-file=.env scripts/backfill-body-quality.ts --apply --database-url-env=DATABASE_URL --limit=2000
//
// 行为：
//   · policy_version 保持不变（旧行仍为 3，新写入才是 4）；
//   · classifier 判 ok → body_quality_status='ok'，ready 不动；
//   · classifier 判 defect → body_quality_status='defect'，并把 ready 翻成 false（防止回滚到旧 API
//     后旧 API 用 ready=true 重新暴露脏正文），写一条 publication_body_repair_log(event=hidden)；
//   · 没有就绪行的文章先按现有事实补一行（ready 由 rawWorkflowReadyCondition 判定）。
//
// 不调用模型：只跑本地 classifyBodyQuality。可重跑：已打标且 rule_version 相同的行跳过。
import process from "node:process";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { classifyBodyQuality, BODY_QUALITY_RULE_VERSION } from "@aihot/backend/content/body-quality";
import { refreshWorkflowReadinessTx } from "@aihot/backend/publication/readiness";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? 5000);

if (apply) {
  const envFlag = args.find((a) => a.startsWith("--database-url-env="))?.slice("--database-url-env=".length);
  if (envFlag !== "DATABASE_URL") {
    console.error("--apply 必须同时给 --database-url-env=DATABASE_URL");
    process.exit(2);
  }
} else {
  console.log("DRY-RUN：只计数不写。要真回填请加 --apply --database-url-env=DATABASE_URL");
}
if (!config.databaseUrl) { console.error("没有 DATABASE_URL"); process.exit(2); }

// 只扫当前真正会被新公开条件读到的行：public + full + 来源允许全文。
const rows = await sql<{ article_id: string; url: string; title: string; body_html: string | null; body_text: string | null }[]>`
  SELECT p.article_id, a.url, a.title, a.body_html, a.body_text
  FROM publications p
  JOIN sources s ON s.id = p.source_id AND s.site_fulltext
  JOIN articles a ON a.id = p.article_id
  WHERE p.visibility = 'public' AND p.body_mode = 'full'
  ORDER BY p.discovered_at DESC
  LIMIT ${limit}`;

let ok = 0, defect = 0;
for (const row of rows) {
  const v = classifyBodyQuality(row.url, row.body_html ?? "", row.body_text ?? "", { title: row.title });
  if (!apply) {
    if (v.status === "ok") ok++; else { defect++; console.log(`  DRY defect ${row.article_id}: ${v.reasons.join(",")}`); }
    continue;
  }
  await sql.begin(async (tx) => {
    await refreshWorkflowReadinessTx(tx, row.article_id);
    if (v.status === "defect") {
      await tx`UPDATE article_workflow_readiness SET ready=false, body_quality_status='defect',
        body_quality_reasons=${v.reasons}, body_quality_rule_version=${BODY_QUALITY_RULE_VERSION}
        WHERE article_id=${row.article_id}`;
      await tx`INSERT INTO publication_body_repair_log (article_id, event, reasons, rule_version, detail)
        VALUES (${row.article_id}, 'hidden', ${v.reasons}, ${BODY_QUALITY_RULE_VERSION}, ${tx.json({ source: "pre-backfill" })})`;
      defect++;
    } else {
      await tx`UPDATE article_workflow_readiness SET body_quality_status='ok',
        body_quality_reasons='{}', body_quality_rule_version=${BODY_QUALITY_RULE_VERSION}
        WHERE article_id=${row.article_id}`;
      ok++;
    }
  });
}
console.log(`扫描 ${rows.length} 行：ok=${ok} defect=${defect}${apply ? "" : "（dry-run，未写库）"}`);
if (!apply) console.log("确认计数无误后加 --apply --database-url-env=DATABASE_URL 真回填；回填完成再部署新 API/worker。");
await closeDb();
