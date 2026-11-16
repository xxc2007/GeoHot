import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFromEntry, type RobotsEntry } from "@aihot/backend/sources/robots";

function entry(over: Partial<RobotsEntry>): RobotsEntry {
  return { fetchedAt: Date.now(), status: "ok", rules: [], crawlDelaySeconds: null, ...over };
}

test("missing robots.txt (404) allows everything per RFC 9309", () => {
  const d = decideFromEntry("https://example.com/news/1", entry({ status: "missing" }));
  assert.equal(d.allowed, true);
  assert.equal(d.known, true);
});

test("error fetching robots leaves unknown (known=false) so caller can choose fail-open/closed", () => {
  const d = decideFromEntry("https://example.com/news/1", entry({ status: "error", error: "timeout" }));
  assert.equal(d.allowed, true);
  assert.equal(d.known, false);
});

test("Disallow on /blocks/ blocks any path under it", () => {
  const e = entry({ rules: [{ path: "/blocks/", allow: false }] });
  assert.equal(decideFromEntry("https://example.com/blocks/1", e).allowed, false);
  assert.equal(decideFromEntry("https://example.com/other", e).allowed, true);
});

test("Allow more specific than Disallow wins", () => {
  const e = entry({ rules: [
    { path: "/", allow: false },
    { path: "/news/", allow: true },
  ]});
  assert.equal(decideFromEntry("https://example.com/news/1", e).allowed, true);
  assert.equal(decideFromEntry("https://example.com/admin", e).allowed, false);
});

test("Crawl-delay is surfaced when present", () => {
  const e = entry({ crawlDelaySeconds: 10 });
  assert.equal(decideFromEntry("https://example.com/x", e).crawlDelaySeconds, 10);
});

test("invalid URL is rejected and unknown", () => {
  const d = decideFromEntry("not-a-url", entry({ status: "ok" }));
  assert.equal(d.allowed, false);
  assert.equal(d.known, false);
});

test("no matching rule means allow", () => {
  const e = entry({ rules: [{ path: "/private/", allow: false }] });
  assert.equal(decideFromEntry("https://example.com/public", e).allowed, true);
});
