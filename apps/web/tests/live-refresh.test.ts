import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshPublicData } from "../app/lib/live-refresh.ts";

test("live refresh keeps the last good data on errors and discards responses after reading starts", async () => {
  const original = globalThis.fetch;
  let eligible = true;
  const commits: unknown[] = [];
  const controller = new AbortController();
  const refresh = () => refreshPublicData("/api/site/timeline?limit=12", controller.signal, () => eligible, x => commits.push(x));
  try {
    globalThis.fetch = async () => { eligible = false; return Response.json({ version: 2 }); };
    await refresh();
    assert.deepEqual(commits, []);
    eligible = true;
    globalThis.fetch = async () => new Response("busy", { status: 503 });
    await refresh();
    assert.deepEqual(commits, []);
    globalThis.fetch = async () => Response.json({ version: 3 });
    await refresh();
    assert.deepEqual(commits, [{ version: 3 }]);
    controller.abort();
    await refresh();
    assert.equal(commits.length, 1);
  } finally { globalThis.fetch = original; }
});

test("an ineligible page never sends a background request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    assert.equal(await refreshPublicData("/api/site/timeline", new AbortController().signal, () => false, () => assert.fail()), false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("a list and its calendar commit together, preserving both when either fails", async () => {
  const original = globalThis.fetch;
  const commits: unknown[] = [];
  try {
    globalThis.fetch = async input => String(input).includes("calendar") ? new Response("busy", { status: 503 }) : Response.json({ total: 2 });
    await refreshPublicData(["/pool", "/calendar"], new AbortController().signal, () => true, x => commits.push(x));
    assert.equal(commits.length, 0);
    globalThis.fetch = async input => Response.json(String(input).includes("calendar") ? { days: [2] } : { total: 2 });
    await refreshPublicData(["/pool", "/calendar"], new AbortController().signal, () => true, x => commits.push(x));
    assert.deepEqual(commits, [[{ total: 2 }, { days: [2] }]]);
  } finally { globalThis.fetch = original; }
});
