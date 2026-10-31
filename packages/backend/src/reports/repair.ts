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
  // 租约只需盖过一次运行（单期次组稿 ≤ 数分钟）；30 分钟而非 1 小时：SIGKILL/OOM/exit(0) 截断不会走
  // finally 清理（repair.ts 底部），残留租约会让之后每个 :15 tick 静默 {held:true}——30 分钟把崩溃后的
  // 静默窗压回 ≤2 个运行周期，与 2026-10-31 评审 finding「repair 租约无心跳/接管」的结论一致。
  const [lease] = await sql`INSERT INTO settings(key,value) VALUES(${LEASE},${sql.json({ token, until: new Date(Date.now()+1_800_000).toISOString() })})
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
      AND NOT EXISTS (SELECT 1 FROM settings cooling WHERE cooling.key='report_workflow_repair_v1:'||r.kind||':'||r.key
        AND (cooling.value->>'retryAt')::timestamptz>now())
      ${cursor ? sql`AND (CASE r.kind WHEN 'monthly' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END > ${cursor.rank}
        OR (r.kind=${cursor.kind} AND r.key<${cursor.key})
        OR EXISTS (SELECT 1 FROM settings retry WHERE retry.key='report_workflow_repair_v1:'||r.kind||':'||r.key AND (retry.value->>'retryAt')::timestamptz<=now()))` : sql``}
      AND (EXISTS (SELECT 1 FROM settings campaign WHERE campaign.key='report_workflow_repair_v1:'||r.kind||':'||r.key)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.content->'sections',r.content->'themes','[]'::jsonb) || jsonb_build_array(jsonb_build_object('items',coalesce(r.content->'flashes','[]'::jsonb)))) grp
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(grp->'items',grp->'storyRefs','[]'::jsonb)) cited
        LEFT JOIN publications p ON p.article_id=cited->>'itemId'
        WHERE cited->>'itemId' IS NOT NULL AND (p.article_id IS NULL OR NOT (${workflowReadyCondition()}))))
      ORDER BY CASE WHEN EXISTS (SELECT 1 FROM settings retry WHERE retry.key='report_workflow_repair_v1:'||r.kind||':'||r.key AND (retry.value->>'retryAt')::timestamptz<=now()) THEN 0 ELSE 1 END,rank,r.key DESC LIMIT 5`;
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
            await sql`INSERT INTO settings(key,value) VALUES(${stampKey},${sql.json({outcome:"retry-wait",retryAt:new Date(Date.now()+35*60_000).toISOString()})})
              ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
            if (!target) await sql`INSERT INTO settings(key,value) VALUES(${CURSOR},${sql.json(h)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
            throw error;
          }
        }
        // 成功重组也盖一枚 60 分钟冷却（仅定时循环；--kind/--key 的显式定向 repair 是人工动作，不拦）：
        // 引文材料里在途收据的状态会让 fingerprint 每个 tick 都变，没有这枚冷却时，同一期次被连续
        // 重组（实测 W24 在 08:10/09:09/09:54 三连 recompose、candidates 均 74，读者面前同一期次
        // 3 小时换了三个版本）。冷却复用 failure 路径已有的 retry-wait 语义与同一张 settings 行，
        // headers 查询的 NOT EXISTS cooling 对它的让位已有测试覆盖（report-candidates.test.ts）。
        const stamp = outcome === "recomposed" && !target
          ? { fingerprint: input.fingerprint, outcome, at: new Date().toISOString(), retryAt: new Date(Date.now() + 60 * 60_000).toISOString() }
          : { fingerprint: input.fingerprint, outcome, at: new Date().toISOString() };
        await sql`INSERT INTO settings(key,value) VALUES(${stampKey},${sql.json(stamp)})
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      }
      if (!target) await sql`INSERT INTO settings(key,value) VALUES(${CURSOR},${sql.json(h)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
      if (outcome === "recomposed" || target) return { kind:h.kind,key:h.key,outcome,candidates:input.all.length };
    }
    return { scanned:headers.length };
  } finally { await sql`DELETE FROM settings WHERE key=${LEASE} AND value->>'token'=${token}`; }
}
