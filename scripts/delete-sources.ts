// Deletes sources with all their articles (e.g. sources that can no longer be collected).
//   node --env-file=.env scripts/delete-sources.ts "<reason>" <source-id>...        # 只预览
//   node --env-file=.env scripts/delete-sources.ts "<reason>" <source-id>... --yes  # 真的执行
// Items that were ever selected are withdrawn first, so sync clients get a removal; reports stop citing
// the deleted items (a report cites ids it cannot find as published).
import { audit } from "@aihot/backend/admin/auth";
import { setVisibility } from "@aihot/backend/admin/content";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

const ACTOR = "ops-script";
const argv = process.argv.slice(2);
const [reason, ...rest] = argv;
const ids = rest.filter((a) => a !== "--yes");
if (!reason || ids.length === 0) throw new Error('usage: delete-sources.ts "<reason>" <source-id>... [--yes]');

const sources = await sql<{ id: string; name: string }[]>`SELECT id, name FROM sources WHERE id IN ${sql(ids)}`;
for (const missing of ids.filter((id) => !sources.some((s) => s.id === id))) console.log(`${missing}: no such source`);
const articleIds = (await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id IN ${sql(ids)}`).map((r) => r.id);

const selected = await sql<{ article_id: string; version: number | null }[]>`
  SELECT p.article_id, o.version FROM publications p LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
  WHERE p.source_id IN ${sql(ids)} AND p.selected_ready_at IS NOT NULL AND p.visibility <> 'withdrawn'`;
// 这是一次不可逆的批量删除（条目、信源、报纸引用，还会把精选撤下同步给客户端）。部署包里其它会动手的脚本
// （rollback.sh、bootstrap-server.sh）都是"默认只预览、显式才执行"，这个脚本以前是直接删完再报数字——
// 打错一个 id、或者环境串到生产的 DATABASE_URL 上，就没有回头路了。
const YES = process.argv.includes("--yes");
// 先只读地算出会被影响的期数，预览与执行用同一个算式。
const countAffectedReports = async () => {
  const gone = new Set(articleIds);
  let n = 0;
  for (const r of await sql<{ content: unknown }[]>`SELECT content FROM reports`) {
    if ([...gone].some((id) => JSON.stringify(r.content).includes(id))) n += 1;
  }
  return n;
};
const affectedReports = await countAffectedReports();

if (!YES) {
  console.log(`DRY-RUN（没有写任何东西）。将要：`);
  console.log(`  1. 撤下 ${selected.length} 条曾进精选的条目（同步客户端会收到移除）`);
  console.log(`  2. 改写 ${affectedReports} 期报纸，去掉对这些条目的引用`);
  console.log(`  3. 删除 ${sources.length} 个信源与它们的 ${articleIds.length} 条条目`);
  for (const s of sources) console.log(`     - ${s.id}  ${s.name}`);
  for (const id of ids) if (!sources.some((s) => s.id === id)) console.log(`     · ${id}：库里没有这个信源（会被忽略）`);
  console.log(`理由会记成 ${JSON.stringify(reason)}。确认无误后加 --yes 才真的执行。`);
  await stopBoss();
  await closeDb();
  process.exit(0);
}

for (const s of selected) await setVisibility(s.article_id, { visibility: "withdrawn", reason, version: s.version ?? 0 }, ACTOR);

/** Drops array entries and clears fields that point at a deleted item. */
function prune(node: unknown, gone: Set<string>): unknown {
  if (Array.isArray(node)) return node.filter((x) => !(x && typeof x === "object" && gone.has((x as { itemId?: string }).itemId ?? ""))).map((x) => prune(x, gone));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) && gone.has((v as { itemId?: string }).itemId ?? "") ? null : prune(v, gone)]));
  }
  return node;
}
const gone = new Set(articleIds);
let reports = 0;
for (const r of await sql<{ kind: string; key: string; content: unknown }[]>`SELECT kind, key, content FROM reports`) {
  const text = JSON.stringify(r.content);
  if (![...gone].some((id) => text.includes(id))) continue;
  await sql`UPDATE reports SET content = ${sql.json(prune(r.content, gone) as never)} WHERE kind = ${r.kind} AND key = ${r.key}`;
  reports += 1;
}

await sql.begin(async (tx) => {
  // `embeddings.ref_id` 没有外键（0006 建表时就是 (kind, ref_id, model) 主键），硬删条目会把向量留成孤儿：
  // 归组每判一次都要读这张表，孤儿行永远不会被命中，却永久占着体积。删条目就顺手删它自己的向量。
  await tx`DELETE FROM embeddings WHERE kind = 'article' AND ref_id IN ${tx(articleIds)}`;
  await tx`DELETE FROM articles WHERE source_id IN ${tx(ids)}`;
  await tx`DELETE FROM sources WHERE id IN ${tx(ids)}`;
});
for (const s of sources) await audit(ACTOR, "source.delete", `source:${s.id}`, reason, { name: s.name }, null);
console.log(`deleted ${sources.length} sources and ${articleIds.length} articles; withdrew ${selected.length} selected first; ${reports} report(s) no longer cite them`);
await stopBoss();
await closeDb();
