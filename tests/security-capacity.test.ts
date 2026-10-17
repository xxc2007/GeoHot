import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import Fastify from "fastify";
import { connect } from "node:net";
import { CapacityExceeded, CapacityGate } from "../packages/backend/src/lib/capacity.ts";

const dir = await mkdtemp(path.join(tmpdir(), "geohot-security-"));
process.env.AIHOT_DATA_DIR = dir;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
const { sql, closeDb } = await import("@aihot/backend/db");
const { registerFeedback } = await import("../apps/api/src/routes/feedback.ts");
const { produceImage } = await import("@aihot/backend/media/images");
const { admitFeedback, submitFeedback, cleanupFeedbackScreenshots, forwardPendingFeedback } = await import("@aihot/backend/operations/feedback");
const { paidRequest, BudgetExceededError, unbilledAttempt } = await import("@aihot/backend/providers/receipts");
const { releaseReceipt, autoReleaseUnknownReceipts } = await import("@aihot/backend/admin/runs");
const prefix = `security-${Date.now()}`;
after(async () => {
  await sql`DELETE FROM feedback WHERE content LIKE ${prefix + "%"}`;
  await sql`DELETE FROM receipts WHERE service LIKE ${prefix + "%"}`;
  await sql`DELETE FROM budgets WHERE service LIKE ${prefix + "%"}`;
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

test("bounded gate refuses excess work and releases slots after errors", async () => {
  const gate = new CapacityGate(1, 1);
  let open!: () => void;
  const first = gate.run(() => new Promise<void>((resolve) => { open = resolve; }));
  const second = gate.run(async () => { throw new Error("fixture failure"); });
  const rejection = assert.rejects(second, /fixture failure/);
  await assert.rejects(gate.run(async () => 3), CapacityExceeded);
  open(); await first; await rejection;
  assert.equal(await gate.run(async () => 4), 4);
});

test("many distinct slow images have bounded downloads, reject overflow, then recover", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  let active = 0, peak = 0;
  const server = createServer((_req, res) => {
    active++; peak = Math.max(peak, active);
    setTimeout(() => { active--; res.writeHead(200, { "content-type": "image/png" }); res.end(png); }, 60);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const jobs = Array.from({ length: 40 }, (_, n) => produceImage(`${base}/${n}`, "thumb"));
    const results = await Promise.allSettled(jobs);
    assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof CapacityExceeded));
    assert.ok(peak <= 4, `peak=${peak}`);
    assert.ok((await produceImage(`${base}/39`, "thumb")).body.length > 0, "capacity refusal is not negative cached");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("image overload is an uncached HTTP 503 and is retryable", async () => {
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  let open!: () => void;
  const hold = new Promise<void>((resolve) => { open = resolve; });
  const server = createServer(async (_req, res) => { await hold; res.writeHead(200, { "content-type": "image/png" }); res.end(png); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = Fastify(); registerMedia(app);
  const jobs = Array.from({ length: 24 }, (_, n) => produceImage(`${base}/${n}`, "thumb"));
  const done = Promise.allSettled(jobs);
  const url = `${base}/overflow`, exp = String(Math.floor(Date.now() / 1000) + 3600);
  const query = new URLSearchParams({ u: url, mode: "thumb", exp, sig: signature(url, "thumb", exp) });
  try {
    const busy = await app.inject({ url: `/api/img-proxy?${query}` });
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.headers["cache-control"], "no-store");
    assert.equal(busy.headers["retry-after"], "2");
    open(); await done;
    assert.equal((await app.inject({ url: `/api/img-proxy?${query}` })).statusCode, 200);
  } finally { open(); await done; await app.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("rotating User-Agent cannot reset the IP allowance; upload admission is bounded", async () => {
  for (let n = 0; n < 5; n++) await submitFeedback({ content: `${prefix} ua-${n}`, ip: "192.0.2.71", userAgent: ["Chrome", "Safari", "Firefox", "Edg", "Mobile"][n]! });
  await assert.rejects(submitFeedback({ content: `${prefix} blocked`, ip: "192.0.2.71", userAgent: "Android" }), (e: unknown) => (e as { status: number }).status === 429);
  const a = admitFeedback("192.0.2.72"), b = admitFeedback("192.0.2.73");
  try { assert.throws(() => admitFeedback("192.0.2.74"), (e: unknown) => (e as { status: number }).status === 429); }
  finally { a.release(); a.release(); b.release(); }
  admitFeedback("192.0.2.74").release();
});

test("screenshot retention runs with chat disabled and preserves shared live files", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  const folder = path.join(dir, "feedback-screenshots");
  await mkdir(folder, { recursive: true });
  const shared = "aabbcc.png", orphan = "ddeeff.png";
  const old = new Date(Date.now() - 25 * 3600_000);
  for (const name of [shared, orphan]) { await writeFile(path.join(folder, name), "fixture"); await utimes(path.join(folder, name), old, old); }
  await sql`INSERT INTO feedback(content,source_hash,screenshot_key,created_at) VALUES
    (${prefix + " old"},'test','local:aabbcc.png',${old}), (${prefix + " live"},'test','local:aabbcc.png',now())`;
  await forwardPendingFeedback();
  assert.ok(await stat(path.join(folder, shared)));
  await assert.rejects(stat(path.join(folder, orphan)), { code: "ENOENT" });
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE content=${prefix + " old"}`;
  assert.equal(row!.screenshot_key, "gone:upload");
  await sql`UPDATE feedback SET created_at=${old} WHERE content=${prefix + " live"}`;
  await cleanupFeedbackScreenshots();
  await assert.rejects(stat(path.join(folder, shared)), { code: "ENOENT" });
});

test("unknown or billed releases retain spend; only confirmed unbilled permits retry", async () => {
  for (const billed of [null, true, false]) {
    const service = `${prefix}-${billed}`;
    await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},100,1,1)`;
    const req = { service, purpose: "security_test", identity: service };
    await assert.rejects(paidRequest(req, async () => { throw new Error("lost after send"); }));
    const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE service=${service}`;
    if (billed === null) {
      await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${row!.id}`;
      await autoReleaseUnknownReceipts();
    } else await releaseReceipt(row!.id, { billed, note: "local test" }, "test");
    let calls = 0;
    const retry = () => paidRequest(req, async () => { calls++; return { response: { ok: true } }; });
    if (billed === false) { await retry(); assert.equal(calls, 1); }
    else { await assert.rejects(retry(), BudgetExceededError); assert.equal(calls, 0); }
  }
});

test("legacy released attempts and positive costs cannot disappear from spend", async () => {
  const predicate = unbilledAttempt();
  const rows = await sql`SELECT ${predicate} AS free FROM (VALUES
    ('failed',NULL::jsonb,NULL::numeric,'自动放行：结果未知'),
    ('failed',NULL::jsonb,NULL::numeric,'人工核对：供应商已计费但结果未取回'),
    ('failed',NULL::jsonb,0.1::numeric,NULL),
    ('failed',NULL::jsonb,NULL::numeric,'provider rejected')) AS a(status,usage,cost,error)`;
  assert.deepEqual(rows.map((r) => r.free), [false, false, false, true]);
});

test("partial request bodies expire and release upload capacity", async () => {
  const app = Fastify();
  registerFeedback(app, 250);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const sockets = [connect(port, "127.0.0.1"), connect(port, "127.0.0.1")];
  try {
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      socket.on("error", () => {});
      socket.once("connect", () => { socket.write("POST /api/site/feedback HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"); resolve(); });
    })));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blocked = await app.inject({ method: "POST", url: "/api/site/feedback", payload: { content: "" } });
    assert.equal(blocked.statusCode, 429);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recovered = await app.inject({ method: "POST", url: "/api/site/feedback", payload: { content: "" } });
    assert.equal(recovered.statusCode, 400, "invalid content reaches validation after upload deadline");
  } finally { sockets.forEach((socket) => socket.destroy()); await app.close(); }
});
