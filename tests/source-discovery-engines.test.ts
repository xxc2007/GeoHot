import assert from "node:assert/strict";
import test from "node:test";
import { engineCatalog, resolveEngineIds, UNSUPPORTED_ENGINES } from "../packages/backend/src/sources/search-engines.ts";
import { hostOfUrl, scoreHostCandidate, sourceHostQuality, sourceIdForFeed } from "../packages/backend/src/sources/discovery-run.ts";

const hit = (engine: string, rank = 1) => ({ engine, rank, title: "", url: "https://example.org/", snippet: "" });

test("host quality separates official, research, news, organizations and blocked UGC", () => {
  assert.deepEqual(sourceHostQuality("usgs.gov"), { blocked: false, base: 4, kind: "official" });
  assert.deepEqual(sourceHostQuality("nature.com"), { blocked: false, base: 3, kind: "research" });
  assert.deepEqual(sourceHostQuality("reuters.com"), { blocked: false, base: 1, kind: "news" });
  assert.deepEqual(sourceHostQuality("example.org"), { blocked: false, base: 2, kind: "organization" });
  assert.equal(sourceHostQuality("x.com").blocked, true);
  assert.equal(sourceHostQuality("zhihu.com").blocked, true);
  assert.equal(sourceHostQuality("").blocked, true);
});

test("one engine on a random blog is not enough; official or corroborated hosts pass", () => {
  const single = new Map([["exa", hit("exa", 5)]]);
  assert.equal(scoreHostCandidate("random-blog.example", single, true).eligible, false);
  assert.equal(scoreHostCandidate("usgs.gov", single, true).eligible, true);
  const corroborated = new Map([["exa", hit("exa", 5)], ["tavily", hit("tavily", 7)]]);
  assert.equal(scoreHostCandidate("random-blog.example", corroborated, true).eligible, true);
  assert.equal(scoreHostCandidate("usgs.gov", single, false).eligible, false);
  assert.equal(scoreHostCandidate("reddit.com", corroborated, true).eligible, false);
});

test("quality is bounded and rewards corroboration, rank and a live feed", () => {
  const one = new Map([["exa", hit("exa", 12)]]);
  const three = new Map([["exa", hit("exa", 1)], ["tavily", hit("tavily", 2)], ["baidu", hit("baidu", 3)]]);
  const low = scoreHostCandidate("example.org", one, true);
  const high = scoreHostCandidate("usgs.gov", three, true);
  assert.ok(low.quality >= 0 && low.quality <= 10);
  assert.ok(high.quality > low.quality);
  assert.equal(high.quality, 10);
});

test("host and source id helpers are stable for feed URLs", () => {
  assert.equal(hostOfUrl("https://www.Example.com/feed?x=1"), "example.com");
  const a = sourceIdForFeed("https://www.example.com/feed.xml");
  const b = sourceIdForFeed("https://www.example.com/feed.xml");
  const c = sourceIdForFeed("https://www.example.com/other.xml");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^discovered-[a-z0-9.-]+-[a-f0-9]{8}$/);
});

test("engine catalog marks missing keys instead of pretending they work", () => {
  const catalog = engineCatalog();
  assert.ok(catalog.some((engine) => engine.id === "exa"));
  assert.ok(catalog.some((engine) => engine.id === "anysearch" && engine.keyless));
  assert.ok(UNSUPPORTED_ENGINES.some((engine) => engine.id === "bing"));
  assert.ok(!resolveEngineIds(["not-an-engine"]).includes("not-an-engine"));
});
