import { gate, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { PgBoss } from "pg-boss";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { bossOptions } from "@aihot/backend/jobs/worker-role";

const key = `executor-${tag()}`;
const children: ChildProcess[] = [];
const entered = gate();
const finish = gate();
const server = http.createServer(async (_req, res) => {
  entered.open();
  await finish.promise;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"label":"BLOCK","reason":"local test"}' } }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const provider = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const exits = new Map<ChildProcess, Promise<number | null>>();
async function start(role: string) {
  const child = spawn(process.execPath, ["apps/worker/src/main.ts"], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Deliberately do not inherit user model credentials or load any env files.
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "development", AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials",
      WORKER_ROLE: role, MODEL_CALLS_ENABLED: role === "content-executor" ? "true" : "false",
      COLLECT_ENABLED: role === "content-executor" ? "true" : "false", DATABASE_POOL_MAX: "2", PGBOSS_POOL_MAX: "2",
      LLM_BASE_URL: `${provider}/v1`, LLM_API_KEY: "local-test-key", LLM_MODEL: "local-stub", PREFILTER_MODEL: "default",
      FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", AIHOT_RELEASE: key },
  });
  children.push(child);
  exits.set(child, new Promise((resolve) => child.once("exit", resolve)));
  let output = "";
  await within(new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "geohot:ready"
          && "role" in message && message.role === role) resolve();
    });
    child.once("exit", (code) => reject(new Error(`worker exited ${code}: ${output}`)));
  }), 10_000);
  return child;
}
after(async () => {
  finish.open();
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all([...exits.values()]);
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${key})`;
  await sql`DELETE FROM receipts WHERE subject IN (SELECT 'article:' || id || '@1' FROM articles WHERE source_id=${key})`;
  await sql`DELETE FROM articles WHERE source_id=${key}`;
  await sql`DELETE FROM sources WHERE id=${key}`;
  await sql`DELETE FROM settings WHERE key IN ('heartbeat.worker','heartbeat.content-executor') AND value->>'release'=${key}`;
  await stopBoss(); await closeDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("coordinator leaves analysis queued; executor consumes without touching cron and drains through Windows IPC", async () => {
  await getBoss(); // Create/check the schema before the executor's migrate:false startup.
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${key},${key},'rss','T1','editorial')`;
  const { articleId } = await upsertMaterial({ sourceId: key, url: `${provider}/${key}`, title: key,
    bodyText: "Existing abstract for the local test. ".repeat(20), bodyStatus: "ok", via: "import", backfill: "archive" });
  await queueProcessing(articleId);
  await start("coordinator");
  assert.equal((await sql`SELECT state FROM pgboss.job WHERE data->>'articleId'=${articleId}`)[0]?.state, "created");
  const schedules = await sql`SELECT name,cron FROM pgboss.schedule ORDER BY name`;
  const executor = await start("content-executor");
  await within(entered.promise, 5000);
  await within((async () => {
    while ((await sql`SELECT count(*)::int AS n FROM settings WHERE key IN ('heartbeat.worker','heartbeat.content-executor') AND value->>'release'=${key}`)[0]?.n !== 2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })(), 2000);
  assert.deepEqual(await sql`SELECT name,cron FROM pgboss.schedule ORDER BY name`, schedules);
  assert.equal((await sql`SELECT value->>'release' AS release FROM settings WHERE key='heartbeat.worker'`)[0]?.release, key);
  assert.equal((await sql`SELECT value->>'release' AS release FROM settings WHERE key='heartbeat.content-executor'`)[0]?.release, key);
  executor.send({ type: "geohot:shutdown", extra: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(executor.exitCode, null);
  executor.send({ type: "geohot:shutdown" });
  executor.send({ type: "geohot:shutdown" }); // idempotent; only one drain is allowed.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(executor.exitCode, null, "in-flight paid answer must finish before exit");
  finish.open();
  assert.equal(await within(exits.get(executor)!, 3000), 0, "IPC must reach graceful shutdown rather than requiring kill");
  const [a] = await sql`SELECT processing_state FROM articles WHERE id=${articleId}`;
  assert.equal(a.processing_state, "blocked");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${`article:${articleId}@%`} AND status IN ('pending','unknown')`)[0]?.n, 0);
});

test("executor refuses a missing queue schema instead of creating or migrating it", async () => {
  const schema = `executor_missing_${tag()}`;
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema, ...bossOptions("content-executor", "1") });
  boss.on("error", () => {});
  try { await assert.rejects(boss.start()); }
  finally { await boss.stop({ graceful: false }); }
  assert.equal((await sql`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=${schema}`)[0]?.n, 0);
});

test("losing the private launcher IPC channel drains and exits the managed executor", async () => {
  await getBoss();
  const executor = await start("content-executor");
  executor.disconnect();
  assert.equal(await within(exits.get(executor)!, 2000), 0);
});
