// 把「这一版综述是谁写的」从回执搬进 `story_digests.machine_rule`（迁移 0047 加的那一列）。
//
// 为什么要有这一步：`events/digest.ts` 判断"在服务的那一版是不是规则拼的（不是人签的）"时，原先读
// 那笔回执的 `usage.brain.rule`。这让回执表永远不能清理——行一删，读出来就是"不是机器写的"，
// 那条事件便永久停在 `unchanged` 早退（#62 的保留期工单卡在这里六轮）。
//
// **判据只有一个**：本脚本调 `editorial/provenance.ts` 的 `machineRuleOf`，与运行时用的是同一个函数。
// 不在 SQL 里再写一遍"什么叫机器写的"——那种两份判据迟早会分叉。
//
//   先看（默认 dry-run，不写库）：
//     node --env-file-if-exists=.env scripts/backfill-digest-machine-rule.ts
//   写：
//     node --env-file-if-exists=.env scripts/backfill-digest-machine-rule.ts --apply --database-url=postgres://…
//
// 生产上的预期是"0 行要改"：2026-10-06 实测 2901 行 `story_digests` 里带 `rule:` 且无
// fixture/author 的是 0 行。脚本照跑，因为它同时是一份**证据**：哪天有人把早期快照导进来，
// 这一步会把那些行认出来并标上，而不是让它们冒充"人签过"。
import { parseArgs } from "node:util";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { machineRuleOf } from "@aihot/backend/editorial/provenance";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "database-url": { type: "string" },
  },
});
if (values.apply && !values["database-url"]) {
  // 与 set-source-state.ts、restore-body-from-backup.ts、strip-body-boilerplate.ts 同规：
  // 让库从环境变量里被猜出来，正是把 dry-run 变成写库事故的那条路。
  console.error("--apply 必须显式给 --database-url=…");
  process.exit(2);
}
function sameTarget(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
if (values["database-url"] && !sameTarget(values["database-url"], config.databaseUrl)) {
  console.error(`--database-url 指向的库与环境里的 DATABASE_URL 不是同一个：${new URL(values["database-url"]).host}${new URL(values["database-url"]).pathname}`);
  process.exit(2);
}

const rows = await sql<{ story_id: string; version: number; receipt_id: string | null; usage: Record<string, unknown> | null; machine_rule: string | null }[]>`
  SELECT d.story_id, d.version, d.receipt_id, r.usage, d.machine_rule
  FROM story_digests d LEFT JOIN receipts r ON r.id = d.receipt_id
  ORDER BY d.story_id, d.version`;
const changes = rows
  .map((r) => ({ ...r, want: machineRuleOf(r.usage) }))
  .filter((r) => r.want !== r.machine_rule);

const byRule = new Map<string, number>();
for (const c of changes) byRule.set(c.want ?? "(null)", (byRule.get(c.want ?? "(null)") ?? 0) + 1);
const missingReceipt = rows.filter((r) => !r.receipt_id).length;

console.log(`story_digests 共 ${rows.length} 行；要改 ${changes.length} 行（回执已不在的 ${missingReceipt} 行按"没有回执 ⇒ 不是机器写的"处理）`);
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${rule}: ${n} 行`);
for (const c of changes.slice(0, 5)) console.log(`  例：story ${c.story_id} v${c.version}  ${JSON.stringify(c.machine_rule)} → ${JSON.stringify(c.want)}`);

if (!values.apply) {
  console.log("\nDRY-RUN：没有写库。要写加 --apply --database-url=…");
  await closeDb();
  process.exit(0);
}

let written = 0;
await sql.begin(async (tx) => {
  for (const c of changes) {
    const res = await tx`UPDATE story_digests SET machine_rule = ${c.want}
                        WHERE story_id = ${c.story_id} AND version = ${c.version} AND machine_rule IS DISTINCT FROM ${c.want}`;
    written += res.count;
  }
});
console.log(`\n已写入 ${written} 行。核对：SELECT count(*) FROM story_digests WHERE machine_rule IS NOT NULL —— 与上面「要改」的规则行数一致即可。`);
await closeDb();
