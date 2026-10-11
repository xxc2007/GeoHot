// Read-only coverage ledger. Counts are observations, never claims of exhaustive coverage.
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { REPO_ROOT } from "@aihot/backend/config";

const { values } = parseArgs({ options: {
  from: { type: "string", default: "2026-01-01" },
  to: { type: "string", default: beijingDate(Date.now()) },
  out: { type: "string" },
} });
if (!isValidDate(values.from!) || !isValidDate(values.to!) || values.from! > values.to!) {
  console.error("需要有效且顺序正确的 --from/--to=YYYY-MM-DD");
  process.exit(2);
}
try {
  const newsAdapters: string[] = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/news-archives.json"), "utf8")).archives.map((r: { sourceId: string }) => r.sourceId);
  const start = `${values.from}T00:00:00+08:00`;
  const end = `${values.to}T23:59:59.999+08:00`;
  const sources = await sql`
    SELECT count(*)::int registered, count(*) FILTER (WHERE enabled)::int enabled,
      count(*) FILTER (WHERE enabled AND (config ? 'issn' OR config ? 'archiveIndexUrl' OR id = ANY(${newsAdapters}::text[])))::int archive_capable
    FROM sources`;
  const months = await sql`
    SELECT to_char(a.timeline_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month,
      count(*)::int materials,
      count(*) FILTER(WHERE a.backfill_reason='archive')::int archive_materials,
      count(*) FILTER(WHERE a.processing_state='new' OR (a.processing_state='analyzed' AND p.article_id IS NULL))::int unsettled,
      count(*) FILTER(WHERE a.processing_state='failed')::int failed,
      count(*) FILTER(WHERE a.processing_state='blocked')::int blocked,
      count(*) FILTER(WHERE p.visibility='public')::int projected_public,
      count(*) FILTER(WHERE p.visibility='public' AND p.selected)::int projected_selected
    FROM articles a LEFT JOIN publications p ON p.article_id=a.id
    WHERE a.timeline_at >= ${start}::timestamptz AND a.timeline_at <= ${end}::timestamptz
    GROUP BY 1 ORDER BY 1`;
  const slices = await sql`
    SELECT month,status,count(*)::int slices FROM archive_ingest
    WHERE month >= ${values.from!.slice(0,7)} AND month <= ${values.to!.slice(0,7)} GROUP BY 1,2 ORDER BY 1,2`;
  const reports = await sql`
    SELECT kind,key,issue_no,updated_at FROM reports WHERE key >= ${values.from!.slice(0,4)} ORDER BY kind,key`;
  const unsupported = await sql`
    SELECT id,name,kind FROM sources WHERE enabled AND participation_mode='editorial'
      AND NOT (config ? 'issn' OR config ? 'archiveIndexUrl' OR id = ANY(${newsAdapters}::text[])) ORDER BY id`;
  const result = { observedAt: new Date().toISOString(), range: { from: values.from, to: values.to },
    scope: "材料、投影和刊期的数据库观测；无材料月份及无历史入口信源均不代表已完整检索。", sources: sources[0], months, slices, reports, unsupported };
  const json = JSON.stringify(result,null,2) + "\n";
  if (values.out) { mkdirSync(path.dirname(path.resolve(values.out)),{recursive:true}); writeFileSync(values.out,json); }
  console.log(json);
} finally { await closeDb(); }
