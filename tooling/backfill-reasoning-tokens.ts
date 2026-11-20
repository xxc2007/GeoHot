// 一次性回填：把历史回执 usage 里的 reasoning tokens 派生到 admin_model_attempt_metrics。
// 红线：只写派生读模型，不回写 receipts/receipt_attempts，不改账单/预算/价卡；
//       reasoning 仅展示口径，若 completion_tokens 已含 reasoning，成本不叠加、不重复计费。
//
// 幂等：只补 tokens_reasoning IS NULL 的行；缺字段的行保持 NULL，不计 0。
// 用法（能连到目标库的机器）：
//   node tooling/backfill-reasoning-tokens.ts --dry
//   node tooling/backfill-reasoning-tokens.ts --batch 500
import process from "node:process";
import { sql, closeDb } from "@aihot/backend/db";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const batchSize = value("batch", 500);
const dry = flag("dry");

async function main() {
  let updated = 0;
  let scanned = 0;
  for (;;) {
    const rows = await sql<{id:string}[]>`
      SELECT m.id FROM admin_model_attempt_metrics m
      JOIN receipt_attempts r ON r.id = m.id
      WHERE m.tokens_reasoning IS NULL
      LIMIT ${batchSize}`;
    const ids = rows.map((r) => r.id);
    if (!ids.length) break;
    scanned += ids.length;
    if (!dry) {
      await sql`
        UPDATE admin_model_attempt_metrics m
        SET tokens_reasoning = admin_metric_reasoning_tokens(r.usage)
        FROM receipt_attempts r
        WHERE m.id = r.id AND m.id = ANY(${ids})`;
    }
    updated += ids.length;
    console.log(`  批次 ${ids.length}（累计 ${updated}）${dry ? "[dry]" : ""}`);
    if (ids.length < batchSize) break;
  }
  console.log(JSON.stringify({ updated, scanned, dry }));
  await closeDb();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
