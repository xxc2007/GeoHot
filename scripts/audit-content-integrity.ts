// 读者面内容完整性的只读审计：给收尾那一次"多智能体验证"一个共同的判据，而不是每个人自己写一遍 SQL。
//
// 为什么要有这个文件：2026-10-12 深夜我手工量过一轮（中文红线、跨天重印、无日期、空白期次），
// 那些判据散在工单文字里；重排之后还要再量一次，而"凭眼看首页"证明不了任何事。判据写在这里，
// 每次出刊/重排之后跑同一条命令，数字自己会说话。
//
// 只读，所以**不需要** `--apply --database-url` 那套护栏（那是给写库脚本的：让库从环境变量里被猜出来，
// 正是把 dry-run 写成事故的路）。这里没有任何一条语句会改数据。
//
// 跑法（在应用目录里，用应用自己的依赖与 .env）：
//   node scripts/audit-content-integrity.ts --from=2026-01-01 --to=2026-10-12
//   … --json            # 给脚本读的输出
// 退出码：有 HARD 项不通过 ⇒ 1。软项只报数，因为它们的"合格线"是编辑判断，不该由代码替站长定。
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";

/**
 * 日报那一期的日期标签：一个北京日 D 覆盖 `[D-1 08:00, D 08:00)`（`reports/compose.ts` 的 `dailyWindow`），
 * 所以日标签 = 时刻折成北京时间后减 8 小时再 +1 天。这条只在这里写一次——用它去猜别的公式会重演
 * "窗口算错 8 小时"那次的错。
 */
export const DAY_LABEL = sql`((p.timeline_at AT TIME ZONE 'Asia/Shanghai') - interval '8 hours')::date + 1`;
/** 中文汉字（含扩展 A 之前的主区块）。标题在这个区间里没字 = 根本没翻成中文。 */
export const CJK = "[一-鿿]";

export interface Check {
  name: string;
  hard: boolean;
  why: string;
  value: () => Promise<number>;
}

export function checks(from: string, to: string): Check[] {
  const inRange = sql`p.timeline_at >= ${from} AND p.timeline_at < ${to}::date + 1`;
  const one = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return [
    {
      // 闸门 `publication/items.ts` 的 chineseCopyCondition 只查标题，不查提要语言（writing.ts 里明写）。
      // 所以"标题中文＋摘要英文"是唯一能穿过闸门、被印进报纸的形状——档案那几千条英文期刊摘要就卡在这条上。
      name: "chinese_title_english_summary",
      hard: true,
      why: "标题有中文而摘要一个汉字都没有：读者闸门只查标题，这一条会直接印进报纸",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM publications p
        WHERE p.visibility = 'public' AND p.eligible AND ${inRange}
          AND p.title ~ ${CJK} AND coalesce(p.summary, '') !~ ${CJK}`),
    },
    {
      name: "selected_without_cjk_title",
      hard: false,
      why: "纯英文标题却被判为精选：读者面被标题闸门挡住，不算违规，但数量暴涨说明精选口径漂了",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM publications p
        WHERE p.visibility = 'public' AND p.selected AND ${inRange} AND p.title !~ ${CJK}`),
    },
    {
      name: "missing_title_or_source",
      hard: true,
      why: "公开行没有标题或没有来源：读者看到的是无法署名的条目",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM publications p
        WHERE p.visibility = 'public' AND ${inRange}
          AND (coalesce(p.title, '') = '' OR coalesce(p.source_id, '') = '')`),
    },
    {
      // `candidates()` 要求档案行必须有 published_at 才进得了报纸，所以非零的这一项是"白判了"而不是"印错"。
      name: "selected_backfill_without_date",
      hard: true,
      why: "档案行被判为精选却没有新闻日期：进不了当日池子，等于白花钱判它",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM publications p
        WHERE p.visibility = 'public' AND p.selected AND p.backfill AND ${inRange}
          AND p.published_at IS NULL`),
    },
    {
      name: "fact_printed_on_multiple_days",
      hard: false,
      why: "同一件事被两天都印：`6320872` 之后新期次不该再有，旧存量看这个数有多大",
      value: () => one(sql<{ n: number }[]>`
        WITH f AS (
          SELECT p.fact_id, count(DISTINCT ${DAY_LABEL}) AS days FROM publications p
          WHERE p.visibility = 'public' AND p.selected AND p.fact_id IS NOT NULL AND ${inRange}
          GROUP BY 1)
        SELECT coalesce(sum(days - 1), 0)::int AS n FROM f WHERE days > 1`),
    },
    {
      name: "blank_editions",
      hard: true,
      why: "存了却既没分节也没快讯的一期：这是缺陷，不是'那天真的没内容'——后者应当显式标注未出刊",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM reports
        WHERE kind = 'daily' AND key >= ${from} AND key <= ${to}
          AND jsonb_array_length(coalesce(content -> 'sections', '[]'::jsonb)) = 0
          AND jsonb_array_length(coalesce(content -> 'flashes', '[]'::jsonb)) = 0`),
    },
    {
      name: "editions_stored",
      hard: false,
      why: "区间内已存的日/周/月期次数：排空之后这一格应当接近 283 / 40 / 10",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM reports
        WHERE kind = 'daily' AND key >= ${from} AND key <= ${to}`),
    },
  ];
}

async function main() {
  const { values } = parseArgs({
    options: { from: { type: "string", default: "2026-01-01" }, to: { type: "string", default: "" }, json: { type: "boolean", default: false } },
  });
  const to = values.to || new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.from!) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error(`--from/--to 要 YYYY-MM-DD，收到「${values.from}」/「${to}」`);
    process.exitCode = 2;
    return;
  }
  const results = [];
  for (const c of checks(values.from!, to)) {
    const n = await c.value();
    results.push({ name: c.name, hard: c.hard, n, why: c.why });
    if (!values.json) {
      const flag = n === 0 ? "ok  " : c.hard ? "FAIL" : "note";
      console.log(`[${flag}] ${c.name} = ${n}　${c.why}`);
    }
  }
  const failed = results.filter((r) => r.hard && r.n > 0);
  if (values.json) console.log(JSON.stringify({ from: values.from, to, results }, null, 2));
  else console.log(`\n${results.length} 项：硬判据不通过 ${failed.length} 项${failed.length ? `（${failed.map((f) => f.name).join(", ")}）` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } finally { await closeDb(); }
}
