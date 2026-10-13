// The cross-outlet block in `scripts/smoke.ts` compares four outlets that read the same publication gate
// through different page sizes. Those predicates need a sample that can make them red — production is green
// and stays green, so without this file the only proof the check discriminates anything is someone's word
// that they ran it by hand. Five scenarios: one correct, one per predicate, plus a deep archive that only
// passes if v1's cursor paging works (which is the thing that broke when the backfill made the index longer
// than one v1 page).
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const day = (i: number) => new Date(Date.UTC(2026, 5, 8) - i * 86_400_000).toISOString().slice(0, 10);
/** Newest first — the order every one of these outlets publishes in. */
const keys = (n: number) => Array.from({ length: n }, (_, i) => day(i));

type Shape = { index: string[]; sitemap: string[]; feed: string[] };

let shape: Shape = { index: [], sitemap: [], feed: [] };
let v1Window: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: string, type = "application/xml") => { res.writeHead(200, { "content-type": type }); res.end(body); };
  if (url.pathname === "/sitemap.xml") return send(`<urlset>${shape.sitemap.map((k) => `<url><loc>https://x/daily/${k}</loc></url>`).join("")}<url><loc>https://x/daily/archive</loc></url></urlset>`);
  if (url.pathname === "/feed/daily.xml") return send(`<rss><channel><link>https://x/feed/daily.xml</link>${shape.feed.map((k) => `<item><link>https://x/daily/${k}</link></item>`).join("")}</channel></rss>`);
  if (url.pathname === "/api/site/reports/daily") return send(JSON.stringify({ items: shape.index.map((key) => ({ key })) }), "application/json");
  if (url.pathname === "/api/v1/dailies") {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const before = url.searchParams.get("before");
    const window = before ? v1Window.filter((k) => k < before) : v1Window;
    return send(JSON.stringify({ items: window.slice(0, limit).map((date) => ({ date })) }), "application/json");
  }
  res.writeHead(404).end("not part of this check");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

/**
 * Async on purpose: the fixture is an HTTP server in *this* process, so a synchronous spawn would freeze the
 * event loop that has to answer the child's requests.
 */
async function runSmoke(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke.ts", "--base", base], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { out += c; });
    const kill = setTimeout(() => child.kill(), 60_000);
    child.on("close", () => { clearTimeout(kill); resolve(out.split("\n").filter((l) => l.includes("cross-outlet")).join("\n")); });
    child.on("error", reject);
  });
}

/** A coherent world: the index is the gate, the feed is its newest 30, the sitemap lists the same window. */
function agree(n = 4) {
  const index = keys(n);
  shape = { index, sitemap: index, feed: index.slice(0, Math.min(30, n)) };
  v1Window = index;
}

test("出口一致时判绿：sitemap / feed / 索引 / v1 说的是同一批期次", async () => {
  agree(6);
  assert.match(await runSmoke(), /^✓ cross-outlet/m);
});

test("sitemap 多出一条索引里没有的期次 ⇒ 红（这条检查存在的理由）", async () => {
  agree(5);
  shape = { ...shape, sitemap: [...shape.sitemap, day(40)] };
  const out = await runSmoke();
  assert.match(out, /sitemap advertises daily\/\d{4}-\d{2}-\d{2}, the site index does not/);
  assert.match(out, /never lists it/);
});

test("日报 feed 跳过一期 ⇒ 红，哪怕条数看着正常", async () => {
  agree(6);
  shape = { ...shape, feed: [shape.index[0]!, shape.index[2]!] };
  assert.match(await runSmoke(), /daily\.xml skips an issue/);
});

test("公开 API 少了任何出口在宣传的一期 ⇒ 红", async () => {
  agree(6);
  v1Window = v1Window.slice(0, 3);
  assert.match(await runSmoke(), /is advertised but \/api\/v1\/dailies never lists it/);
});

/**
 * The regression this whole block was rewritten for: v1 answers at most 180 per request, so a comparison
 * made against its first page is an assertion that fewer than 180 issues exist. 200 here also proves the
 * `before` cursor is followed — a single page would report 20 missing issues.
 */
test("档案比一页深时仍然判绿：v1 要按游标翻到覆盖索引的窗口", async () => {
  agree(200);
  const out = await runSmoke();
  assert.match(out, /^✓ cross-outlet/m);
  assert.doesNotMatch(out, /^✗/m);
});
