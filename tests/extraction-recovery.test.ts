import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import type { PgBoss } from "pg-boss";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { registerExtractionJobs } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";
import { releaseReceipt } from "@aihot/backend/admin/runs";

const source = `extract-recovery-${tag()}`;
let loseJina = false;
const server = http.createServer((req, res) => {
  if (loseJina && req.url?.startsWith("/http")) { res.destroy(); return; }
  res.writeHead(404); res.end("no page");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.JINA_BASE_URL = base;
process.env.JINA_API_KEY = "local-test-key";
process.env.JINA_BODY_FALLBACK = "true";
config.allowPrivateNetworkFetch = true;
let handler: (jobs: Array<{ data: { articleId: string } }>) => Promise<unknown>;
let previous: Array<{ per_minute: number; per_hour: number; per_day: number }>;
const ids: string[] = [];

before(async () => {
  previous = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='jina'`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},${source},'rss','T1','editorial')`;
  const capture = { work: async (_name: string, _opts: unknown, fn: typeof handler) => { handler = fn; } };
  await registerExtractionJobs(capture as unknown as PgBoss);
});
after(async () => {
  await sql`DELETE FROM audit_log WHERE subject IN (SELECT 'receipt:' || id FROM receipts WHERE subject=ANY(${ids.map((id) => `article:${id}`)}))`;
  await sql`DELETE FROM receipts WHERE subject=ANY(${ids.map((id) => `article:${id}`)})`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids})`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  if (previous[0]) await sql`UPDATE budgets SET per_minute=${previous[0].per_minute},per_hour=${previous[0].per_hour},per_day=${previous[0].per_day} WHERE service='jina'`;
  await stopBoss(); await closeDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function article() {
  const url = `${base}/${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId: source, url, title: source, bodyStatus: "pending", via: "import", backfill: "archive" });
  ids.push(articleId);
  const req = { service: "jina", model: null, purpose: "body_fallback", subject: `article:${articleId}`,
    identity: { url, day: new Date().toISOString().slice(0, 10), format: "markdown" } };
  return { id: articleId, req };
}
async function row(id: string) {
  return (await sql`SELECT body_status,processing_state,processing_attempts,processing_retry_at FROM articles WHERE id=${id}`)[0]!;
}

test("budget waits never exhaust the three real extraction failures", async () => {
  await sql`UPDATE budgets SET per_minute=0 WHERE service='jina'`;
  const { id } = await article();
  for (let i = 0; i < 3; i++) await handler([{ data: { articleId: id } }]);
  const a = await row(id);
  assert.equal(a.body_status, "pending");
  assert.equal(a.processing_attempts, 0);
  assert.ok(a.processing_retry_at);
});

test("another in-flight receipt makes extraction wait without consuming failures", async () => {
  const { id, req } = await article();
  await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts) VALUES(${logicalKeyFor(req)},'jina','body_fallback',${req.subject},'pending',1)`;
  for (let i = 0; i < 3; i++) await handler([{ data: { articleId: id } }]);
  assert.equal((await row(id)).body_status, "pending");
  assert.equal((await row(id)).processing_attempts, 0);
});

test("releasing a body fallback unknown requeues extraction with RSS collection off", async () => {
  await sql`UPDATE budgets SET per_minute=100,per_hour=100,per_day=100 WHERE service='jina'`;
  const { id, req } = await article();
  await assert.rejects(paidRequest(req, async () => { throw new Error("local socket lost after send"); }));
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${id}`;
  await releaseReceipt(receipt.id, { billed: false, note: "local test confirmed no charge" }, "test");
  const [queued] = await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${id} AND state='created'`;
  assert.equal(queued?.name, QUEUES.extractBody);
  assert.equal((await row(id)).processing_state, "new");
});

test("an initially lost paid extraction answer cannot exhaust the article into unconfirmed", async () => {
  const { id } = await article();
  await sql`UPDATE articles SET processing_attempts=2 WHERE id=${id}`;
  loseJina = true;
  try { await handler([{ data: { articleId: id } }]); }
  finally { loseJina = false; }
  const a = await row(id);
  assert.equal(a.body_status, "pending");
  assert.equal(a.processing_state, "failed");
  assert.equal(a.processing_attempts, 2);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`article:${id}`}`)[0]?.status, "unknown");
});
