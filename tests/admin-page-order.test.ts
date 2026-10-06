// 按 OFFSET 翻页的查询必须有一个"唯一列收尾"的排序。
//
// 为什么钉的是写法而不是行为：`ORDER BY created_at DESC LIMIT 50 OFFSET 50` 在两边时间戳完全相同的行上
// 没有定义次序——Postgres 对相等键做的是快排，不保证稳定。但"不保证"不等于"会翻车"：单线程顺序扫描时
// 两次执行经常给回同一个顺序，于是"翻两页看看有没有重复"这种测试**在没有修复时也可能通过**，
// 那它就不是在钉这条规则，而是在记录一次抽样。这里改成扫源码：把 `, fb.id` 去掉，本测试立刻红。
//
// 真实后果（第三十四轮评审提出，本轮核对成立）：后台三张列表都是 OFFSET 翻页，排序列都不唯一——
//   admin/feedback.ts 按 created_at（同一秒提交的两条会并列）
//   admin/monitor.ts  按 published_at（一批推文常常同一时刻）
//   admin/sources.ts  按 enabled、health、name（同名信源是允许的，id 才唯一）
// 并列行的相对次序由执行计划决定，翻页时同一条可能出现在两页、也可能一页都不出现。
// 读者侧那两条（publication/pool.ts、publication/topics.ts）一直是以 `p.article_id` 收尾的，
// 所以这条规则不是新加的偏好，而是"读者侧早就这么做、后台漏了"。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const BACKEND = path.resolve(import.meta.dirname, "../packages/backend/src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 模板串里的 SQL，去掉行注释（注释里可以提到 LIMIT 这个词）。 */
const sqlTexts = (file: string): string[] =>
  [...readFileSync(file, "utf8").replace(/^[ \t]*\/\/.*$/gm, "").matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]!);

/** 最后一个排序项：按顶层逗号切，去掉方向与 NULLS 修饰，剩下的就是那一列。 */
function lastSortTerm(orderBy: string): string {
  const terms = orderBy.split(",").map((t) => t.trim()).filter(Boolean);
  const last = terms.at(-1) ?? "";
  return last.replace(/\s+(DESC|ASC)(\s+NULLS\s+(FIRST|LAST))?$/i, "").trim();
}

test("每一处 OFFSET 翻页的查询，ORDER BY 都以唯一列（id / *_id）收尾", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of sourceFiles(BACKEND)) {
    for (const sql of sqlTexts(file)) {
      if (!/OFFSET\s+\$\{/.test(sql)) continue;
      for (const m of sql.matchAll(/ORDER BY\s+([\s\S]*?)\bLIMIT\b/g)) {
        checked += 1;
        const term = lastSortTerm(m[1]!);
        if (!/(^|[._])?[a-z_]*id$/i.test(term)) offenders.push(`${path.basename(file)}: ${term || "(空)"} ← ${sql.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  assert.ok(checked >= 5, `这条规则要真的扫到东西才算数：只看了 ${checked} 处 OFFSET 翻页`);
  assert.deepEqual(offenders, [], "并列行没有确定次序，翻页会重复或漏掉条目");
});
