// 把已经存进库里的页脚正文洗掉（站长 2026-10-06：他的信息里只留核心内容）。
//
// 为什么要洗存量：这一条规则改的是抽取侧，之前抓回来的东西已经躺在 `articles.body_text` 里了——
// 线上实测最近 400 条 `body_status=ok` 的正文有 96 条以「国家气象中心 版权所有…未经授权禁止下载使用」开头。
// 抽取器不再产出新的页脚正文，但旧的要按同一规则重洗，否则读者还是能在摘要里看到它。
//
// 默认 DRY-RUN，只列候选与预估。`--apply` 才写库：
//   · 剥完还剩 >= 60 字 → 存清洗后的正文，`body_html` 用同一份规则就地清洗（第三十三轮起不再整块丢掉：
//     读者看到的是 HTML，洗不干净它，「只留核心内容」就没有兑现）
//   · 剥完不够 60 字 → 这条当时根本没抽到正文：`body_text=NULL`、`body_status='pending'`，
//     让内容任务按修好的抽取规则重抓一次（中央气象台的预警页正文是 177 字的「防御指南」，
//     旧门槛 200 字把它挡在外面，才导致兜底把页脚当正文带了回来）
// 两种都会 `revision + 1` 并重排分析——正文变了才是真新请求（`receipts` 按 logical_key 缓存，
// 不改 revision 的重跑只会拿回同一个答案）。**生产是付费模型，每条重跑约 5 次调用**，所以脚本
// 打印条数与预估调用数，并拒绝一次洗超过 `--max-apply` 条（默认 200）。只是洗文本、不想要模型
// 重跑时加 `--no-requeue`（清洗页面外壳用这个：正文本来就是中文，摘要不受影响）。
//
// 跑法：DATABASE_URL=postgres://… node scripts/strip-body-boilerplate.ts                       # 看候选
//       node scripts/strip-body-boilerplate.ts --apply --database-url=postgres://…              # 洗（含重排）
//       … --apply --database-url=… --max-apply 500 --no-requeue                                 # 只洗库不重跑
//       node scripts/strip-body-boilerplate.ts --chrome                                          # 看记录页外壳候选
//       … --chrome --apply --database-url=… --max-apply 400                                      # 洗记录页外壳（不重排）
import { parseArgs } from "node:util";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "@aihot/backend/content/materials";
import { dropRecordPageChrome, stripChromeHtml } from "@aihot/backend/content/sanitize";
import { isBoilerplateBody, stripBoilerplate } from "@aihot/backend/lib/text";
import { closeDb, sql } from "@aihot/backend/db";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    chrome: { type: "boolean", default: false },
    "max-apply": { type: "string", default: "200" },
    limit: { type: "string", default: "2000" },
    "no-requeue": { type: "boolean", default: false },
    "database-url": { type: "string" },
  },
});
if (values.apply && !values["database-url"]) {
  // 从环境变量里猜库，正是把 dry-run 变成写库事故的路径（与 set-source-state.ts、restore-body-from-backup.ts 同规）。
  console.error("--apply 必须显式给 --database-url=…");
  process.exit(2);
}

/** 这两个地址指的是同一个库吗？只比 主机:端口/库名——不打印口令。 */
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
  // 连接走的是 backend 的池（环境变量），所以这个参数必须与它一致，否则「指名的库」是句空话。
  console.error(`--database-url 指向的库与环境里的 DATABASE_URL 不是同一个：${new URL(values["database-url"]).host}${new URL(values["database-url"]).pathname}`);
  process.exit(2);
}

// `Number("3O0")` 是 NaN，而 `candidates.length > NaN` 恒为 false —— 打字错误会把写入上限变成"没有上限"，
// 一次洗完全库（每条约 5 次付费调用）。与 close-open-ended-summaries.ts 同规：先验成正整数再往下走。
function positiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    console.error(`--${name} 要是 ≥1 的整数，收到的是「${raw}」`);
    process.exit(2);
  }
  return n;
}
const limit = positiveInt(values.limit!, "limit");
const maxApply = positiveInt(values["max-apply"]!, "max-apply");
// `--chrome` 是同一套安全壳下的另一种洗法：不碰中文页脚，只洗「期刊把整张记录页塞进 feed」带回来的
// 英文页面外壳（评审图例、订阅按钮、日期行、重复四遍的作者名单）。抽取侧已在第一百零三轮修好，
// 这里洗的是它修之前存进库的那 336 条（实测全部在 45 天内，更早的没有这种正文）。
const chrome = values.chrome === true;
const rows = chrome
  ? await sql<{ id: string; title: string; source_id: string; body_text: string; body_html: string | null; revision: number }[]>`
      SELECT id, title, source_id, body_text, body_html, revision
      FROM articles
      WHERE body_status = 'ok' AND body_html IS NOT NULL
        AND body_html ~* '(Comment types|Report abuse|graphic_rss_feed_button|rss[0-9_]*\\.xml|Metrics will be available|Article metrics|Discussion started|Latest update|Status</strong>)'
      ORDER BY discovered_at DESC LIMIT ${limit}`
  : await sql<{ id: string; title: string; source_id: string; body_text: string; body_html: string | null; revision: number }[]>`
      SELECT id, title, source_id, body_text, body_html, revision
      FROM articles
      WHERE body_status = 'ok' AND body_text IS NOT NULL AND length(body_text) BETWEEN 20 AND 6000
        AND (body_text ~ '版权所有|Copyright|未经授权禁止|凡本网注明|ICP备|违法和不良信息举报'
          OR body_text ~ '免责声明|转载请注明出处|技术支持[：:]'
          OR body_text ~ '大字体|【(?:编辑|责编|排版|校对)[：:]|责任编辑[：:]|[（(]完[)）]$'
          OR body_text ~ '^[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日[^。]{0,20}来源[：:]')
      ORDER BY discovered_at DESC LIMIT ${limit}`;

// 每一行先算一次清洗结果，`lost` 必须看清洗后的文本：第三十三轮之前这里写的是 `isBoilerplateBody(r.clean)`，
// 而 `r` 是查出来的原始行、根本没有 `clean` 字段——undefined 传进去一律判成「没正文可留」，于是 2026-10-06
// 03:09 那一次把 1002 条有正文的条目清成了 `body_text=NULL, body_status='pending'`（其中 986 条是中央气象台
// 预警）。`scripts/` 不在 `npm run typecheck` 的范围里，所以类型没报错。用 --restore-from 那份备份回滚。
const candidates = rows
  .map((r) => {
    if (chrome) {
      // 文本侧不动：实测这批行的 `body_text` 本来就没有外壳（外壳在属性与图片里），改了它反而会牵动摘要。
      const htmlOut = dropRecordPageChrome(r.body_html!);
      return { ...r, clean: r.body_text, lost: false, htmlOut, changed: htmlOut !== r.body_html };
    }
    const clean = stripBoilerplate(r.body_text);
    return { ...r, clean, lost: isBoilerplateBody(clean), htmlOut: r.body_html ? stripChromeHtml(r.body_html) : null, changed: true };
  })
  .filter((r) => (chrome ? r.changed && !r.lost : r.clean.replace(/\s+/g, "").length !== r.body_text.replace(/\s+/g, "").length));

const emptied = candidates.filter((r) => r.lost).length;
const shedChars = candidates.reduce((n, r) => n + Math.max(0, (r.body_html?.length ?? 0) - (r.htmlOut?.length ?? 0)), 0);
console.log(`${chrome ? "记录页外壳" : "页脚话术"}候选 ${candidates.length} 条（清洗后没有正文可留的 ${emptied} 条），扫描上限 ${limit}${chrome ? `，去掉 ${shedChars.toLocaleString()} 个字符的外壳` : ""}`);
const bySource: Record<string, number> = {};
for (const c of candidates) bySource[c.source_id] = (bySource[c.source_id] ?? 0) + 1;
for (const [id, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${id}: ${n} 条`);
for (const c of candidates.slice(0, 3)) {
  if (chrome) {
    // 这一路 body_text 一字不动，所以例子只能看 HTML：洗掉的是段落，不是句子。
    console.log(`\n例：${c.title.slice(0, 24)}\n  HTML ${(c.body_html?.length ?? 0).toLocaleString()} → ${(c.htmlOut?.length ?? 0).toLocaleString()} 字符（文本不变）`);
    continue;
  }
  console.log(`\n例：${c.title.slice(0, 24)}\n  原  ${JSON.stringify(c.body_text.slice(0, 90))}\n  洗后 ${JSON.stringify(c.clean.slice(0, 90) || "（空）")}`);
}

if (!values.apply) {
  console.log(`\nDRY-RUN：没有写库。要洗 ${candidates.length} 条。${chrome ? "记录页外壳只动 HTML，不重排分析（译文会按新 revision 自动重翻）。" : `重排分析约 ${candidates.length * 5} 次模型调用。`}`);
  await closeDb();
  process.exit(0);
}
if (candidates.length > maxApply) {
  console.log(`\n拒绝：一次洗 ${candidates.length} 条超过 --max-apply ${maxApply}。分批来（付费模型，每条约 5 次调用）。`);
  await closeDb();
  process.exit(1);
}

// 备份文件名精确到秒：只到分钟时，同一分钟里跑第二次会把记录**追加**进同一个文件，
// 而还原脚本按行序回放、后写的覆盖先写的——第二次跑会把"已经洗过的文本"当成旧值还原回去。
const backup = path.join(config.dataDir, `boilerplate-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`);
let done = 0;
for (const c of candidates) {
  // One record per line, terminated: the file is advertised as `.jsonl`, and without the newline the whole
  // run lands as a single multi-megabyte line that no JSONL reader can replay (the 2026-10-06 03:09 backup did).
  appendFileSync(backup, `${JSON.stringify({ id: c.id, revision: c.revision, body_text: c.body_text, body_html: c.body_html })}\n`);
  const body = c.lost ? null : c.clean;
  const html = c.lost ? null : c.htmlOut;
  await sql`
    UPDATE articles
    SET body_text = ${body}, body_html = ${html}, body_status = ${c.lost ? "pending" : "ok"},
        revision = revision + 1,
        content_hash = ${contentHash({ title: c.title, bodyText: body, excerpt: null })},
        updated_at = now()
    WHERE id = ${c.id}`;
  // 记录页外壳这一路**不重排分析**：改的只是英文 HTML，喂模型的文本一个字符没动，重排要把每条 5 次付费
  // 调用再花一遍，换回来的还是同一份摘要。`--no-requeue` 是给这种情形准备的，但 336 条 × 5 次的坑不该留给
  // 一个忘带的参数，所以这里按模式写死。
  if (!chrome && !values["no-requeue"]) await queueProcessing(c.id, { attemptTag: "boilerplate-strip" });
  done++;
}
console.log(`\n已洗 ${done} 条；旧值备份在 ${backup}。${chrome ? "未重排分析；正文变了，中文译文会由 content.translate 这一腿按新 revision 自动重翻。" : values["no-requeue"] ? "未重排分析。" : "已重排分析，worker 会按预算逐条重跑。"}`);
// 正文变了，publication 里派生出来的 `body_mode`/`search_text` 就旧了——重算不花模型额度，交给 worker 排队做。
for (const sourceId of Object.keys(bySource)) {
  await enqueue(QUEUES.republishSource, { sourceId }, { singletonKey: sourceId });
  console.log(`  已排重算 publication：${sourceId}`);
}
await stopBoss();
await closeDb();
