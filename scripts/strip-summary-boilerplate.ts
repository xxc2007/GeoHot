// 把"另一个网站的页脚"从读者的屏幕上拿掉。
//
// 为什么单独一个脚本：2026-10-12 的线上验证波在 `/all` 的列表卡上数到 **28 条**条目，
// 它们的「内容提要」整段是抓取回来的页面外壳——
//   「国家气象中心 版权所有 Copyright©2009-2026 本站所刊登的信息、数据和各种专栏材料，
//     未经授权禁止下载使用 … 京ICP备05055842号 技术支持邮箱 …」
// 站长 2026-10-06 就为这件事说过一次话（他的信息里只留核心内容），当时修的是**正文**
// （`strip-body-boilerplate.ts`）。提要这一列没人洗过：正文的规则在 `lib/text.ts` 里只有一份，
// 而抽取时把整页文字当摘要送进来的那条路绕过了它。
//
// 两处必须一起改，只洗 `publications` 是假修：提要的真身是 `analyses.summary_zh`，
// 下一次投影会原样把外壳写回来（这条规矩是 488dcbe「存量摘要清洗要两处一起改」留下的）。
//
// 洗完空了怎么办：置 NULL，而不是留一段版权话术。`publications.summary` 可空，
// 版面本来就会在没有提要时只印标题——**少一句摘要不是缺陷，把别人的页脚当摘要才是。**
//
//   node --env-file=.env scripts/strip-summary-boilerplate.ts                     # 只看名单
//   node --env-file=.env scripts/strip-summary-boilerplate.ts --apply \
//     --database-url-env=DATABASE_URL                                             # 真洗
import { parseArgs } from "node:util";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collapseWhitespace, stripBoilerplate } from "@aihot/backend/lib/text";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", default: "500" },
    "database-url": { type: "string" },
    "database-url-env": { type: "string" },
  },
});
if (values.apply && !values["database-url"] && !values["database-url-env"]) {
  console.error("--apply 必须显式给出 --database-url 或 --database-url-env=DATABASE_URL（从环境里猜库正是把 dry-run 写成事故的那条路）");
  process.exit(2);
}
if (values["database-url-env"] !== undefined && (values["database-url-env"] !== "DATABASE_URL" || values["database-url"])) {
  console.error("--database-url-env 仅接受 DATABASE_URL，且与 --database-url 互斥");
  process.exit(2);
}
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1) {
  console.error(`--limit 要是 ≥1 的整数，收到的是「${values.limit}」`);
  process.exit(2);
}
// 与 `scripts/audit-content-integrity.ts` 同一条 SQL 形状：这一段外壳话术的判据只在 `lib/text.ts` 写一份，
// 这里拼的是"哪一列需要洗"，不是第二份规则。
const SHELL = "'版权所有|Copyright|未经授权禁止|凡本网注明|ICP[备证]|违法和不良信息举报|转载请注明出处|技术支持[：:]|All rights reserved'";
const targetOf = (u: string) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return ""; } };
if (values.apply) {
  const given = values["database-url-env"] ? process.env.DATABASE_URL ?? "" : values["database-url"] ?? "";
  if (!given || targetOf(given) !== targetOf(config.databaseUrl)) {
    console.error(`--apply 指名的库要与进程正在用的同一个（给的是「${targetOf(given) || "空"}」，环境是「${targetOf(config.databaseUrl)}」）`);
    await closeDb();
    process.exit(2);
  }
}

const rows = await sql<{ articleId: string; analysisId: string | null; pub: string; ana: string | null }[]>`
  SELECT p.article_id AS "articleId", x.id AS "analysisId", p.summary AS pub, x.summary_zh AS ana
  FROM publications p
  LEFT JOIN analyses x ON x.article_id = p.article_id
  WHERE p.visibility = 'public' AND coalesce(p.summary, '') ~ ${SHELL}
     OR (x.summary_zh IS NOT NULL AND x.summary_zh ~ ${SHELL})
  ORDER BY p.article_id LIMIT ${limit}`;

let changed = 0;
let emptied = 0;
const samples: Array<{ id: string; before: string; after: string }> = [];
for (const r of rows) {
  const pub = collapseWhitespace(stripBoilerplate(r.pub ?? ""));
  const ana = r.ana === null ? null : collapseWhitespace(stripBoilerplate(r.ana));
  const pubChanged = pub !== (r.pub ?? "");
  const anaChanged = ana !== null && ana !== r.ana;
  if (!pubChanged && !anaChanged) continue;
  if (samples.length < 3) samples.push({ id: r.articleId, before: (r.pub ?? "").slice(0, 90), after: pub.slice(0, 90) });
  if (pub === "") emptied++;
  changed++;
  if (!values.apply) continue;
  // 两处一起写：只写 publications 的那一份会被下一次投影覆盖回去。
  if (anaChanged) await sql`UPDATE analyses SET summary_zh = ${ana} WHERE id = ${r.analysisId}`;
  await sql`UPDATE publications SET summary = ${pub === "" ? null : pub}, updated_at = now() WHERE article_id = ${r.articleId}`;
}

console.log(`${values.apply ? "已洗" : "计划洗"} ${changed} 条（扫了 ${rows.length} 条候选，--limit=${limit}）；其中洗完变空、置 NULL 的 ${emptied} 条。`);
for (const s of samples) console.log(`  ${s.id}\n    前：${s.before}\n    后：${s.after || "（空 → NULL）"}`);
if (!values.apply) console.log("\n默认只看不写。确认后用 --apply --database-url-env=DATABASE_URL 跑。");
console.log("注意：已经印进报纸的存版不会被这条脚本改——那要靠 scripts/recompose-report.ts 或收尾那一次 --refresh 重排。");
await closeDb();
