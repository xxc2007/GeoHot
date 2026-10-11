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
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { closeTruncatedSentence } from "@aihot/backend/editorial/writing";

/** 交给 SQL 的两条形状判据；测试用同样的字符串断言它们真的抓得住这三种形状。 */
export const ENDS_WITH_SEPARATOR = "[，、；：,;:]+$";
export const MISSING_END_PUNCT = "[^。！？…!?]$";

/**
 * 候选判据只写一次，而且是**数据库那一份**：Postgres 的 `~` 与 JS 的 RegExp 在字符类、多字节类上并不总是
 * 同意，而"谁该被洗"这件事必须由写库的那条查询说了算。测试直接拿这段对 `VALUES` 跑，量的是真判据本身。
 */
export function openEndedCondition() {
  return sql`(summary ~ ${ENDS_WITH_SEPARATOR} OR (summary ~ ${MISSING_END_PUNCT} AND summary !~ ${ENDS_WITH_SEPARATOR}))`;
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

const limit = Number(values.limit);
const maxApply = Number(values["max-apply"]);
// 整条候选判据也只写一份：条数与明细两条查询必须数的是同一批行，否则打印出来的"全库多少条"与实际要改的不是同一件事。
const candidateWhere = sql`visibility = 'public' AND summary IS NOT NULL AND length(summary) >= 20 AND ${openEndedCondition()}`;
const [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE ${candidateWhere}`;
const rows = await sql<{ article_id: string; revision: number; summary: string }[]>`
  SELECT article_id, revision, summary
  FROM publications
  WHERE ${candidateWhere}
  ORDER BY updated_at
  LIMIT ${limit}`;

const fixes = rows
  .map((r) => {
    const closed = closeTruncatedSentence(r.summary);
    return closed === r.summary ? null : { ...r, closed };
  })
  .filter((r): r is NonNullable<typeof r> => r !== null);

console.log(`${values.apply ? "写入" : "DRY-RUN 候选"}：全库形状不闭合 ${total?.n ?? 0} 条，本轮读回 ${rows.length} 条（--limit=${limit}），其中收口后会变 ${fixes.length} 条（上限 --max-apply=${maxApply}）`);
for (const f of fixes.slice(0, 8)) {
  console.log(`  ${f.article_id} 「…${f.summary.slice(-18)}」→「…${f.closed.slice(-18)}」（${f.summary.length}→${f.closed.length} 字）`);
}
const shortened = fixes.filter((f) => f.closed.length < f.summary.length).length;
console.log(`其中要丢掉尾巴（收到上一个完整句子）的：${shortened} 条；只补/换收尾标点的：${fixes.length - shortened} 条`);

if (!values.apply) {
  console.log("\n默认不写库。确认后用 --apply --database-url=postgres://… 跑。");
} else if (fixes.length > maxApply) {
  // 一次洗两千条等于一次给所有订阅方发两千年"变了"，那不该是一个回车键就该发生的事。
  console.error(`候选 ${fixes.length} 条超过 --max-apply=${maxApply}：分批跑，或明确调大上限。没有写库。`);
  process.exitCode = 1;
} else {
  let done = 0;
  for (const f of fixes) {
    await sql`UPDATE publications SET summary = ${f.closed}, updated_at = now()
               WHERE article_id = ${f.article_id} AND revision = ${f.revision}`;
    done++;
  }
  console.log(`已收口 ${done} 条摘要。`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  finally { await closeDb(); }
}
