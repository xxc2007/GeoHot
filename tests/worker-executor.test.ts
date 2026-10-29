import { gate, tag, within } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PgBoss } from "pg-boss";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { bossOptions } from "@aihot/backend/jobs/worker-role";

const key = `executor-${tag()}`;
const assistDirectory = mkdtempSync(path.join(tmpdir(), "geohot-assist-test-"));
const assistLease = path.join(assistDirectory, "lease.json");
const children: ChildProcess[] = [];
const entered = gate();
const finish = gate();
const pageEntered = gate(), pageFinish = gate();
const pageText = "Field observations describe river discharge, sediment transport, and vegetation recovery after seasonal flooding. ".repeat(20) + "Article final reference marker.";
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith("pc-html")) {
    pageEntered.open(); await pageFinish.promise;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Field observation report</title></head><body><article><h1>Field observation report</h1><p>${pageText}</p></article></body></html>`);
    return;
  }
  entered.open();
  await finish.promise;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"label":"BLOCK","reason":"local test"}' } }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const provider = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const exits = new Map<ChildProcess, Promise<number | null>>();
async function start(role: string, disconnectBeforeReady: boolean | "blocked-startup" = false, allowTestFetch = false) {
  writeFileSync(assistLease, JSON.stringify({ at: Date.now(), onAC: true, localFreeMiB: 3000, remoteFreeMiB: 140,
    memoryFull: 0, ioFull: 0, apiHealthy: true, workerAll: true, sourceMatches: true, maintenance: false, r115: false }));
  const child = spawn(process.execPath, ["apps/worker/src/main.ts"], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Deliberately do not inherit user model credentials or load any env files.
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "development", AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials",
      WORKER_ROLE: role, MODEL_CALLS_ENABLED: role === "content-executor" ? "true" : "false",
      JINA_BODY_FALLBACK: "false",
      COLLECT_ENABLED: role.endsWith("-executor") ? "true" : "false", DATABASE_POOL_MAX: "1", PGBOSS_POOL_MAX: "1",
      EXTRACT_CONCURRENCY: "1", GEOHOT_ASSIST_LEASE_FILE: assistLease,
      ALLOW_PRIVATE_NETWORK_FETCH: allowTestFetch ? "true" : "false",
      LLM_BASE_URL: `${provider}/v1`, LLM_API_KEY: "local-test-key", LLM_MODEL: "local-stub", PREFILTER_MODEL: "default",
      FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", AIHOT_RELEASE: key },
  });
  children.push(child);
  exits.set(child, new Promise((resolve) => child.once("exit", resolve)));
  if (disconnectBeforeReady) {
    child.stdout!.resume(); child.stderr!.resume();
    if (disconnectBeforeReady === "blocked-startup") {
      await within((async () => {
        while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE application_name='aihot-jobs-content-executor' AND wait_event_type='Lock' LIMIT 1`)[0]) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(), 5000);
    }
    child.disconnect(); return child;
  }
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
  pageFinish.open();
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all([...exits.values()]);
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id=${key})`;
  await sql`DELETE FROM receipts WHERE subject IN (SELECT 'article:' || id || '@1' FROM articles WHERE source_id=${key})`;
  await sql`DELETE FROM articles WHERE source_id=${key}`;
  await sql`DELETE FROM sources WHERE id=${key}`;
  await sql`DELETE FROM settings WHERE key IN ('heartbeat.worker','heartbeat.content-executor','heartbeat.extraction-executor') AND value->>'release'=${key}`;
  await stopBoss(); await closeDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(assistDirectory, { recursive: true });
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

test("losing launcher IPC before READY cannot leave an unmanaged executor running", async () => {
  const executor = await start("content-executor", true);
  assert.equal(await within(exits.get(executor)!, 5000), 0);
});

test("losing launcher IPC during a blocked schema check drains before registering consumers", async () => {
  const locked = gate(), unlock = gate();
  const holding = sql.begin(async (tx) => {
    await tx`LOCK TABLE pgboss.version IN ACCESS EXCLUSIVE MODE`;
    locked.open();
    await unlock.promise;
  });
  let executor: ChildProcess | undefined;
  try {
    await within(locked.promise, 2000);
    executor = await start("content-executor", "blocked-startup");
  } finally {
    unlock.open(); await holding;
  }
  assert.equal(await within(exits.get(executor!)!, 5000), 0);
});

test("public extraction helper leaves X and analysis on the server, with no provider receipt or schedule changes", async () => {
  const boss = await getBoss();
  const normal = await upsertMaterial({ sourceId: key, url: `${provider}/${key}-public`, title: key,
    bodyText: "Existing complete body. ".repeat(30), bodyStatus: "ok", via: "import", backfill: "archive" });
  const social = await upsertMaterial({ sourceId: key, url: `${provider}/${key}-social`, title: key,
    bodyText: "Original social post. ".repeat(30), bodyStatus: "ok", via: "import", backfill: "archive" });
  await sql`UPDATE articles SET x_post=${sql.json({ tweetId: "assist-no-paid-fetch" })} WHERE id=${social.articleId}`;
  const xJob = await boss.send("content.extract-body", { articleId: social.articleId }, { singletonKey: social.articleId, priority: 1000 });
  const normalJob = await boss.send("content.extract-body", { articleId: normal.articleId }, { singletonKey: normal.articleId });
  const schedules = await sql`SELECT name,cron FROM pgboss.schedule ORDER BY name`;
  const executor = await start("extraction-executor");
  try {
    await within((async () => {
      while ((await sql`SELECT state FROM pgboss.job WHERE id=${normalJob}`)[0]?.state !== "completed") await new Promise(resolve => setTimeout(resolve, 30));
    })(), 5000);
    assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${xJob}`)[0]?.state, "created");
    assert.equal((await sql`SELECT state FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${normal.articleId}`)[0]?.state, "created");
    assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE subject LIKE ${`article:${normal.articleId}%`} OR subject LIKE ${`article:${social.articleId}%`}`)[0]?.n, 0);
    assert.deepEqual(await sql`SELECT name,cron FROM pgboss.schedule ORDER BY name`, schedules);
  } finally {
    executor.send({ type: "geohot:shutdown" });
    assert.equal(await within(exits.get(executor)!, 3000), 0);
  }
});

test("PC fetch failure keeps pending body and attempts, and hands the fallback back to the server once", async () => {
  const boss = await getBoss();
  const material = await upsertMaterial({ sourceId: key, url: `${provider}/${key}-pc-failure`, title: key,
    bodyText: "", bodyStatus: "pending", via: "import", backfill: "archive" });
  const initialJob = await boss.send("content.extract-body", { articleId: material.articleId }, { singletonKey: material.articleId });
  const executor = await start("extraction-executor");
  try {
    await within((async () => {
      while ((await sql`SELECT state FROM pgboss.job WHERE id=${initialJob}`)[0]?.state !== "completed") await new Promise(resolve => setTimeout(resolve, 30));
    })(), 5000);
    const [article] = await sql`SELECT body_status,processing_attempts FROM articles WHERE id=${material.articleId}`;
    assert.equal(article.body_status, "pending");
    assert.equal(article.processing_attempts, 0);
    const pending = await sql`SELECT state,data FROM pgboss.job WHERE name='content.extract-body' AND data->>'articleId'=${material.articleId} AND state < 'active'`;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].data.serverOnly, true);
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal((await sql`SELECT state FROM pgboss.job WHERE name='content.extract-body' AND data->>'articleId'=${material.articleId} AND data->>'serverOnly'='true'`)[0]?.state, "created");
    assert.equal((await sql`SELECT count(*)::int n FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${material.articleId}`)[0]?.n, 0);
    assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE subject LIKE ${`article:${material.articleId}%`}`)[0]?.n, 0);
  } finally {
    executor.send({ type: "geohot:shutdown" });
    assert.equal(await within(exits.get(executor)!, 3000), 0);
  }
});

test("a real public-page extraction saves its tail and can finish after lease revocation without claiming another job", async () => {
  const boss = await getBoss();
  const material = await upsertMaterial({ sourceId: key, url: `${provider}/${key}-pc-html`, title: key,
    bodyText: "", bodyStatus: "pending", via: "import", backfill: "archive" });
  const job = await boss.send("content.extract-body", { articleId: material.articleId }, { singletonKey: material.articleId });
  const executor = await start("extraction-executor", false, true); // Local fixture only; production forbids private fetch.
  try {
    await within(pageEntered.promise, 5000);
    writeFileSync(assistLease, "{}");
    const next = await upsertMaterial({ sourceId: key, url: `${provider}/${key}-after-revoke`, title: key,
      bodyText: "Existing body. ".repeat(30), bodyStatus: "ok", via: "import", backfill: "archive" });
    const nextJob = await boss.send("content.extract-body", { articleId: next.articleId }, { singletonKey: next.articleId });
    pageFinish.open();
    await within((async () => {
      while ((await sql`SELECT state FROM pgboss.job WHERE id=${job}`)[0]?.state !== "completed") await new Promise(resolve => setTimeout(resolve, 30));
    })(), 5000);
    assert.match((await sql`SELECT body_text FROM articles WHERE id=${material.articleId}`)[0]?.body_text, /Article final reference marker\./);
    assert.equal((await sql`SELECT body_status FROM articles WHERE id=${material.articleId}`)[0]?.body_status, "ok");
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal((await sql`SELECT state FROM pgboss.job WHERE id=${nextJob}`)[0]?.state, "created");
  } finally {
    pageFinish.open(); executor.send({ type: "geohot:shutdown" });
    assert.equal(await within(exits.get(executor)!, 3000), 0);
  }
});
