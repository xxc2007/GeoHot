// 回滚一次洗坏了的正文。
//
// 为什么要它：2026-10-06 03:09 那次 `strip-body-boilerplate.ts --apply` 把 1002 条**有正文**的条目写成了
// `body_text=NULL, body_html=NULL, body_status='pending'`。脚本里 `lost` 判的是 `isBoilerplateBody(r.clean)`，
// 而 `r` 是查出来的原始行、没有 `clean` 这个字段，undefined 一律判成「洗完不剩正文」，于是每条都走了删除分支；
// `scripts/` 又不在 `npm run typecheck` 的范围里，类型没拦住（线上实测：pending 且无正文 1011 条，其中 1002 条
// 在 `article_revisions` 里留有 >60 字的正文、`processing_state` 还是 analyzed；986 条来自中央气象台预警）。
//
// 本脚本只做还原：读洗正文时留下的逐行备份，把「现在 body_status='pending' 且 body_text 为空」的那几条
// 恢复成备份里的值（`content_hash` 取 `article_revisions` 同一 revision 的指纹，那是这份正文原来的哈希），
// 再按信源重算 publication——`publishArticle` 不花模型额度，正文回来了读者才看得到全文。默认 DRY-RUN。
//
// 跑法：node scripts/restore-body-from-backup.ts --backup=boilerplate-backup-2026-10-060309.jsonl
//       … --apply --database-url=postgres://…
//       … --state=washed                # 撤销「规则写错的那次清洗」：库里正文还在，但内容不是备份那一份
// 幂等：不满足 `--state` 判据的行不会被覆盖；写库那条 UPDATE 的 WHERE 又重复核了 revision 与现文本。
import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { republishSource } from "@aihot/backend/publication/publish";
import { config } from "@aihot/backend/config";

interface BackupRecord {
  id: string;
  revision: number;
  body_text: string | null;
  body_html: string | null;
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbArg = args.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length);
if (apply && !dbArg) {
  // 从环境变量里猜生产库，正是把 dry-run 变成写库事故的路径。
  console.error("--apply 必须显式给 --database-url=…");
  process.exit(2);
}
if (dbArg) {
  // 连接走 backend 的池（读环境变量），所以这个参数必须与它指向同一个库，否则「指名的库」是句空话。
  // 只比 主机:端口/库名，不打印口令。
  const want = new URL(dbArg);
  const have = new URL(config.databaseUrl);
  if (want.host !== have.host || want.pathname !== have.pathname) {
    console.error(`--database-url 与环境里的 DATABASE_URL 不是同一个库：${want.host}${want.pathname} vs ${have.host}${have.pathname}`);
    process.exit(2);
  }
}
const backupArg = args.find((a) => a.startsWith("--backup="))?.slice("--backup=".length);
if (!backupArg) {
  console.error("要 --backup=…（strip-body-boilerplate.ts 写库前留下的 .jsonl，相对路径按 .data 解释）");
  process.exit(2);
}
const file = path.isAbsolute(backupArg) ? backupArg : path.join(config.dataDir, backupArg);
const wantState = args.find((a) => a.startsWith("--state="))?.slice("--state=".length) ?? "pending";
if (wantState !== "pending" && wantState !== "washed") {
  console.error("--state 只认 pending（被洗成没正文）或 washed（正文被改坏、还在库里）");
  process.exit(2);
}

const records: BackupRecord[] = [];
let broken = 0;
readFileSync(file, "utf8")
  .split("\n")
  .forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line) as BackupRecord);
    } catch {
      broken += 1;
      if (broken <= 3) console.error(`第 ${i + 1} 行不是合法 JSON 记录，跳过`);
    }
  });
const withText = records.filter((r) => r.body_text);
console.log(`备份 ${file}\n记录 ${records.length} 条（无法解析 ${broken} 条，本来就没有正文 ${records.length - withText.length} 条）`);
if (records.length === 0) {
  // 一条都没读出来 = 文件不是逐行 JSONL（2026-10-06 03:09 那份就是这样被拼成一行的）。
  // 继续跑会打印「需要还原 0 条」、退出码 0，看起来像成功——那正是这个脚本存在的理由被静默跳过。
  console.error("备份里一条记录都没有：确认这是 strip-body-boilerplate.ts 写的 .jsonl（一行一条），不做空还原。");
  process.exit(2);
}
if (apply && broken > 0) {
  console.error(`备份有 ${broken} 行解析不了；--apply 拒绝在有缺口的文件上跑（先修文件，或明确知道缺的是哪几条）。`);
  process.exit(2);
}

const state = await sql<{ id: string; source_id: string; body_status: string; revision: number; body_text: string | null }[]>`
  SELECT id, source_id, body_status, revision, body_text
  FROM articles WHERE id = ANY(${records.map((r) => r.id)})`;
const current = new Map(state.map((s) => [s.id, s]));
const bySource: Record<string, number> = {};
const stuck: BackupRecord[] = [];
for (const r of records) {
  const s = current.get(r.id);
  if (!s || !r.body_text) continue;
  // pending：被洗成「没有正文」的行（第二十九轮那次的形状）。
  // washed：正文还在、内容却不是备份那一份，而且行只被那次洗动过一次（revision 恰好 +1）——
  //         用来撤销「规则本身写错」的那次清洗：先还原，再用改好的规则重洗。
  const hit = wantState === "pending"
    ? s.body_status === "pending" && s.body_text === null
    : s.body_text !== null && s.body_text !== r.body_text && s.revision === r.revision + 1;
  if (!hit) continue;
  stuck.push(r);
  bySource[s.source_id] = (bySource[s.source_id] ?? 0) + 1;
}
console.log(`\n状态判据 --state=${wantState}：需要还原 ${stuck.length} 条，其余 ${state.length - stuck.length} 条不满足条件（不覆盖）`);
for (const [id, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${id}: ${n} 条`);

if (!apply) {
  console.log(`\nDRY-RUN：没有写库。要还原 ${stuck.length} 条并重算 ${Object.keys(bySource).length} 个信源的 publication。`);
  await closeDb();
  process.exit(0);
}

let restored = 0;
for (const r of stuck) {
  const [got] = await sql<{ id: string }[]>`
    UPDATE articles
    SET body_text = ${r.body_text}, body_html = ${r.body_html}, body_status = 'ok',
        content_hash = coalesce((SELECT rev.content_hash FROM article_revisions rev
                                  WHERE rev.article_id = ${r.id} AND rev.revision = ${r.revision}), content_hash),
        updated_at = now()
    WHERE id = ${r.id} AND revision = ${r.revision + 1} AND body_text IS DISTINCT FROM ${r.body_text}
    RETURNING id`;
  if (got) restored += 1;
}
console.log(`\n已还原 ${restored} 条正文。重算 publication（不花模型额度）：`);
for (const sourceId of Object.keys(bySource)) {
  const r = await republishSource(sourceId);
  console.log(`  ${sourceId}: 重算 ${r.total} 条，其中有变化 ${r.changed} 条`);
}
await closeDb();
