// Repair one closed edition per scheduled pass. The ordinary composer owns model budgets,
// receipts, the original date window and report_revisions; never overwrite it with hand-written copy.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { isModelCallsEnabled } from "../config.ts";
import { resourceHeadroom } from "../operations/resource-budget.ts";
import { workflowReadyCondition } from "../publication/readiness.ts";
import { composeDaily, composeMonthly, composeWeekly, reportInput } from "./compose.ts";

const CURSOR = "report_workflow_repair_v1_cursor";
const LEASE = "report_workflow_repair_v1_lease";
type Header = { kind: "daily" | "weekly" | "monthly"; key: string; rank: number };

export async function repairReportWorkflow(target?: Pick<Header,"kind"|"key">) {
  if (!isModelCallsEnabled() || !resourceHeadroom()) return { held: true };
  const token = randomUUID();
  const [lease] = await sql`INSERT INTO settings(key,value) VALUES(${LEASE},${sql.json({ token, until: new Date(Date.now()+3_600_000).toISOString() })})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
    WHERE (settings.value->>'until')::timestamptz < now() RETURNING key`;
  if (!lease) return { held: true };
  try {
    const [saved] = await sql<{value: Header}[]>`SELECT value FROM settings WHERE key=${CURSOR}`;
    const cursor = target ? undefined : saved?.value;
    // Header-only scan; the JSON bodies examined here are stored report citation metadata.
    const headers = await sql<Header[]>`SELECT r.kind,r.key,CASE r.kind WHEN 'monthly' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END AS rank
      FROM reports r WHERE r.window_end<=now()
      ${target ? sql`AND r.kind=${target.kind} AND r.key=${target.key}` : sql``}
      ${cursor ? sql`AND (CASE r.kind WHEN 'monthly' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END > ${cursor.rank}
        OR (r.kind=${cursor.kind} AND r.key<${cursor.key}))` : sql``}
      AND (EXISTS (SELECT 1 FROM settings campaign WHERE campaign.key='report_workflow_repair_v1:'||r.kind||':'||r.key)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.content->'sections',r.content->'themes','[]'::jsonb)) grp
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(grp->'items',grp->'storyRefs','[]'::jsonb)) cited
        LEFT JOIN publications p ON p.article_id=cited->>'itemId'
        WHERE cited->>'itemId' IS NOT NULL AND (p.article_id IS NULL OR NOT (${workflowReadyCondition()}))))
      ORDER BY rank,r.key DESC LIMIT 5`;
    if (!headers.length) { if (!target) await sql`DELETE FROM settings WHERE key=${CURSOR}`; return { wrapped: true }; }
    for (const h of headers) {
      if (!resourceHeadroom()) return { held: true };
      const input = await reportInput(h.kind,h.key);
      const stampKey = `report_workflow_repair_v1:${h.kind}:${h.key}`;
      const [stamp] = await sql<{value:{fingerprint:string}}[]>`SELECT value FROM settings WHERE key=${stampKey}`;
      let outcome = "unchanged";
      if (stamp?.value.fingerprint !== input.fingerprint) {
        // No complete candidates: keep the old edition and await source/workflow recovery.
        if (!input.all.length) outcome = "waiting-for-material";
        else {
          const compose = h.kind === "daily" ? composeDaily : h.kind === "weekly" ? composeWeekly : composeMonthly;
          try {
            const result=await compose(h.key,"workflow-integrity-repair",true);
            outcome=result.entries>0?"recomposed":"waiting-for-material";
          }
          catch (error) {
            // A period waiting for its receipt/budget must not prevent unrelated old editions advancing.
            // Do not stamp its fingerprint: a later cycle can recover the ordinary receipt.
            if (!target) await sql`INSERT INTO settings(key,value) VALUES(${CURSOR},${sql.json(h)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
            throw error;
          }
        }
        await sql`INSERT INTO settings(key,value) VALUES(${stampKey},${sql.json({fingerprint:input.fingerprint,outcome,at:new Date().toISOString()})})
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      }
      if (!target) await sql`INSERT INTO settings(key,value) VALUES(${CURSOR},${sql.json(h)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      if (outcome === "recomposed" || target) return { kind:h.kind,key:h.key,outcome,candidates:input.all.length };
    }
    return { scanned:headers.length };
  } finally { await sql`DELETE FROM settings WHERE key=${LEASE} AND value->>'token'=${token}`; }
}
