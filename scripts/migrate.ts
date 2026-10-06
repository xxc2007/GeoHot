// Applies database/migrations/*.sql in order, each in its own transaction. Safe to re-run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const dir = path.join(REPO_ROOT, "database/migrations");

// `npm run db:migrate` 用的是 `--env-file-if-exists=.env`：没有 .env（或读不到）时它不报错，于是
// config 的默认串 `postgres://127.0.0.1:5432/aihot` 生效——那是生产集群的端口、上游项目的库名。
// 结果是脚本在别人家的库上建表，还打印 "N migration(s) applied" 并 exit 0。迁移必须说得清自己改的是
// 哪个库；说不清就不动。测试与 CI 一律显式给 DATABASE_URL（库名必须 _test/_ci 结尾），不受影响。
if (!process.env.DATABASE_URL && !process.argv.includes("--allow-default-db")) {
  console.error(
    "DATABASE_URL 没有从环境里给出来（.env 缺失或不可读？）。默认值 postgres://127.0.0.1:5432/aihot 不是本项目的开发库，拒绝带着它迁移。\n" +
      "正常做法：npm run env:init 生成 .env，或显式 DATABASE_URL=… npm run db:migrate；确认默认串就是目标库才加 --allow-default-db。",
  );
  process.exit(1);
}

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const text = readFileSync(path.join(dir, file), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`applied ${file}`);
  count += 1;
}
console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
await closeDb();
