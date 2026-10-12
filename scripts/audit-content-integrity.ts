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
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { isDay } from "@aihot/contracts/time";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { editionDay } from "@aihot/backend/lib/time";
import { candidates, dailyWindow } from "@aihot/backend/reports/compose";
import { settledDays } from "./lib/settled-days.ts";

/** 日报期次所服务的那一天——公式只在 `lib/time.ts` 写一次，这里只固定"时刻是 `p.timeline_at`"。 */
const DAY_LABEL = editionDay(sql`p.timeline_at`);

interface Check {
  name: string;
  hard: boolean;
  why: string;
  value: () => Promise<number>;
}

function checks(from: string, to: string): Check[] {
  // 区间按**期次日期**判，不按裸时刻判：一期日报覆盖 `[D-1 08:00, D 08:00)` 北京时间，
  // 而 `timeline_at >= '2026-01-01'` 这种写法把 1 月 1 日那一期窗口的前 8 小时（12-31 08:00 起）切掉了——
  // 同一个错法在进度脚本里造出一个假的 days_settled=1。两端都含，与下面按 `key` 数期次那两项同一口径。
  const inRange = sql`${DAY_LABEL} BETWEEN ${from}::date AND ${to}::date`;
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
          AND p.title ~ ${CJK_COPY_PATTERN} AND coalesce(p.summary, '') !~ ${CJK_COPY_PATTERN}`),
    },
    {
      name: "selected_without_cjk_title",
      hard: false,
      why: "纯英文标题却被判为精选：读者面被标题闸门挡住，不算违规，但数量暴涨说明精选口径漂了",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM publications p
        WHERE p.visibility = 'public' AND p.selected AND ${inRange} AND p.title !~ ${CJK_COPY_PATTERN}`),
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
      // 只数日报：`reports.key` 是文本，周报的 `2026-W40`、月报的 `2026-09` 与日期的 `2026-10-12`
      // 按字符序落在区间外（`'W' > '1'`），把它们混进同一条比较会得到"周报 0 期"这种假读数。
      name: "editions_stored",
      hard: false,
      why: "区间内已存的日报期次数（周报/月报不在这条里）：排空之后这一格应当接近 283",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM reports
        WHERE kind = 'daily' AND key >= ${from} AND key <= ${to}`),
    },
    {
      // 回填出来的历史期次**按设计不领期号**（compose.ts 只在"比它新的期次已有号"时才发号，
      // 而十月的期号已经发完了）。可是读取层把「无号」一律说成「空刊不占期号」
      // ——见 daily-archive.tsx 的未出刊行与 features/report/format.ts:220 那段注释。
      // 于是几百份真有内容的日报会被读者自述成"那天没出刊"，正好把这次回填反向描述。
      // 这条只做**计数与挂账**（hard: false）：改文案要动的是别人正在编辑的文件，不是这里。
      // 口径按 kind 分叉是必须的：日报的内容在 sections[].items[]，周报月报在 themes[].storyRefs[]
      // （compose.ts:141 与 :247），拿同一把尺子量会把周报整族误判成空刊。
      // 表达式形状实测过：content 顶层有 sections/highlights/flashes/lead/metrics/window{Start,End}，
      // **没有顶层 items**——写成 content->'items' 会每层都走 else 0，变成一条永远绿的假判据。
      name: "backfilled_daily_editions_with_material_but_no_number",
      hard: false,
      why: "日报里有内容却没期号的期数（回填期次应有此数）：读取层若仍说「未出刊」，读者会把它们当成空刊",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM reports r
        WHERE r.kind = 'daily' AND r.key >= ${from} AND r.key <= ${to} AND r.issue_no IS NULL
          AND COALESCE((
                SELECT sum(jsonb_array_length(s->'items'))
                FROM jsonb_array_elements(r.content->'sections') s
                WHERE jsonb_typeof(s->'items') = 'array'), 0) > 0`),
    },
    {
      // 这次任务自己的验收尺子。日子判完了，读者就该看得到它的那份报纸；这天真的没内容也要能说出来
      // （归档那格会把没有期次的日子标成「未出刊」，见 #47/#111 那道读取层闸门）。
      // 「判完 + 没存期次 + `candidates()` 却非零」= 出刊路径漏了一天，不是"那天没内容"。
      // 成本：每个嫌疑日问一次 `candidates()`（它取一次 `report_candidates` **排他**咨询锁，
      // 与发布者争同一把），实测每天 2–3ms：几百个嫌疑日约 1 秒。它不改数据，但会在回填流水线上
      // 插队——所以这一条要么在停 worker 时跑，要么接受那 1 秒里排在锁后面的发布等待。
      // 嫌疑日的个数随排空进度变化（本机开发库实测 182，生产在判完之前是 0），别把任何一次的读数当常数。
      name: "settled_days_unprinted_with_material",
      hard: true,
      why: "已判完、没存日报期次、候选却非零的日子：出刊漏印，归档也不该把它说成「那天没有内容」",
      value: async () => {
        const suspects = await settledDays(sql, from, to, true);
        let n = 0;
        for (const day of suspects) {
          const { start, end } = dailyWindow(day);
          if ((await candidates(start, end)).length > 0) n++;
        }
        return n;
      },
    },
    {
      name: "settled_days",
      hard: false,
      why: "区间内已判完的日子数：这是进度读数不是合格线，回填全部跑完时它应等于「有材料」的日子数",
      value: async () => (await settledDays(sql, from, to)).length,
    },
    {
      // 上面两条都按"有文章的日"聚合出来的行分组：那天一篇材料都没进口，就没有聚合行，于是它既不算
      // 已判完也不算嫌疑。这不是 bug 是口径，但**不报出来的话「嫌疑 0 天」会被读成「区间天天查过、都没问题」**。
      // 三者相加 = 区间天数，这笔账必须能对上（2026-10-12 在生产量到：区间 285 天里 0 天判完、95 个判完日全在区间外）。
      name: "days_without_articles",
      hard: false,
      why: "区间内没有任何文章的日子数：出刊与嫌疑两条都不看这些天，它们是覆盖问题不是出刊问题",
      value: () => one(sql<{ n: number }[]>`
        WITH days AS (SELECT ${editionDay(sql`a.timeline_at`)} AS d FROM articles a)
        SELECT greatest(0, (${to}::date - ${from}::date + 1)
          - count(DISTINCT d) FILTER (WHERE d BETWEEN ${from}::date AND ${to}::date))::int AS n FROM days`),
    },
    {
      // 报纸印的是**存版那一刻的快照**（`compose.ts` 把 title/summary 一起写进 `reports.content`，
      // 读者面逐字印出）。所以"后来把那条英文摘要改好了"不会回头改这份报纸：其余判据全查 `publications`，
      // 于是它们全绿，而 1 月那一期还在印改之前的字。这一条把"存版落后于现文且现文已是中文"单独量出来。
      name: "editions_printing_stale_copy",
      hard: false,
      why: "存版里的标题没有汉字、而这条材料现在的标题是中文：报纸还在印被改之前的那份文字（要重排才修得掉，见 --refresh）",
      value: () => one(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM reports r,
          jsonb_array_elements(coalesce(r.content::jsonb -> 'sections', '[]'::jsonb)) AS s,
          jsonb_array_elements(coalesce(s -> 'items', '[]'::jsonb)) AS it
        WHERE r.kind = 'daily' AND r.key BETWEEN ${from} AND ${to}
          AND coalesce(it ->> 'title', '') <> '' AND it ->> 'title' !~ ${CJK_COPY_PATTERN}
          AND EXISTS (SELECT 1 FROM publications p WHERE p.article_id = it ->> 'itemId' AND p.title ~ ${CJK_COPY_PATTERN})`),
    },
  ];
}

async function main() {
  const { values } = parseArgs({
    options: { from: { type: "string", default: "2026-01-01" }, to: { type: "string", default: "" }, json: { type: "boolean", default: false } },
  });
  const to = values.to || new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  // 形状对却不存在的日期（`2026-02-30`）也要拒绝：它会被 cast 成 3 月 2 日，
  // 于是"审到 2 月 30 日"实际审到 3 月初，报告上写的区间和跑出来的区间不是同一件事。
  if (!isDay(values.from!) || !isDay(to)) {
    console.error(`--from/--to 要 YYYY-MM-DD 且真实存在，收到「${values.from}」/「${to}」`);
    process.exitCode = 2;
    return;
  }
  // 验收工具必须说清它验的是哪个库：这一族缺陷（CI 库的测试夹具报出像模像样的线上读数）
  // 已经让"不带库名的判据"至少两次被拿去当生产结论。口令与参数一律不带。
  const target = new URL(config.databaseUrl);
  console.log(`库 ${target.host}${target.pathname}　区间 ${values.from} … ${to}（按期次日期，两端都含）\n`);
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
