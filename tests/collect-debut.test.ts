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
const MARKERS = `test-markers-${T}`;
const ITEM = (n: number, title = `Research article ${n} ${T}`) => `<item><title>${title}</title><link>https://rmets.onlinelibrary.example/doi/10.1002/joc.700${n}</link><description>Abstract ${n}: a new reconstruction with enough words to be a summary.</description><pubDate>Mon, 0${n} Oct 2026 08:00:00 +0000</pubDate></item>`;
const pages: Record<string, string> = {
  "/rss": `<rss version="2.0"><channel><title>Journal</title><link>https://rmets.onlinelibrary.example/</link>${[1, 2, 3].map((n) => ITEM(n)).join("")}</channel></rss>`,
  // A between-issues table of contents: every row is front matter our own noise list rejects. That is a
  // quiet week, not a misconfiguration, so the debut must be allowed to stand (and 76 rows of the real
  // pack carry such markers — refusing here would keep those sources from ever initializing).
  "/markers": `<rss version="2.0"><channel><title>Front matter</title><link>https://rmets.onlinelibrary.example/</link>${ITEM(1, `Issue Information ${T}`)}${ITEM(2, "Book Review: an atlas")}${ITEM(3, "Editorial Note")}</channel></rss>`,
};
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/rss+xml; charset=utf-8");
  res.end(pages[req.url!] ?? pages["/rss"]);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = (server.address() as { port: number }).port;
const feedUrl = `http://127.0.0.1:${PORT}/rss`;
const markersUrl = `http://127.0.0.1:${PORT}/markers`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;

before(async () => {
  // The first two allow only a host the listing never publishes, so every item is filtered out.
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${DEBUT}, ${`Debut ${T}`}, 'rss', ${sql.json({ feedUrl, allowUrlPrefixes: ["https://onlinelibrary.example/doi/"] })}, 'T1_5', 'editorial',
                    NULL, '2100-01-01'),
                   (${QUIET}, ${`Quiet ${T}`}, 'rss', ${sql.json({ feedUrl, allowUrlPrefixes: ["https://onlinelibrary.example/doi/"] })}, 'T1_5', 'editorial',
                    ${sql.json({ initializedAt: "2026-10-01T00:00:00.000Z" })}, '2100-01-01'),
                   (${MARKERS}, ${`Markers ${T}`}, 'rss', ${sql.json({
                      feedUrl: markersUrl,
                      allowUrlPrefixes: ["https://rmets.onlinelibrary.example/doi/"],
                      ingestNoiseFilter: { dropMarkersTitleOnly: ["Issue Information", "Book Review", "Editorial"] },
                      _aihot: { initialBackfillLimit: 8 },
                    })}, 'T1_5', 'editorial', NULL, '2100-01-01')`;
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

test("a debut whose every row is front matter is still a successful first import", async () => {
  // The noise list, not the address whitelist, emptied this listing — the case 76 pack rows can hit
  // between issues. Refusing it would leave such a source unable to ever initialize.
  const r = await collectSource(MARKERS, { force: true });
  assert.equal(r.status, "ok", `front-matter-only debut must stand: ${JSON.stringify(r)}`);
  assert.equal(r.found, 3, "the listing really offered three rows");
  assert.equal(r.created, 0, "our markers dropped all of them, which is the point of the rule");
  const row = await sourceRow(MARKERS);
  assert.equal(row.health, "ok");
  const cursor = (await sql<{ cursor: { initializedAt?: string } }[]>`SELECT cursor FROM sources WHERE id = ${MARKERS}`)[0]!.cursor;
  assert.ok(cursor.initializedAt, "the source remembers its first import, so the next round is an ordinary one");
});
