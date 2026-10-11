// 把已经存进库里的"半句话摘要"收在一个完整句子上（#130 的存量那一半）。
//
// 为什么存量要单独洗：抽取侧的修复早就落地了——`editorial/writing.ts` 的 `closeTruncatedSentence` 现在会
// 把每一条新摘要收口，所以精选与报纸那层是干净的（2026-10-11 生产实测：693 条 selected 里 0 条结尾挂分隔符）。
// 但修好之前抓回来的东西还躺在 `publications.summary` 里：同一批全库 9,267 条公开行有 1,772 条以「，、；：」
// 结尾、189 条整段没有结尾标点——读者在分类页和条目页会直接看到它们。
//
// 判据只有一个来源：本脚本调 `closeTruncatedSentence`，与运行时同一个函数；候选的那条正则也从这里交给 SQL，
// 不在两处各写一遍（那种写法早晚分叉）。规则本身不加一个字，只把文本收到它自己的边界上。
//
// 默认 DRY-RUN，只列候选与预估。`--apply` 才写库，并**必须**显式给 --database-url（与
// set-source-state.ts、strip-body-boilerplate.ts 同规：让库从环境变量里被猜出来，正是把 dry-run 写成事故的路）。
//
// 跑法：DATABASE_URL=postgres://… node scripts/close-open-ended-summaries.ts                      # 看候选
//       node scripts/close-open-ended-summaries.ts --apply --database-url=postgres://… --max-apply 300
//       # 规则改过之后修上一次写进去的：拿那一次 --apply 的预像文件当清单，逐行按新规则重算
//       node scripts/close-open-ended-summaries.ts --repair-from=.data/backups/summary-close-<ts>.jsonl \
//            --apply --database-url=postgres://… --max-apply 2000
//
// 写库的副作用要说清楚：这些行会一起刷新 `publications.updated_at`，而池子的 ETag/freshness 与 sitemap
// 读的就是它（`publication/pool.ts`）——所以一次 --apply 等于告诉所有订阅方"这批内容变了"。要分批就调小
// --max-apply。不刷新它则缓存里的半句话永远留着，那才是更坏的结果。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { config } from "@aihot/backend/config";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { closeTruncatedSentence } from "@aihot/backend/editorial/writing";
import { stripBoilerplate, stripTruncatedShellTail } from "@aihot/backend/lib/text";
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
  // 剥完还要走一次"截断外壳"判据：骨架被截断时 }} 不在，shared 的 stripBoilerplate 够不着它，
  // 而这条路上整条文本就是一条摘要，结尾确实等于截断点（sanitize 那条逐节点的路不配这个前提）。
  const bare = stripTruncatedShellTail(stripBoilerplate(summary));
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

/** 一行收口的全部写入面；`revision` 是 publications 主键的一部分，所以它必须跟着走。 */
export type CloseFix = { article_id: string; analysis_id: number | null; revision: number; summary: string; closed: string };

export type CloseOutcome = "written" | "stale" | "divergent";
/** closeBoth 用它通知 sql.begin 回滚，并把是哪一个原因带出去；不外抛给操作者。 */
class RollbackRow extends Error {
  why: Exclude<CloseOutcome, "written">;
  constructor(why: Exclude<CloseOutcome, "written">) { super(why); this.why = why; }
}

/**
 * 两处一起改，或一处都不改。
 *
 * 这条不变量是脚本存在的全部理由：`publication/publish.ts:179` 每次投影都从 `analyses.summary_zh`
 * 重新取摘要，所以只落 publications 一边，等于下次投影把半句话原样写回来，而日志还写着"两处一起改"。
 * 抽成函数（而不是留在 `sql.begin` 的回调里）是为了这条不变量能被真跑一遍：
 * 之前它只活在注释里，独立评审据此判了 BLOCKER——"publications 命中 0 行、analyses 改了 1 行"会照样提交。
 * 调用方拿到非 "written" 必须回滚整个事务。
 */
/**
 * 两边的命中数怎么合成一个结论——纯函数，因为这条判断是整个脚本的不变量所在：
 * 只有"读者那份落了"这一种情况可以提交；判稿那份没落说明两列本来就不相同，写一遍只会造成假一致。
 * 之前这条判断写在 sql.begin 的回调里、只看返回值，所以"publications 命中 0 行、analyses 改了 1 行"会照样提交。
 */
export function closeOutcome(pubN: number, anaN: number, hasAnalysis: boolean): CloseOutcome {
  if (pubN === 0) return "stale";
  if (hasAnalysis && anaN === 0) return "divergent";
  return "written";
}

export async function closeBoth(tx: Db, f: CloseFix, repairMode: boolean): Promise<"written" | "stale" | "divergent"> {
  // 守卫分两种：正常模式认"库里还是我刚读到的那一份"；修复模式库里躺的是上一次写坏的文本，认不了它，
  // 于是认 `revision`（并发保护仍然在）加"与我要写的不同"（相同的不重写，免得白刷一遍 updated_at）。
  const pubDiffers = repairMode ? sql`summary IS DISTINCT FROM ${f.closed}` : sql`summary = ${f.summary}`;
  const anaDiffers = repairMode ? sql`summary_zh IS DISTINCT FROM ${f.closed}` : sql`summary_zh = ${f.summary}`;
  let anaN = 0;
  if (f.analysis_id !== null) {
    const a = await tx<{ n: number }[]>`
      WITH u AS (UPDATE analyses SET summary_zh = ${f.closed} WHERE id = ${f.analysis_id} AND ${anaDiffers} RETURNING 1)
      SELECT count(*)::int AS n FROM u`;
    anaN = a[0]?.n ?? 0;
  }
  const res = await tx<{ n: number }[]>`
    WITH updated AS (
      UPDATE publications SET summary = ${f.closed}, updated_at = now()
       WHERE article_id = ${f.article_id} AND revision = ${f.revision} AND ${pubDiffers}
      RETURNING 1)
    SELECT count(*)::int AS n FROM updated`;
  const pubN = res[0]?.n ?? 0;
  return closeOutcome(pubN, anaN, f.analysis_id !== null);
}

async function main() {
const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "max-apply": { type: "string", default: "300" },
    limit: { type: "string", default: "5000" },
    "database-url": { type: "string" },
    // 收口规则改过（句号 → 列举要用省略号）。已经按旧规则写进库的那批行**不再匹配候选判据**
    // （它们结尾是「。」，形状上是闭合的），靠扫形状永远捞不回来——所以修它们的依据是上一次 --apply
    // 留下的按行预像文件：里面是"我读过什么"，重算一遍就是我当初该写什么。
    "repair-from": { type: "string" },
  },
});
const repairFrom = values["repair-from"];
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
type Row = { article_id: string; analysis_id: number | null; revision: number; summary: string };
let total: { n: number } | undefined;
let rows: Row[];
if (repairFrom) {
  // 修复模式的"候选"不是我扫出来的，是上一次 --apply 自己记下的：预像里每一行都是"我读过并写过"的凭据。
  const raw = readFileSync(resolve(repairFrom), "utf8").trim().split(/\r?\n/).filter(Boolean);
  // 上一次运行若被 kill 在"落备份行"中途，最后一行会是半条 JSON。它不是凭据：跳过并说清楚，
  // 而不是让整脚本在 load 阶段抛异常——那样连剩下的行也修不了。
  const lines: string[] = [];
  let torn = 0;
  for (const l of raw) { try { JSON.parse(l); lines.push(l); } catch { torn++; } }
  const kept = lines.slice(0, limit);
  rows = kept.map((l) => {
    const j = JSON.parse(l) as { article_id: string; analysis_id?: number | null; revision: number; summary: string };
    return { article_id: j.article_id, analysis_id: j.analysis_id ?? null, revision: j.revision, summary: j.summary };
  });
  total = { n: lines.length };
  const dropped = lines.length - kept.length;
  if (torn || dropped) console.log(`预像读取：${torn ? `${torn} 行残缺（上一次运行被中断），已跳过；` : ""}超出 --limit=${limit} 的 ${dropped} 行本轮不处理（要一次跑完就调大 --limit）`);
} else {
  [total] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE ${candidateWhere}`;
  rows = await sql<Row[]>`
    SELECT article_id, analysis_id, revision, summary
    FROM publications
    WHERE ${candidateWhere}
    ORDER BY updated_at
    LIMIT ${limit}`;
}

// 整条处置规则只有 `closeStockSummary` 那一份：下面按它的判定分桶，不再在这里重写一遍剥壳与收口的顺序。
const skeletons: Array<{ article_id: string; summary: string }> = [];
const fixes: Array<{ article_id: string; analysis_id: number | null; revision: number; summary: string; closed: string }> = [];
for (const r of rows) {
  const out = closeStockSummary(r.summary);
  if (out.kind === "skeleton") skeletons.push({ article_id: r.article_id, summary: r.summary });
  else if (out.kind === "rewrite") fixes.push({ article_id: r.article_id, analysis_id: r.analysis_id, revision: r.revision, summary: r.summary, closed: out.text });
}

console.log(`${repairFrom ? "按预像修复" : values.apply ? "写入" : "DRY-RUN 候选"}：${repairFrom ? `预像 ${total?.n ?? 0} 行（${repairFrom}）` : `全库形状不闭合 ${total?.n ?? 0} 条`}，本轮处理 ${rows.length} 条（--limit=${limit}），其中收口后会变 ${fixes.length} 条（上限 --max-apply=${maxApply}），剥完没东西可留、按骨架留给人工的 ${skeletons.length} 条`);
for (const f of fixes.slice(0, 8)) {
  console.log(`  ${f.article_id} 「…${f.summary.slice(-18)}」→「…${f.closed.slice(-18)}」（${f.summary.length}→${f.closed.length} 字）`);
}
for (const s of skeletons.slice(0, 5)) console.log(`  骨架不写：${s.article_id} 「${s.summary.slice(0, 40)}…」`);
const shortened = fixes.filter((f) => f.closed.length < f.summary.length).length;
console.log(`其中要丢掉尾巴（收到上一个完整句子）的：${shortened} 条；只补/换收尾标点的：${fixes.length - shortened} 条`);

/**
 * 修复模式的"候选"来自预像，而 `closed` 是用**此刻的规则**重算的——这两个数比的不是同一件事。
 * 2026-10-12 实测：预像 1,748 行全部"与原文不同"（原文都还挂着 `；`），可库里此刻真正与判定值不一致的只有 14 行；
 * 拿 1,748 去比 `--max-apply`，一次 14 行的手术会被当成 1,748 行的批量拦下，反过来在正常模式里它比的又是唯一对的那个数。
 * 所以要写的是"库里此刻 ≠ 判定值"那一份，报告与闸门都用它。
 * 两侧都要看：投影会单独重写 `analyses.summary_zh`，只比 `publications` 会漏掉"读者那份已分叉、判稿那份还没"的行。
 */
const analysisIds = [...new Set(fixes.map((f) => f.analysis_id).filter((x): x is number => x !== null))];
const current = repairFrom
  ? {
      pub: fixes.length
        ? new Map((await sql<{ article_id: string; summary: string }[]>`
            SELECT article_id, summary FROM publications WHERE article_id = ANY(${fixes.map((f) => f.article_id)})`)
          .map((r) => [r.article_id, r.summary] as const))
        : new Map<string, string>(),
      ana: analysisIds.length
        ? new Map((await sql<{ id: number; summary_zh: string }[]>`
            SELECT id, summary_zh FROM analyses WHERE id = ANY(${analysisIds})`)
          .map((r) => [r.id, r.summary_zh] as const))
        : new Map<number, string>(),
    }
  : null;
const pending = current
  ? fixes.filter((f) => current.pub.get(f.article_id) !== f.closed
      || (f.analysis_id !== null && current.ana.get(f.analysis_id) !== f.closed))
  : fixes;
if (current) console.log(`其中库里此刻与判定值不同、本轮真会写的：${pending.length} 条（其余 ${fixes.length - pending.length} 条已经是这个值，连事务都不开）`);

if (!values.apply) {
  console.log("\n默认不写库。确认后用 --apply --database-url=postgres://… 跑。");
} else if (pending.length > maxApply) {
  // 一次洗两千条等于一次给所有订阅方发两千年"变了"，那不该是一个回车键就该发生的事。
  console.error(`本轮要写 ${pending.length} 条超过 --max-apply=${maxApply}：分批跑，或明确调大上限。没有写库。`);
  process.exitCode = 1;
} else {
  // 改一处不够：`publication/publish.ts:179` 每次投影都从 `analyses.summary_zh` 重新取摘要，
  // 而投影在这期间到处都是（分组、合并、后台重发、`strip-body-boilerplate` 的重跑）。
  // 只洗 `publications.summary`，下一次投影就把半句话写回来——所以两处一起改，且放在同一个事务里，
  // 不允许出现"库里判稿已改、读者那份还没改"的半程状态。
  const backup = resolve(".data/backups", `summary-close-${new Date().toISOString().replaceAll(":", "-")}${repairFrom ? "-repair" : ""}.jsonl`);
  mkdirSync(dirname(backup), { recursive: true });
  let done = 0;
  let skipped = 0;
  let divergent = 0;
  for (const f of pending) {
    // 库里已经没有这一行了（导入过程中被删）：不能拿预像里那份更早的原文当"此刻的原值"写进备份，
    // 否则下一次按这份备份还原，就会把一个新进口的行覆盖成它从未有过的文本。跳过，不备份，不动事务。
    if (repairFrom && !current?.pub.has(f.article_id)) { skipped++; continue; }
    // 先落原值再改：这一刀是删尾巴（可能删掉真实数据），改坏了要能按行还原。
    // 两列各记一份——只记 publications 那份的话，被覆盖掉的判稿就再也拿不回来了。
    const preImage = {
      article_id: f.article_id, analysis_id: f.analysis_id, revision: f.revision,
      summary: current?.pub.get(f.article_id) ?? f.summary,
      ...(f.analysis_id !== null ? { analysis_summary: current?.ana.get(f.analysis_id) ?? null } : {}),
    };
    appendFileSync(backup, `${JSON.stringify(preImage)}\n`);
    // 两处一起改或一处都不改，规则在 `closeBoth`（它被抽出来，是为了让这条不变量能真跑一遍）。
    const outcome: CloseOutcome = await sql.begin(async (tx) => {
      const r = await closeBoth(tx, f, Boolean(repairFrom));
      if (r !== "written") throw new RollbackRow(r);
      return "written" as const;
    }).catch((error) => {
      if (error instanceof RollbackRow) return error.why;
      throw error;
    });
    // `revision` 是 publications 的主键一部分：读它与写它之间 worker 若重发过，这条 UPDATE 命中 0 行。
    // 命中 0 行就不算"收口了"——计数只报真写进去的，宁可少报也不虚报。
    if (outcome === "written") done++;
    else if (outcome === "divergent") divergent++;
    else skipped++;
  }
  console.log(`已收口 ${done} 条摘要（两处一起改：analyses.summary_zh 与 publications.summary，任何一边没落就整笔回滚）`
    + `${skipped ? `；${skipped} 条在读取后被重新投影过或已不在库里，本轮没碰，下次跑会重新判` : ""}`
    + `${divergent ? `；${divergent} 条两列本来就不一致（例如编辑手工改过读者那份），改一边只会造成假一致，整笔回滚没动` : ""}`
    + `。原值备份：${backup}`);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  finally { await closeDb(); }
}
