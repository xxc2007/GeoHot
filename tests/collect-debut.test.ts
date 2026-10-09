// A new source whose own filters wipe the listing must not report a healthy zero.
// Round 56 registered 95 academic sources and six of them (the Wiley journals: International Journal of
// Climatology and the four RGS-IBG titles plus WIREs Climate Change) imported nothing. The admin said
// `health: ok`, `found: 0` — the same two numbers a quiet week produces — and it took a production query
// and a read of the raw bytes to find out that the listing had offered 92, 13, 9, 5, 5 and 2 items and
// `allowUrlPrefixes` had rejected every one, because Wiley hosts each journal on a per-society subdomain
// (rmets., rgs-ibg., wires.) rather than on onlinelibrary.wiley.com. This file pins both halves: the debut
// round says so out loud and names the hosts, and a later round that filters everything out stays a
// ordinary quiet week (a between-issues TOC legitimately holds only corrections).
import { purgeTagged, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const DEBUT = `test-debut-${T}`;
const QUIET = `test-quiet-${T}`;
const ITEM = (n: number) => `<item><title>Research article ${n} ${T}</title><link>https://rmets.onlinelibrary.example/doi/10.1002/joc.700${n}</link><description>Abstract ${n}: a new reconstruction with enough words to be a summary.</description><pubDate>Mon, 0${n} Oct 2026 08:00:00 +0000</pubDate></item>`;
const feed = `<rss version="2.0"><channel><title>Journal</title><link>https://rmets.onlinelibrary.example/</link>${[1, 2, 3].map(ITEM).join("")}</channel></rss>`;
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/rss+xml; charset=utf-8");
  res.end(feed);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/rss`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;

before(async () => {
  // Both sources allow only a host the listing never publishes, so every item is filtered out.
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${DEBUT}, ${`Debut ${T}`}, 'rss', ${sql.json({ feedUrl, allowUrlPrefixes: ["https://onlinelibrary.example/doi/"] })}, 'T1_5', 'editorial',
                    NULL, '2100-01-01'),
                   (${QUIET}, ${`Quiet ${T}`}, 'rss', ${sql.json({ feedUrl, allowUrlPrefixes: ["https://onlinelibrary.example/doi/"] })}, 'T1_5', 'editorial',
                    ${sql.json({ initializedAt: "2026-10-01T00:00:00.000Z" })}, '2100-01-01')`;
});
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  // `purgeTagged` drops the source rows, and the fetch runs go with them by cascade.
  await purgeTagged(T);
  await closeDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sourceRow = async (id: string) => (await sql<{ health: string; last_error: string }[]>`SELECT health, last_error FROM sources WHERE id = ${id}`)[0]!;

test("a debut round that filters out the whole listing fails visibly and names the hosts", async () => {
  const r = await collectSource(DEBUT, { force: true });
  assert.equal(r.status, "failed", `expected the debut to be reported as a fault, got ${JSON.stringify(r)}`);
  assert.equal(r.found, 3, "the listing really did offer three items");
  assert.match(r.error ?? "", /kept none of 3/);
  assert.match(r.error ?? "", /rmets\.onlinelibrary\.example/, "the message names the host the config should have allowed");
  const row = await sourceRow(DEBUT);
  assert.equal(row.health, "degraded", "the admin must not show this source as healthy");
  const [run] = await sql<{ status: string; found_count: number; error: string }[]>`
    SELECT status, found_count, error FROM fetch_runs WHERE source_id = ${DEBUT} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "failed");
  assert.equal(run!.found_count, 3, "the run row keeps the offered count the round read");
});

test("a later round that keeps nothing is a quiet week, not a broken source", async () => {
  const r = await collectSource(QUIET, { force: true });
  assert.equal(r.status, "ok", `a mature source may legitimately offer only items we drop: ${JSON.stringify(r)}`);
  assert.equal(r.found, 3);
  assert.equal(r.created, 0);
  assert.equal((await sourceRow(QUIET)).health, "ok", "the round succeeded, so the source stays healthy");
});
