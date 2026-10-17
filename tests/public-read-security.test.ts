import "./setup.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordWindow } from "@aihot/backend/lib/password-window";
import { PublicReadBusyError, withPublicRead } from "@aihot/backend/publication/read-budget";
import { siteHandler } from "../apps/api/src/routes/site.ts";
import { registerAdminAuth } from "../apps/api/src/routes/admin-auth.ts";
import { gate } from "./setup.ts";

after(closeDb);

test("password attempts retain the exact sliding-window decisions with at most 51 events", () => {
  const window = passwordWindow();
  const reference: Array<{ at: number; ip: string }> = [];
  for (let i = 0; i < 10000; i++) {
    const now = i * 211;
    const ip = i % 3 ? `rotating-${i}` : "same-client";
    while (reference.length && now - reference[0]!.at >= 900000) reference.shift();
    reference.push({ at: now, ip });
    const rejected = reference.length > 50 || reference.filter((e) => e.ip === ip).length > 10;
    assert.equal(window.reject(ip, now), rejected);
    assert.ok(window.retained <= 51);
  }
});

test("password boundaries and rejected attempts preserve cooldown", () => {
  const perIp = passwordWindow();
  for (let i = 0; i < 10; i++) assert.equal(perIp.reject("one", 0), false);
  assert.equal(perIp.reject("one", 0), true);
  assert.equal(perIp.reject("one", 899999), true);
  assert.equal(perIp.reject("one", 900000), false);
  const global = passwordWindow();
  for (let i = 0; i < 50; i++) assert.equal(global.reject(String(i), 0), false);
  for (let i = 0; i < 100; i++) assert.equal(global.reject(`burst-${i}`, 899999), true);
  assert.equal(global.reject("new", 900000), true, "rejected traffic still extends the global window");
  assert.equal(global.reject("new", 1800000), false);
});

test("wrong-password HTTP traffic is still throttled with uncached redirect", async () => {
  const app = Fastify();
  registerAdminAuth(app);
  try {
    let response;
    for (let i = 0; i < 11; i++) response = await app.inject({ method: "POST", url: "/api/auth/password", payload: { password: "", return: "/admin" } });
    assert.equal(response!.statusCode, 303);
    assert.match(response!.headers.location!, /error=too-many/);
    assert.equal(response!.headers["cache-control"], "no-store");
  } finally { await app.close(); }
});

test("public aggregates reject excess work, return retryable no-store HTTP, and recover", async () => {
  const hold = gate();
  const both = gate();
  let active = 0;
  const read = () => withPublicRead(async () => { if (++active === 2) both.open(); await hold.promise; return 1; });
  const first = read(); const second = read();
  await both.promise;
  const app = Fastify();
  app.get("/busy", siteHandler(async () => withPublicRead(async () => 3)));
  try {
    await assert.rejects(read(), PublicReadBusyError);
    const response = await app.inject("/busy");
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["retry-after"], "2");
  } finally { hold.open(); await Promise.all([first, second]); await app.close(); }
  assert.equal(await withPublicRead(async () => 4), 4);
});

test("database cancels a slow aggregate, rolls it back and does not leak its timeout", async () => {
  await assert.rejects(withPublicRead(async (db) => { await db`SELECT pg_sleep(2)`; }, 40), PublicReadBusyError);
  assert.equal(await withPublicRead(async (db) => { await db`SELECT pg_sleep(0.06)`; return 1; }), 1);
  const [row] = await sql`SHOW statement_timeout`;
  assert.equal(row!.statement_timeout, "0");
  await assert.rejects(withPublicRead(async () => { throw new Error("ordinary failure"); }), /ordinary failure/);
  assert.equal(await withPublicRead(async () => 2), 2);
});
