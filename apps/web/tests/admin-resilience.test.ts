import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryRouter, createRequestHandler, type RouterState } from "react-router";

const build = await import(new URL("../build/server/index.js", import.meta.url).href);
const prefix = String(build.basename).replace(/\/+$/, "");
const emptyRuns = { checkedAt: "2026-10-25T00:00:00Z", processes: [], jobs: [], timeline: [], queues: [], failedJobs: [], lagging: [], receipts: { counts: {}, issues: [], unknownTotal: 0 }, deliveries: [], errors: [], retrying: { count: 0, next: null }, ingest: [], leaderboard: null };

async function withApi<T>(api: (url: URL) => Response | Promise<Response>, fn: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async input => api(new URL(String(input)))) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = original; }
}
function api(url: URL) {
  if (url.pathname.endsWith("/me")) return Response.json({ name: "测试管理员", csrf: "test", dev: false });
  if (url.pathname.endsWith("/nav-counts")) return Response.json({});
  if (url.pathname.endsWith("/runs")) return Response.json(emptyRuns);
  if (url.pathname.endsWith("/content")) return Response.json({ rows: [] });
  if (url.pathname.endsWith("/meta")) return Response.json({ changelogVersion: null });
  throw new Error(`External calls are blocked: ${url.pathname}`);
}
async function render(override: (url: URL) => Response | Promise<Response>) {
  return withApi(override, async () => {
    const r = await createRequestHandler(build, "production")(new Request(`https://example.test${prefix}/admin/runs`));
    return { status: r.status, html: await r.text(), headers: r.headers };
  });
}

test("identity outage stays inside the admin frame without protected content", async () => {
  const r = await render(url => url.pathname.endsWith("/me") ? Response.json({}, { status: 503 }) : api(url));
  assert.equal(r.status, 503);
  assert.match(r.html, /后台连接暂时不可用/);
  assert.match(r.html, /审计记录/);
  assert.doesNotMatch(r.html, /回到精选|队列积压|测试管理员/);
});

test("a truncated identity response is recoverable and does not expose the public 500 screen", async () => {
  const r = await render(url => url.pathname.endsWith("/me") ? new Response('{"name":', { headers: { "content-type": "application/json" } }) : api(url));
  assert.equal(r.status, 503);
  assert.match(r.html, /后台连接暂时不可用/);
  assert.doesNotMatch(r.html, /回到精选|SyntaxError/);
});

test("statistics outage returns an explicit retry state rather than throwing or inventing empty queues", async () => {
  const r = await render(url => url.pathname.endsWith("/runs") ? Response.json({}, { status: 503 }) : api(url));
  assert.equal(r.status, 200);
  assert.match(r.html, /不代表队列为空或工作流停止/);
  assert.match(r.html, /审计记录/);
  assert.doesNotMatch(r.html, /回到精选|队列积压/);
});

test("expired sessions still redirect to sign-in", async () => {
  const r = await render(url => url.pathname.endsWith("/me") || url.pathname.endsWith("/runs") ? Response.json({}, { status: 401 }) : api(url));
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location") ?? "", /\/admin\/login\?/);
  assert.doesNotMatch(r.html, /测试管理员/);
});

test("ordinary admin navigation reuses identity while explicit retry and actions still reload it", async () => {
  let identities = 0;
  await withApi(url => { if (url.pathname.endsWith("/me")) identities++; return api(url); }, async () => {
    const shell = build.routes["admin-layout"].module;
    const router = createMemoryRouter([{ id: "admin-layout", path: "/admin", loader: shell.loader, shouldRevalidate: shell.shouldRevalidate,
      children: [
        { path: "runs", loader: build.routes["routes/admin/runs"].module.loader },
        { path: "content", loader: build.routes["routes/admin/content"].module.loader },
      ] }], { initialEntries: ["/admin/runs"] });
    const idle = async () => {
      const ready = (s: RouterState) => s.initialized && s.navigation.state === "idle" && s.revalidation === "idle";
      if (ready(router.state)) return;
      await new Promise<void>(resolve => { const off = router.subscribe(s => { if (ready(s)) { off(); resolve(); } }); });
    };
    try {
      await idle();
      await router.navigate("/admin/content");
      await idle();
      assert.equal(router.state.errors, null);
      assert.equal(identities, 1);
      await router.revalidate(); await idle();
      assert.equal(identities, 2);
      assert.equal(shell.shouldRevalidate({ formMethod: "POST", defaultShouldRevalidate: true, currentUrl: new URL('http://x/admin/runs'), nextUrl: new URL('http://x/admin/content') }), true);
    } finally { router.dispose(); }
  });
});
