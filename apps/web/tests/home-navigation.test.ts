// Run after the web build. Exercise the installed router and actual production loaders:
// older router versions required a document-navigation workaround for prefixed home links.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryRouter, createRequestHandler, type RouterState } from "react-router";

test("prefixed home navigation and category changes reuse the shell loader", async () => {
  const build = await import(new URL("../build/server/index.js", import.meta.url).href);
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null, topic: null };
    if (url.pathname.endsWith("/meta")) return Response.json({ changelogVersion: null });
    if (url.pathname.endsWith("/timeline")) return Response.json({ filters, cards: [], nextCursor: null, refreshAt: null, dayCounts: {}, hot: null, generatedAt: new Date().toISOString() });
    if (url.pathname.endsWith("/pool")) return Response.json({ filters, items: [], total: 0, page: 1, pageCount: 1, generatedAt: new Date().toISOString() });
    if (url.pathname.endsWith("/calendar")) return Response.json({ days: [] });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  };
  try {
    // Both forms match in memory; only the real HTTP single-fetch test proves which URL is valid.
    for (const basename of new Set([build.basename, build.basename.replace(/\/+$/, "") || "/"])) {
      const previousMeta = requests.filter((url) => url.pathname.endsWith("/meta")).length;
      const prefix = basename.replace(/\/+$/, "");
      const router = createMemoryRouter([{
        id: "root", path: "/", loader: build.routes.root.module.loader,
        shouldRevalidate: build.routes.root.module.shouldRevalidate,
        children: [
          { id: "home", index: true, loader: build.routes["routes/home"].module.loader },
          { id: "all", path: "all", loader: build.routes["routes/all"].module.loader },
        ],
      }], { basename, initialEntries: [`${prefix}/all`] });
      const idle = async () => {
        const ready = (state: RouterState) => state.initialized && state.navigation.state === "idle";
        if (ready(router.state)) return;
        await new Promise<void>((resolve) => {
          const unsubscribe = router.subscribe((state) => { if (ready(state)) { unsubscribe(); resolve(); } });
        });
      };
      try {
        await idle();
        for (const category of [null, "physical", "human", null]) {
          await router.navigate(category ? `/?category=${category}` : "/");
          assert.equal(router.state.errors, null);
          assert.equal(router.state.matches.at(-1)?.route.id, "home");
          assert.equal(router.state.loaderData.home.filters.category, category);
        }
        await router.navigate(-1);
        await idle();
        assert.equal(router.state.loaderData.home.filters.category, "human");
        assert.equal(requests.filter((url) => url.pathname.endsWith("/meta")).length, previousMeta + 1);
        assert.ok(requests.filter((url) => url.pathname.endsWith("/timeline")).every((url) => url.searchParams.get("limit") === "12"));
      } finally { router.dispose(); }
    }
    // The actual shell and category components must emit router links, not merely have loaders
    // capable of navigating. A document anchor has no data-discover marker and loses this reuse.
    const response = await createRequestHandler(build, "production")(new Request(`http://localhost${build.basename.replace(/\/+$/, "")}/`));
    assert.equal(response.status, 200);
    const html = await response.text();
    const homeLinks = [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag)
      .filter((tag) => /href="\/geohot\/?(?:\?category=[^"]*)?"/.test(tag));
    if (build.basename.replace(/\/+$/, "") === "/geohot") {
      assert.ok(homeLinks.length >= 5, "brand, desktop/mobile home and category links must be present");
      assert.ok(homeLinks.every((tag) => tag.includes('data-discover="true"')));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
