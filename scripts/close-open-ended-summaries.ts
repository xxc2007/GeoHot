// 把已经存进库里的"半句话摘要"收在一个完整句子上（#130 的存量那一半）。
//
// 为什么存量要单独洗：抽取侧的修复早就落地了——`editorial/writing.ts` 的 `closeTruncatedSentence` 现在会
// 把每一条新摘要收口，所以精选与报纸那层是干净的（2026-10-11 生产实测：693 条 selected 里 0 条结尾挂分隔符）。
// 但修好之前抓回来的东西还躺在 `publications.summary` 里：同一批全库 9,267 条公开行有 1,772 条以「，、；：」
// 结尾、189 条整段没有结尾标点——读者在分类页和条目页会直接看到它们。
//
// 判据只有一个来源：本脚本调 `closeTruncatedSentence`，与运行时同一个函数；候选的三条正则也从这里交给 SQL，
// 不在两处各写一遍（那种写法早晚分叉）。规则本身不加一个字，只把文本收到它自己的边界上。
//
// 默认 DRY-RUN，只列候选与预估。`--apply` 才写库，并**必须**显式给 --database-url（与
// set-source-state.ts、strip-body-boilerplate.ts 同规：让库从环境变量里被猜出来，正是把 dry-run 写成事故的路）。
//
// 跑法：DATABASE_URL=postgres://… node scripts/close-open-ended-summaries.ts                      # 看候选
//       node scripts/close-open-ended-summaries.ts --apply --database-url=postgres://… --max-apply 300
//
// 写库的副作用要说清楚：这些行会一起刷新 `publications.updated_at`，而池子的 ETag/freshness 与 sitemap
// 读的就是它（`publication/pool.ts`）——所以一次 --apply 等于告诉所有订阅方"这批内容变了"。要分批就调小
// --max-apply。不刷新它则缓存里的半句话永远留着，那才是更坏的结果。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { closeTruncatedSentence } from "@aihot/backend/editorial/writing";
import { stripBoilerplate } from "@aihot/backend/lib/text";
import { cjkCount } from "@aihot/contracts/copy";

/**
 * 一条判据，不是两条：`结尾挂分隔符` 与 `整段没有结尾标点` 在 Postgres 上是同一个集合——分隔符 `，、；：,;:`
 * 本来就不在收尾标点 `。！？…!?` 里，所以 `A OR (B AND NOT A)` 恒等于 `B`。评审拿 CI 库上 16 种形状验过这一点
 * （唯一的例外是空串，而下面 `length(summary) >= 20` 已经把它排除）。写成两条只会多一个可以对不上的地方。
 */
export const OPEN_ENDED = "[^。！？…!?]$";

/**
 * 候选判据只写一次，而且是**数据库那一份**：Postgres 的 `~` 与 JS 的 RegExp 在字符类、多字节类上并不总是
 * 同意，而"谁该被洗"这件事必须由写库的那条查询说了算。测试直接拿这段对 `VALUES` 跑，量的是真判据本身。
 */
export function openEndedCondition() {
  return sql`summary ~ ${OPEN_ENDED}`;
}

/**
 * 一条摘要在存量清洗里怎么处置，只由这一个函数说。抽出来是为了让"剥壳→收口"这个顺序本身可测——
 * 写在 main 里就永远只有跑起来那一种验法，而这条脚本洗的是读者已经看到的文本。
 *  - `rewrite`：剥掉页面外壳再收口，写库。
 *  - `keep`：剥壳收口后与原文一字不差，本来就不用碰。
 *  - `skeleton`：整条就是骨架，剥完没东西可留——空摘要会把整行挤出池子，那是另一个决定，所以不写、报给人看。
 *
 * 这里**没有**"剩下的太短就算骨架"这一档：测试先把它证伪了——`气象台继续发布暴雨橙色预警，各地做好准备；`
 * 只有 21 字，是官方预警那种又短又干净的摘要，按长度判骨架会让这条脚本把一大批真候选直接跳过，
 * 等于什么都没修还报告说修好了。剩下的是不是标签话术（`作者信息`、`基金项目`）是那条信源的抽取问题，
 * 不在这里用长度猜。
 */
export function closeStockSummary(summary: string): { kind: "keep" | "rewrite" | "skeleton"; text: string } {
  const bare = stripBoilerplate(summary);
  // 只有一条判据：剥完一个汉字都不剩（`"。"`、`"，、；："` 这种）。
  // 曾经试过加第二条"剥掉的超过一半就算骨架"，被自己的测试否掉了：
  // `PDF(8989 KB) 中国A级景区运营效率测度…{{...}}` 里骨架占七成，可剩下的是一条完整的中文标题——
  // 判成骨架等于把页面外壳继续留在读者眼前，正好与这条脚本的目的相反。
  // 也不按"剩下几个字"判：21 字的官方预警摘要是合法的短摘要，按绝对长度会让真候选被悄悄跳过（第一版就错了）。
  // 剩下的是不是栏目标签名（`作者信息`、`基金项目`）归那条信源的抽取管（#145），不在这里猜。
  if (cjkCount(bare) === 0) return { kind: "skeleton", text: bare };
  const closed = closeTruncatedSentence(bare);
  return closed === summary ? { kind: "keep", text: closed } : { kind: "rewrite", text: closed };
}

async function main() {
const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "max-apply": { type: "string", default: "300" },
    limit: { type: "string", default: "5000" },
    "database-url": { type: "string" },
  },
});
if (values.apply && !values["database-url"]) {
  console.error("--apply 必须显式给 --database-url=…");
  process.exit(2);
}
/** 只比 主机:端口/库名——口令不进日志也不进报错。 */
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

/** 数字参数打错字不能变成"上限消失"：`Number("3O0")` 是 NaN，而 `长度 > NaN` 恒为 false，
 * 于是 --max-apply 的护栏静默失效、一次洗完全库。`backfill-archive.ts` 早就拒绝了这一类，照它做。 */
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
// 整条候选判据也只写一份：条数与明细两条查询必须数的是同一批行，否则打印出来的"全库多少条"与实际要改的不是同一件事。
const candidateWhere = sql`visibility = 'public' AND summary IS NOT NULL AND length(summary) >= 20 AND ${openEndedCondition()}`;
const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE ${candidateWhere}`;
const rows = await sql<{ article_id: string; analysis_id: number | null; revision: number; summary: string }[]>`
  SELECT article_id, analysis_id, revision, summary
  FROM publications
  WHERE ${candidateWhere}
  ORDER BY updated_at
  LIMIT ${limit}`;

// 整条处置规则只有 `closeStockSummary` 那一份：下面按它的判定分桶，不再在这里重写一遍剥壳与收口的顺序。
const skeletons: Array<{ article_id: string; summary: string }> = [];
const fixes: Array<{ article_id: string; analysis_id: number | null; revision: number; summary: string; closed: string }> = [];
for (const r of rows) {
  const out = closeStockSummary(r.summary);
  if (out.kind === "skeleton") skeletons.push({ article_id: r.article_id, summary: r.summary });
  else if (out.kind === "rewrite") fixes.push({ article_id: r.article_id, analysis_id: r.analysis_id, revision: r.revision, summary: r.summary, closed: out.text });
}

console.log(`${values.apply ? "写入" : "DRY-RUN 候选"}：全库形状不闭合 ${total?.n ?? 0} 条，本轮读回 ${rows.length} 条（--limit=${limit}），其中收口后会变 ${fixes.length} 条（上限 --max-apply=${maxApply}），剥完没东西可留、按骨架留给人工的 ${skeletons.length} 条`);
for (const f of fixes.slice(0, 8)) {
  console.log(`  ${f.article_id} 「…${f.summary.slice(-18)}」→「…${f.closed.slice(-18)}」（${f.summary.length}→${f.closed.length} 字）`);
}
for (const s of skeletons.slice(0, 5)) console.log(`  骨架不写：${s.article_id} 「${s.summary.slice(0, 40)}…」`);
const shortened = fixes.filter((f) => f.closed.length < f.summary.length).length;
console.log(`其中要丢掉尾巴（收到上一个完整句子）的：${shortened} 条；只补/换收尾标点的：${fixes.length - shortened} 条`);

if (!values.apply) {
  console.log("\n默认不写库。确认后用 --apply --database-url=postgres://… 跑。");
} else if (fixes.length > maxApply) {
  // 一次洗两千条等于一次给所有订阅方发两千年"变了"，那不该是一个回车键就该发生的事。
  console.error(`候选 ${fixes.length} 条超过 --max-apply=${maxApply}：分批跑，或明确调大上限。没有写库。`);
  process.exitCode = 1;
} else {
  // 改一处不够：`publication/publish.ts:179` 每次投影都从 `analyses.summary_zh` 重新取摘要，
  // 而投影在这期间到处都是（分组、合并、后台重发、`strip-body-boilerplate` 的重跑）。
  // 只洗 `publications.summary`，下一次投影就把半句话写回来——所以两处一起改，且放在同一个事务里，
  // 不允许出现"库里判稿已改、读者那份还没改"的半程状态。
  const backup = resolve(".data/backups", `summary-close-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
  mkdirSync(dirname(backup), { recursive: true });
  let done = 0;
  let skipped = 0;
  for (const f of fixes) {
    // 先落原值再改：这一刀是删尾巴（可能删掉真实数据），改坏了要能按行还原。
    appendFileSync(backup, `${JSON.stringify({ article_id: f.article_id, analysis_id: f.analysis_id, revision: f.revision, summary: f.summary })}\n`);
    const written = await sql.begin(async (tx) => {
      if (f.analysis_id !== null) {
        await tx`UPDATE analyses SET summary_zh = ${f.closed} WHERE id = ${f.analysis_id} AND summary_zh = ${f.summary}`;
      }
      const res = await tx<{ n: number }[]>`
        WITH updated AS (
          UPDATE publications SET summary = ${f.closed}, updated_at = now()
           WHERE article_id = ${f.article_id} AND revision = ${f.revision} AND summary = ${f.summary}
          RETURNING 1)
        SELECT count(*)::int AS n FROM updated`;
      return res[0]?.n ?? 0;
    });
    // `revision` 是 publications 的主键一部分：读它与写它之间 worker 若重发过，这条 UPDATE 命中 0 行。
    // 命中 0 行就不算"收口了"——计数只报真写进去的，宁可少报也不虚报。
    if (written > 0) done++;
    else skipped++;
  }
  console.log(`已收口 ${done} 条摘要（两处一起改：analyses.summary_zh 与 publications.summary）`
    + `${skipped ? `；另有 ${skipped} 条在读取后被重新投影过，本轮没碰，下次跑会重新判` : ""}。原值备份：${backup}`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  finally { await closeDb(); }
}
