// 把信源包里已经改过的 config / tier / interval / defaultCategory 推到库里去。
//
// 为什么需要它：`scripts/seed.ts` 是 `ON CONFLICT (id) DO NOTHING`——**只增不改**，那是有意的
// （后台里人工改过的东西不能被一次 seed 抹掉）。后果是包里的 config 改了、生产库不会跟着变：
// 2026-10-08 这一轮就是——PNAS 的噪声词与九个目录源的抓取节奏改完上线，库里还是旧的那份，
// 于是"改好了"其实只是"改在文件里"。
//
// 默认 DRY-RUN，只打印将要改什么；真要写必须同时给 --apply 和 --database-url，而且那个地址
// 必须与进程环境里的 DATABASE_URL 指向同一个 主机:端口/库名（backend 的池只读环境变量，
// 参数本身不决定连哪儿——它是"核对"，不是"连接"）。
// 本脚本**不碰 enabled**：开停信源是 scripts/set-source-state.ts 的职责，两件事各自可审计。
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

const options = { apply: false, "database-url": "", ids: "" };
const flags = process.argv.slice(2);
for (const flag of flags) {
  if (flag === "--apply") { options.apply = true; continue; }
  const url = /^--database-url=(.+)$/.exec(flag);
  if (url) { options["database-url"] = url[1]!; continue; }
  const ids = /^--ids=(.+)$/.exec(flag);
  // 只推指定的几条：库里可能有别的信源被人工改过（例如噪声词），一次全推等于替那些改动做决定。
  if (ids) { options.ids = ids[1]!; continue; }
  console.error(`未知参数：${flag}（可用：--apply --database-url=… --ids=a,b）`);
  process.exit(2);
}
const only = options.ids ? new Set(options.ids.split(",").map((s) => s.trim()).filter(Boolean)) : null;

const target = String(process.env.DATABASE_URL ?? "");
const key = (u: string) => u.replace(/^[^:]+:\/\//, "").replace(/^[^@]*@/, "").replace(/\?.*$/, "");
if (!options.apply) {
  console.log("DRY-RUN：只打印差异。要写入数据库请加 --apply --database-url=<与环境 DATABASE_URL 同一个地址>");
} else if (!options["database-url"]) {
  console.error("--apply 必须同时显式给出 --database-url=");
  process.exitCode = 2;
  await closeDb();
} else if (key(options["database-url"]) !== key(target)) {
  console.error(`--database-url 指向 ${key(options["database-url"])}，而进程环境连的是 ${key(target)}——拒写。`);
  process.exitCode = 2;
  await closeDb();
}

interface PackSource {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  tier?: string;
  interval_minutes?: number;
  defaultCategory?: string;
}

/**
 * 语义比较，不是字节比较：库里存的是 JSONB，键序与输入无关（`{"a":1,"b":2}` 读回来可能是
 * `{"b":2,"a":1}`），直接 `JSON.stringify` 对比会让 105 条里的 82 条都"有差异"。
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

const pack: PackSource[] = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")).sources;
const wanted = new Map(pack.filter((s) => s.kind !== "external").map((s) => [s.id, s]));

const rows = await sql<{ id: string; kind: string; config: Record<string, unknown>; tier: string; interval_minutes: number; default_category: string | null }[]>`
  SELECT id, kind, config, tier, interval_minutes, default_category FROM sources`;
const byId = new Map(rows.map((r) => [r.id, r]));

let changed = 0;
for (const [id, s] of wanted) {
  if (only && !only.has(id)) continue;
  const row = byId.get(id);
  if (!row) { console.log(`· ${id}：库里没有这一条（seed.ts 会补，本脚本不建）`); continue; }
  assertSupportedConfig(row.kind as never, s.config);
  const diff: string[] = [];
  if (canonical(row.config ?? {}) !== canonical(s.config)) {
    // 说清改的是哪几项，而不是只报"config 不一样"：运营要能在 DRY-RUN 里看出这一条会不会动到 URL。
    const keys = new Set([...Object.keys(row.config ?? {}), ...Object.keys(s.config)]);
    const moved = [...keys].filter((k) => canonical((row.config ?? {})[k]) !== canonical(s.config[k]));
    diff.push(`config: ${moved.join(", ")}`);
  }
  if (row.tier !== (s.tier ?? "T2")) diff.push(`tier ${row.tier} → ${s.tier ?? "T2"}`);
  if (row.default_category !== (s.defaultCategory ?? null)) {
    // 包里没声明、库里却有值：那多半是后台里人工选的默认分类，**不清空**（seed.ts 的"只增不改"
    // 守的就是这件事）。要真的取消一个默认分类，去后台改，别用这个脚本反着推。
    if (s.defaultCategory === undefined && row.default_category !== null) {
      console.log(`· ${id}: 库里 default_category=${row.default_category}，包里没声明——保持不动`);
    } else {
      diff.push(`defaultCategory ${row.default_category} → ${s.defaultCategory ?? null}`);
    }
  }
  // interval_minutes 单独比：库里那个数会被 adaptIntervals 按流量改写，包里的值是"人工定的上限"。
  // 只有当包声明 intervalMinutesLocked 时才把库里的数拨回去，否则等于覆盖调度器的判断。
  const locked = (s.config._aihot as { intervalMinutesLocked?: boolean } | undefined)?.intervalMinutesLocked === true;
  if (locked && row.interval_minutes !== s.interval_minutes) diff.push(`interval ${row.interval_minutes} → ${s.interval_minutes}（locked）`);
  if (diff.length === 0) continue;
  changed++;
  console.log(`${options.apply ? "写入" : "将改"} ${id}: ${diff.join(", ")}`);
  if (options.apply) {
    await sql`UPDATE sources SET config = ${sql.json(s.config as never)}, tier = ${s.tier ?? "T2"},
                 default_category = ${s.defaultCategory ?? row.default_category},
                 interval_minutes = ${locked ? (s.interval_minutes ?? row.interval_minutes) : row.interval_minutes},
                 updated_at = now()
               WHERE id = ${id}`;
  }
}
console.log(`${options.apply ? "已写入" : "差异"}：${changed} 条信源（共比对 ${wanted.size} 条）`);
await closeDb();
