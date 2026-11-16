// 把「备用池」补成真正的一千条：站点里 2000 条信源有 1000 条 enabled=false，
// 但 `/admin/sources` 的「备用」读的是 source_reserves 表，而这张表只登记过 330 条，
// 于是页面上明明写着「备用 1000」却显示 330。这个工具把没有 reserve 行的停用信源
// 逐条探测一次（复用采集器自己的解析器），把证据写进 source_reserves。
//
// 用法（要能连到生产库的机器）：
//   node tooling/backfill-reserves.ts --limit 50 --dry
//   node tooling/backfill-reserves.ts --limit 800 --concurrency 3
//
// 失败的信源也照样登记（eligible=false + validation.error），这样「备用」是「池子里有多少条备着」，
// 「最近验证可用」才是「其中验证通过的」。两者分开，页面才说得清。
import process from "node:process";
import { sql, closeDb } from "@aihot/backend/db";
import { validateReserve } from "@aihot/backend/sources/reserves";
import type { SourceRow } from "@aihot/backend/sources/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const limit = value("limit", 200);
const concurrency = value("concurrency", 3);
const dry = flag("dry");

type Row = SourceRow & { id: string; name: string };

// 生产库在慢盘上偶尔连不上（connect timeout），这不是致命错误：等一会儿再来。
async function withRetry<T>(work: () => Promise<T>, tries = 8, waitMs = 20_000): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= tries) throw error;
      console.log(`  连接不上（第 ${attempt} 次）：${(error as Error).message}，${waitMs / 1000} 秒后再试`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const pending = await withRetry(() => sql<Row[]>`
  SELECT s.* FROM sources s
  LEFT JOIN source_reserves r ON r.source_id = s.id
  WHERE NOT s.enabled
    AND r.source_id IS NULL
    AND s.kind IN ('rss', 'json_list')
    AND NOT EXISTS (SELECT 1 FROM source_retirements t WHERE t.source_id = s.id)
  ORDER BY s.last_ok_at DESC NULLS LAST, s.id
  LIMIT ${limit}
`);

console.log(`待登记 ${pending.length} 条（上限 ${limit}，并发 ${concurrency}${dry ? "，演练" : ""}）`);

let ok = 0;
let bad = 0;
let done = 0;

async function one(source: Row): Promise<void> {
  try {
    const evidence = await validateReserve(source);
    ok += 1;
    if (!dry) {
      await sql`
        INSERT INTO source_reserves (source_id, validated_at, validation, eligible, next_check_at)
        VALUES (${source.id}, now(), ${sql.json(evidence)}, true, now() + interval '3 days')
        ON CONFLICT (source_id) DO NOTHING
      `;
    }
  } catch (error) {
    bad += 1;
    if (!dry) {
      await sql`
        INSERT INTO source_reserves (source_id, validated_at, validation, eligible, next_check_at)
        VALUES (${source.id}, now(), ${sql.json({ error: String((error as Error)?.message ?? error) })}, false, now() + interval '1 day')
        ON CONFLICT (source_id) DO NOTHING
      `;
    }
  } finally {
    done += 1;
    if (done % 25 === 0) console.log(`  进度 ${done}/${pending.length}（可用 ${ok}，不可用 ${bad}）`);
  }
}

for (let i = 0; i < pending.length; i += concurrency) {
  await Promise.all(pending.slice(i, i + concurrency).map(one));
}

const [totals] = await sql<{ reserves: number; eligible: number; enabled: number; total: number }[]>`
  SELECT
    (SELECT count(*)::int FROM source_reserves) AS reserves,
    (SELECT count(*)::int FROM source_reserves WHERE eligible) AS eligible,
    (SELECT count(*)::int FROM sources WHERE enabled) AS enabled,
    (SELECT count(*)::int FROM sources) AS total
`;

console.log(
  `结果：本轮可用 ${ok} / 不可用 ${bad}；现在 备用 ${totals.reserves}（其中验证可用 ${totals.eligible}）、正式 ${totals.enabled}、全部 ${totals.total}`,
);

await closeDb();
