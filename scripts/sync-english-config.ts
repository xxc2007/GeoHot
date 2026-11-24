// 一次性补录：把行业包里的英文列写进**已经在库里**的 topics / sources 行。
//
// 为什么需要它：库里的英文列（0128 的 topics.name_en / topics.definition_en / sources.name_en）
// 只有两条常规入口，而两条都补不到"行已存在、英文为空"这种情况：
//   · `scripts/seed.ts` 的 topics 走 `seedTopics()`，会写英文，但它同时重排 position、覆盖
//     name/definition/tags/related——在已经跑着的生产库上，为补英文顺手跑它是不该做的；
//     sources 那条（2026-11-24 起）也只补 name_en，其余列仍然"只增不改"；
//   · `scripts/sync-source-config.ts` 会推 sources.name_en，但它是"配置同步"：一并推 config /
//     tier / site_fulltext，那是另一件事，不该被一次补英文带着做决定。
// 结果就是那组数：包里 43 个主题、668 条信源都有英文，库里几乎全空——不是翻译缺失，
// 是没有入库路径。本脚本只补英文列，一个事务，可重复跑。
//
// 三条不变量：
//   1. 只写英文列，中文 name/definition 与其它字段一个字节都不动；
//   2. 只在"包里有值且与库里不同"时写——值已经一样就不发 UPDATE（免得白刷 updated_at）；
//   3. 包里没有英文、库里却有时**不清空**（那可能是人工补写的，与 seed 的"只增不改"同一条理由）。
//
// 默认 DRY-RUN，只打印计划；要写必须同时给 --apply 与 --database-url=…（或
// --database-url-env=DATABASE_URL），且那个地址必须与进程环境的 DATABASE_URL 是同一个
// 主机:端口/库名——backend 的池只读环境变量，参数本身不决定连哪儿，它是"核对"不是"连接"。
//
//   node --env-file=.env scripts/sync-english-config.ts --dry-run
//   node --env-file=.env scripts/sync-english-config.ts --apply --database-url-env=DATABASE_URL
//   node --env-file=.env scripts/sync-english-config.ts --only=topics
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const options = { apply: false, only: "all" as "all" | "topics" | "sources", "database-url": "", "database-url-env": "" };
const usage = "可用：--dry-run --apply --only=all|topics|sources --database-url=… --database-url-env=DATABASE_URL";
for (const flag of process.argv.slice(2)) {
  if (flag === "--apply") { options.apply = true; continue; }
  // 显式写 --dry-run 与不写等价；有它是因为"默认 dry-run"这件事要靠读源码才知道，命令行上说得出来更好。
  if (flag === "--dry-run") { options.apply = false; continue; }
  if (flag.startsWith("--database-url=")) { options["database-url"] = flag.slice("--database-url=".length); continue; }
  if (flag.startsWith("--database-url-env=")) { options["database-url-env"] = flag.slice("--database-url-env=".length); continue; }
  if (flag.startsWith("--only=")) {
    const only = flag.slice("--only=".length);
    if (only !== "all" && only !== "topics" && only !== "sources") { console.error(`--only 只接受 all/topics/sources（收到 ${only}）`); process.exit(2); }
    options.only = only;
    continue;
  }
  console.error(`未知参数：${flag}（${usage}）`);
  process.exit(2);
}
// `--database-url-env=DATABASE_URL` 是 `--database-url=` 的不泄露替代品（同 sync-source-config.ts）：
// 生产 DSN 里有口令，抄上命令行就等于抄进 ps、shell 历史与 argv。这里只要"操作者确认写的就是环境里那个库"。
if (options["database-url-env"] && (options["database-url-env"] !== "DATABASE_URL" || options["database-url"])) {
  console.error("--database-url-env 仅接受 DATABASE_URL，且与 --database-url 互斥");
  process.exit(2);
}
const target = String(process.env.DATABASE_URL ?? "");
const key = (u: string) => u.replace(/^[^:]+:\/\//, "").replace(/^[^@]*@/, "").replace(/\?.*$/, "");
if (!options.apply) {
  console.log("DRY-RUN：只打印计划，不写库。要写入请加 --apply 与 --database-url=<与环境同一个地址>（或用 --database-url-env=DATABASE_URL）");
} else if (!options["database-url"] && !options["database-url-env"]) {
  console.error("--apply 必须同时显式给出 --database-url= 或 --database-url-env=DATABASE_URL");
  // 必须当场退出，不能只设 exitCode：护栏没过时若继续往下跑，`apply` 分支会照写不误。
  await closeDb();
  process.exit(2);
} else if (options["database-url"] && key(options["database-url"]) !== key(target)) {
  console.error(`--database-url 指向 ${key(options["database-url"])}，而进程环境连的是 ${key(target)}——拒写。`);
  await closeDb();
  process.exit(2);
}

interface PackTopic {
  slug: string;
  name: string;
  nameEn?: string;
  definition: string;
  definitionEn?: string;
}
interface PackSource {
  id: string;
  name: string;
  nameEn?: string;
}

const packTopics = (JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as { topics: PackTopic[] }).topics;
// 组（groups）的英文不走库：`topicGroups()` 每次直接读 JSON（publication/topics.ts:164），没有列可补。
const packSources = (JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: PackSource[] }).sources;

const topicRows = await sql<{ slug: string; name_en: string | null; definition_en: string | null }[]>`
  SELECT slug, name_en, definition_en FROM topics`;
const sourceRows = await sql<{ id: string; name_en: string | null }[]>`SELECT id, name_en FROM sources`;
const topicBySlug = new Map(topicRows.map((r) => [r.slug, r]));
const sourceById = new Map(sourceRows.map((r) => [r.id, r]));

interface TopicWrite { slug: string; nameEn: string | null; definitionEn: string | null }
interface SourceWrite { id: string; nameEn: string }
const topicWrites: TopicWrite[] = [];
const sourceWrites: SourceWrite[] = [];
const missingTopics: string[] = [];
const missingSources: string[] = [];

if (options.only !== "sources") {
  for (const t of packTopics) {
    const row = topicBySlug.get(t.slug);
    if (!row) { missingTopics.push(t.slug); continue; }
    const nameEn = t.nameEn?.trim() || null;
    const definitionEn = t.definitionEn?.trim() || null;
    // 包里没值 → 不写（保留库里可能由人工补写的那份）；有值但一致 → 不写（免得白刷一行）。
    const nextName = nameEn !== null && nameEn !== row.name_en ? nameEn : null;
    const nextDefinition = definitionEn !== null && definitionEn !== row.definition_en ? definitionEn : null;
    if (nextName === null && nextDefinition === null) continue;
    const diff: string[] = [];
    if (nextName !== null) diff.push(`name_en ${row.name_en ?? "null"} → ${nextName}`);
    // 英文说明是一整段：只报新旧长度，不把整段倒进终端（DRY-RUN 是给人看的，不是日志转储）。
    if (nextDefinition !== null) {
      diff.push(row.definition_en === null
        ? `definition_en 补空（${nextDefinition.length} 字符）`
        : `definition_en 改写（${row.definition_en.length} → ${nextDefinition.length} 字符）`);
    }
    topicWrites.push({ slug: t.slug, nameEn: nextName, definitionEn: nextDefinition });
    console.log(`${options.apply ? "写入" : "将改"} topic ${t.slug}: ${diff.join(", ")}`);
  }
}

if (options.only !== "topics") {
  for (const s of packSources) {
    const row = sourceById.get(s.id);
    if (!row) { missingSources.push(s.id); continue; }
    const nameEn = s.nameEn?.trim() || null;
    if (nameEn === null || nameEn === row.name_en) continue;
    sourceWrites.push({ id: s.id, nameEn });
    console.log(`${options.apply ? "写入" : "将改"} source ${s.id}: name_en ${row.name_en ?? "null"} → ${nameEn}`);
  }
}

// 库里多出来的行不是本脚本的事：主题那几行可能来自迁移 0130（不在 JSON 里的早期主题），
// 信源可能是 ingest 自动建的。这里只报数，不删不改。
const packTopicSlugs = new Set(packTopics.map((t) => t.slug));
const packSourceIds = new Set(packSources.map((s) => s.id));
const extraTopics = topicRows.filter((r) => !packTopicSlugs.has(r.slug)).length;
const extraSources = sourceRows.filter((r) => !packSourceIds.has(r.id)).length;

if (options.only !== "sources") {
  console.log(`topics：${topicWrites.length} 条待改（比对 ${packTopics.length} 条）；库里没有 ${missingTopics.length} 条${missingTopics.length ? `（${missingTopics.join(", ")}）` : ""}；包里没有的多余行 ${extraTopics} 条（不动）`);
}
if (options.only !== "topics") {
  console.log(`sources：${sourceWrites.length} 条待改（比对 ${packSources.length} 条）；库里没有 ${missingSources.length} 条${missingSources.length ? `（${missingSources.slice(0, 10).join(", ")}${missingSources.length > 10 ? " …" : ""}）` : ""}；包里没有的多余行 ${extraSources} 条（不动）`);
}

if (options.apply && (topicWrites.length || sourceWrites.length)) {
  // 一个事务写完：中途失败不留"写了一半的主题"这种状态。topics 没有 updated_at（也没有触发器），
  // sources 有 updated_at，且 review_version 触发器的判据（0072）里不含 name_en，所以这里既不会把
  // 信源推回"待复核"，也不会动调度器认的那几列。
  await sql.begin(async (tx) => {
    for (const w of topicWrites) {
      await tx`UPDATE topics SET name_en = coalesce(${w.nameEn}, name_en),
                                   definition_en = coalesce(${w.definitionEn}, definition_en)
                 WHERE slug = ${w.slug}`;
    }
    for (const w of sourceWrites) {
      await tx`UPDATE sources SET name_en = ${w.nameEn}, updated_at = now() WHERE id = ${w.id}`;
    }
  });
  console.log(`已写入：topics ${topicWrites.length} 条、sources ${sourceWrites.length} 条`);
}

await closeDb();