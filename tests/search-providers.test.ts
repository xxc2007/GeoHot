import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  AutoSearchProvider,
  __testRecordFailure,
  __testRecordSuccess,
  getProviderMetrics,
  resetSearchProviderState,
  searchProviderEnabled,
} from "@aihot/backend/sources/search-providers";

beforeEach(() => resetSearchProviderState());

test("feature flag defaults to OFF", () => {
  delete process.env.SEARCH_PROVIDER_FALLBACK;
  assert.equal(searchProviderEnabled(), false);
});

test("default chain is EMPTY (no HTML-scraping provider retained)", () => {
  const auto = new AutoSearchProvider();
  assert.equal(auto.chain.length, 0);
});

test("search returns [] when flag is off (no throw)", async () => {
  delete process.env.SEARCH_PROVIDER_FALLBACK;
  const auto = new AutoSearchProvider();
  const r = await auto.search("geography news");
  assert.deepEqual(r, []);
});

test("search returns [] when flag is on but chain is empty (no throw)", async () => {
  process.env.SEARCH_PROVIDER_FALLBACK = "true";
  const auto = new AutoSearchProvider();
  const r = await auto.search("geography news");
  assert.deepEqual(r, []);
  delete process.env.SEARCH_PROVIDER_FALLBACK;
});

test("fetchPage returns null when chain is empty (no throw)", async () => {
  process.env.SEARCH_PROVIDER_FALLBACK = "true";
  const auto = new AutoSearchProvider();
  const p = await auto.fetchPage("https://example.com/article");
  assert.equal(p, null);
  delete process.env.SEARCH_PROVIDER_FALLBACK;
});

test("breaker opens after 5 failures and records failure metric", () => {
  for (let i = 0; i < 5; i++) __testRecordFailure("test-provider", "network", "test failure");
  const m = getProviderMetrics("test-provider");
  assert.ok(m);
  assert.equal(m!.failures, 5);
  assert.ok(m!.lastFailure);
});

test("recordSuccess resets breaker without double-counting successes", () => {
  __testRecordFailure("test-provider", "network", "test");
  __testRecordSuccess("test-provider");
  const m = getProviderMetrics("test-provider");
  assert.ok(m);
  // recordSuccess must NOT increment successes (caller does that); only breaker resets.
  assert.equal(m!.successes, 0);
  assert.equal(m!.failures, 1);
});
