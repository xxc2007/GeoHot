// 把「信源刚被允许在站内展示全文」这件事落到已经存在的条目上。
//
// 为什么需要它：`publications.body_mode` 是在**投影那一刻**由 `bodyModeOf(source, body_status, hasBody)`
// 定下来的（`packages/backend/src/publication/rules.ts`）。所以只把 `sources.site_fulltext` 改成 true，
// 老行不会自己变——读者看到的还是「摘要 + 打开原文」。2026-10-16 这一轮把 260 道「feed 自己就把全文
// 交给我们」的门开成 true（要的是 AIHOT 那个形状：AI 导读 + 正文，英文条目还要有中文译文），
// 没有本脚本，条目页要等一条**新**消息才拿得到正文。
//
// 跑法（默认 DRY-RUN，一行都不写）：
//   node --env-file=.env scripts/republish-fulltext.ts                     # 看有多少行会翻、抽样列几条
//   node --env-file=.env scripts/republish-fulltext.ts --apply --database-url-env=DATABASE_URL --days=3
// 参数：--days=N 只处理 N 天内发现的（默认 30，越大越久）；--limit=N 封顶；--selected-only 只挑精选；
//       --pace=MS 每 200 条歇这么多毫秒（默认 4,000——这台机器只有 240 IOPS 的盘，读者面优先）。
//
// 不花模型额度：`publishArticle` 只是从 analyses 重算投影并 upsert publications，不调用任何门。
// 可重跑：判据本身就是「现在还是 summary、而按规则该是 full」，翻完的行第二次不再命中。
// 停得下来：worker 在部署时会 abort，本脚本看到 shutdownSignal 就收手，剩下的下一次跑完。
import process from "node:process";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { publishArticle } from "@aihot/backend/publication/publish";
import { shutdownSignal } from "@aihot/backend/jobs/queue";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const selectedOnly = args.includes("--selected-only");
const num = (name: string, dflt: number) => Number(args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? dflt);
const days = num("--days", 30);
const limit = num("--limit", 0);
const pace = num("--pace", 4_000);

if (apply) {
  // 与 sync-source-config.ts 同一条规矩：写库要显式点名库，而且点名的必须就是进程环境连的那个。
  // 地址本身不许上命令行（会进同机任何用户的 ps），所以只接受 --database-url-env=DATABASE_URL。
  const envFlag = args.find((a) => a.startsWith("--database-url-env="))?.slice("--database-url-env=".length);
  if (envFlag !== "DATABASE_URL") {
    console.error("--apply 必须同时给 --database-url-env=DATABASE_URL（别把带口令的 DSN 放上命令行）");
    process.exit(2);
  }
} else {
  console.log(`DRY-RUN：只数不改。要真的重投影请加 --apply --database-url-env=DATABASE_URL`);
}
if (!config.databaseUrl) {
  console.error("没有 DATABASE_URL，本脚本连不上库");
  process.exit(2);
}

// 「会翻成 full」的判据 = rules.ts 里 bodyModeOf 为 full 的全部条件，一条都不自己发明：
// 信源许可 + 正文已确认抓到 + 确实有正文 + 这一行现在还是 summary。
// selected-only 用 `($1 OR p.selected)` 的布尔参数表达，不拼字符串——拼出来的 SQL 没法类型检查，
// 而这个脚本要写 3 万行投影，写错谓词的代价是读者面少一片正文或多一片不该有的正文。
const wouldFlip = () => sql`
  s.site_fulltext AND a.body_status = 'ok' AND a.body_text IS NOT NULL AND length(a.body_text) > 0
  AND p.body_mode = 'summary' AND p.visibility = 'public'
  AND p.discovered_at > now() - ${days} * interval '1 day'
  AND (${!selectedOnly} OR p.selected)`;

const [{ total }] = await sql<{ total: string }[]>`
  SELECT count(*) AS total
  FROM publications p
  JOIN articles a ON a.id = p.article_id
  JOIN sources s ON s.id = p.source_id
  WHERE ${wouldFlip()}`;
const target = Number(total);
console.log(`范围内会翻成 full 的公开投影：${target} 行（days=${days}${selectedOnly ? ", selected-only" : ""}）`);

// 抽样给眼睛看：DRY-RUN 的价值就是能在按下 --apply 之前发现"这根本不是我以为的那批行"。
const sample = await sql<{ article_id: string; source: string; title: string; chars: number }[]>`
  SELECT p.article_id, s.name AS source, p.title, length(a.body_text) AS chars
  FROM publications p
  JOIN articles a ON a.id = p.article_id
  JOIN sources s ON s.id = p.source_id
  WHERE ${wouldFlip()}
  ORDER BY length(a.body_text) DESC LIMIT 5`;
for (const r of sample) console.log(`  · ${r.source}｜${String(r.title).slice(0, 40)}｜正文 ${r.chars} 字`);

if (!apply) {
  console.log("DRY-RUN 结束（上面是样本，没有写库）");
  await closeDb();
} else {
  let done = 0, changed = 0, errors = 0;
  let after = "";
  const cap = limit > 0 ? Math.min(limit, target) : target;
  for (;;) {
    if (shutdownSignal.signal.aborted) { console.log(`收到停止信号，已处理 ${done}/${cap}，剩下的下次继续`); break; }
    if (done >= cap) break;
    const batch = await sql<{ article_id: string }[]>`
      SELECT p.article_id FROM publications p
      JOIN articles a ON a.id = p.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE ${wouldFlip()} AND p.article_id > ${after}
      ORDER BY p.article_id LIMIT 200`;
    if (batch.length === 0) break;
    for (const row of batch) {
      after = row.article_id;
      try {
        const r = await publishArticle(row.article_id);
        if (r?.changed) changed += 1;
      } catch (error) {
        errors += 1;
        if (errors <= 3) console.error(`  ! ${row.article_id}: ${(error as Error).message.slice(0, 120)}`);
      }
      done += 1;
    }
    if (done % 1000 < 200) console.log(`  进度 ${done}/${cap}（改${changed} 错${errors}）`);
    await new Promise((r) => setTimeout(r, pace));   // 让读者面先走完它排着的请求
  }
  console.log(`已重投影 ${done} 行：body_mode 真的变了 ${changed} 行，失败 ${errors} 行。`);
  console.log("英文条目接下来由 translatePending（每几分钟一跑）补中文译文；它只挑三天内发现的条目，更早的会一直显示原文。");
  await closeDb();
}
