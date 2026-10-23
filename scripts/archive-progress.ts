// 档案回填进度的只读遥测：一条命令读出"还剩多少、在跑多快、什么时候完"，退出码恒为 0。
//
// 为什么不塞进 `audit-content-integrity.ts`：那个脚本是**断言**（不合格 exit 1），这个是**读数**（永远 0）。
// 混在一起，迟早会因为"只想看一眼进度"而拿到非零退出码，或反过来把一次进度采样当成验收通过。
//
// 为什么值得单独写：这一晚"还剩多少条、要多久"被手写了四遍，四遍口径都不一样（30/时、26–31 天、42 小时、
// 两阶段），错处集中在同三个地方：
//   · 拿 `articles.updated_at` 量进度——预算退避（`jobs/content.ts` 的 waiting 分支）和发布投影都会改它，
//     数出来的是"被碰过的行"，不是"判完的行"；
//   · 拿 `receipts.subject` 直接 join `articles.id`——`subject` 的形状是 `article:<id>@<revision>`，
//     不先剥前缀与 @ 后缀会一行都匹配不上，于是"今天所有调用都是 live"那种假结论就这么来了；
//   · 日标签只按 `timeline_at >= from` 截——一期日报覆盖 `[D-1 08:00, D 08:00)` 北京时间，少了那个 -8h
//     就会把窗口头一天判成"已结算"（实测真的得到一个假的 days_settled=1）。
// 三条都在这里只写一次，之后每轮只跑这一条命令。
//
// 跑法：node scripts/archive-progress.ts [--from=2026-01-01] [--json]
// 只读：全文没有任何 UPDATE/INSERT/DELETE。
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { unbilledAttempt } from "@aihot/backend/providers/receipts";
import { editionDay } from "@aihot/backend/lib/time";
import { archiveDoorFilter } from "@aihot/backend/sources/archive-site";
import { isDay } from "@aihot/contracts/time";

/** 片段类型直接取本文件构造出来的那一个：nesting 用的就是它，不去猜 postgres 的内部类型名。 */
const COLUMN = sql`a.timeline_at`;
/** `article:<id>@<revision>` ⇒ 取 `:` 之后第一段，再砍掉 `@` 尾巴。 */
export function subjectArticle(subject: typeof COLUMN) {
  return sql`split_part(split_part(${subject}, ':', 2), '@', 1)`;
}

async function main() {
  const { values } = parseArgs({ options: { from: { type: "string", default: "2026-01-01" }, json: { type: "boolean", default: false } } });
  // `--from` 会被拿去和 `timestamptz` 比、也会被 `substring(… from 1 for 7)` 当月份窗口用。
  // 打错一个字符（`2026-1-1`、`2026-13-01`）不会报错，只会让每条查询各自数到一个空集合，
  // 于是"还剩 0 条、0 天有材料"看起来像排空了。这一族与 `dates.ts` 不猜日期顺序是同一个规矩。
  if (!isDay(values.from!)) {
    console.error(`--from 要的是 YYYY-MM-DD 且真实存在的日期，收到的是「${values.from}」`);
    process.exit(2);
  }
  const from = values.from!;
  // 打出来自哪个库（只到 主机/库名，口令与参数一律不带）：这次试跑连到 CI 库，
  // 却照样报出一个像模像样的"17.2 篇/时"——那 222 篇是测试夹具留下的 origin='live' 收据。
  // 读数工具不标库，就会被拿去做判断。
  const target = new URL(config.databaseUrl);
  const dbLabel = `${target.host}${target.pathname}`;

  // 判定进度只认 processing_state。
  const [q] = await sql<{ arch_open: number; all_open: number; arch_done: number }[]>`
    SELECT count(*) FILTER (WHERE a.processing_state = 'new' AND a.backfill_reason = 'archive')::int AS arch_open,
           count(*) FILTER (WHERE a.processing_state = 'new')::int AS all_open,
           count(*) FILTER (WHERE a.processing_state = 'analyzed' AND a.backfill_reason = 'archive')::int AS arch_done
    FROM articles a WHERE a.timeline_at >= ${from}`;

  // 采集期：pending 不归零，进口就一直往队列里加东西——所以剩下的时间必须分两段说。
  // 月份窗口要与 `archive-cycle.sh` 的成熟度判据同一个口径（>= from 的月、< 当月）：
  // 这里第一次跑时没带月份条件，读出 pending=164，而闸门看到的是 74——两个数同时挂在屏幕上，
  // 迟早会有人拿其中一个去推翻另一个的结论。`pending_any` 保留全景，只做参照。
  // `done` 也必须带同一个窗口：pending 数的是"这个窗口里还没跑完的"，而它数的是"所有月份跑完的"，
  // 两行并排打出来就成了"pending 74 / done 775"，看着像窗口快排空了，实际是两个不相干的集合。
  const [c] = await sql<{ pending: number; done: number; pending_any: number }[]>`
    SELECT count(*) FILTER (WHERE ai.status IN ('pending','running')
             AND ai.month >= substring(${from} from 1 for 7)
             AND ai.month < to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'))::int AS pending,
           count(*) FILTER (WHERE ai.status = 'done'
             AND ai.month >= substring(${from} from 1 for 7)
             AND ai.month < to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'))::int AS done,
           count(*) FILTER (WHERE ai.status IN ('pending','running'))::int AS pending_any
    FROM archive_ingest ai JOIN sources s ON s.id = ai.source_id
    WHERE ${archiveDoorFilter(sql`s`)}`;

  // 吞吐按近 12 小时发起且有已计费或可能计费尝试的逻辑收据估计；未知不表示已产出判断。
  // `origin='live'` 排除回放与导入。费用判据仍来自 attempts，不能从 receipt 的执行状态推断。
  // 这里按逻辑请求去重（可能重试多次），不能当预算使用次数读。
  // `arch_scored` 只认 join 得上 `articles` 的行：主体被删过的收据 left join 出来是 NULL，
  // 会算进 `scored` 而不算进 `arch_scored`。两个数之差就是"认不出条目的调用"，不是"没在判档案"。
  const [t] = await sql<{ prefiltered: number; scored: number; arch_scored: number; billed: number }[]>`
    WITH art AS (
      SELECT ${subjectArticle(sql`r.subject`)} AS id, r.purpose,
             (a.backfill_reason = 'archive') AS is_archive
      FROM receipts r LEFT JOIN articles a ON a.id = ${subjectArticle(sql`r.subject`)}
      WHERE r.origin = 'live' AND r.service <> 'embedding' AND r.subject LIKE 'article:%'
        AND r.created_at > now() - interval '12 hours'
        AND EXISTS (SELECT 1 FROM receipt_attempts WHERE receipt_id = r.id AND NOT ${unbilledAttempt()}))
    SELECT count(DISTINCT id) FILTER (WHERE purpose = 'prefilter_article')::int AS prefiltered,
           count(DISTINCT id) FILTER (WHERE purpose = 'score_article')::int AS scored,
           count(DISTINCT id) FILTER (WHERE purpose = 'score_article' AND is_archive)::int AS arch_scored,
           count(*)::int AS billed FROM art`;

  // 已结算的日子，照 `backfill-papers.ts` 的 unsettled() 定义：窗口内**全部**条目，不分 backfill_reason，
  // `blocked`/`failed` 不挡日，`analyzed` 还要有 publications 行才算过。
  const [d] = await sql<{ with_material: number; settled: number }[]>`
    WITH per_day AS (
      SELECT ${editionDay(sql`a.timeline_at`)} AS day,
             count(*) FILTER (WHERE a.processing_state = 'new'
               OR (a.processing_state = 'analyzed' AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = a.id))) AS unsettled
      FROM articles a WHERE a.timeline_at >= ${from} GROUP BY 1)
    SELECT count(*)::int AS with_material, count(*) FILTER (WHERE unsettled = 0)::int AS settled FROM per_day`;

  // 空白期次要按 kind 判：日报放 `sections` + `flashes`，周报/月报放 `themes`（生产实测三种 kind 的
  // content 顶层键各自不同）。拿日报的判据去数周报，会把 2 期周报、1 期月报全报成"空白"——
  // 第一次跑就犯了这个错，所以两种形状都在这里各写一次，而不是外面再传一个"哪个字段算内容"。
  const ed = await sql<{ kind: string; n: number; blank: number }[]>`
    SELECT kind, count(*)::int AS n,
      count(*) FILTER (WHERE (kind = 'daily'
          AND jsonb_array_length(coalesce(content->'sections','[]'::jsonb)) = 0
          AND jsonb_array_length(coalesce(content->'flashes','[]'::jsonb)) = 0)
        OR (kind IN ('weekly','monthly')
          AND jsonb_array_length(coalesce(content->'themes','[]'::jsonb)) = 0))::int AS blank
    FROM reports GROUP BY 1 ORDER BY 1`;

  const scoredPerHour = Number(t?.scored ?? 0) / 12;
  const out = {
    database: dbLabel,
    queue: { archive_unjudged: q?.arch_open ?? 0, all_unjudged: q?.all_open ?? 0, archive_judged: q?.arch_done ?? 0 },
    collection: { slices_pending: c?.pending ?? 0, slices_done: c?.done ?? 0, slices_pending_all_months: c?.pending_any ?? 0 },
    last_12h: { billed_calls: t?.billed ?? 0, items_prefiltered: t?.prefiltered ?? 0, items_scored: t?.scored ?? 0, archive_scored: t?.arch_scored ?? 0 },
    days: { with_material: d?.with_material ?? 0, settled: d?.settled ?? 0 },
    editions: Object.fromEntries(ed.map((x) => [x.kind, { stored: x.n, blank: x.blank }])),
    rate: { scored_per_hour: Number(scoredPerHour.toFixed(1)) },
  };
  if (values.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`库      ${out.database}
`);
    console.log(`队列    档案待判 ${out.queue.archive_unjudged}　全部待判 ${out.queue.all_unjudged}　档案已判完 ${out.queue.archive_judged}`);
    console.log(`采集    窗口内 pending ${out.collection.slices_pending}　窗口内 done ${out.collection.slices_done}（闸门同窗口：>= ${from.slice(0, 7)} 的月、不含当月）　全部月份 pending ${out.collection.slices_pending_all_months}`);
    console.log(`近12h   计费 ${out.last_12h.billed_calls} 次　预筛 ${out.last_12h.items_prefiltered} 篇　打分 ${out.last_12h.items_scored} 篇（其中档案 ${out.last_12h.archive_scored}）⇒ ${out.rate.scored_per_hour}/时`);
    console.log(`日子    有材料 ${out.days.with_material} 天　已结算 ${out.days.settled} 天`);
    for (const [kind, v] of Object.entries(out.editions)) console.log(`期次    ${kind}：存 ${v.stored}　空白 ${v.blank}`);
    console.log(`说明    剩余时长 = 采集尾段 + 队列/斜率；斜率只取这 12 小时样本，别单独拿它报 ETA。`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } finally { await closeDb(); }
}
