import "./setup.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { ogRenderCapacity } from "../apps/api/src/og/capacity.ts";
import { renderOg } from "../apps/api/src/og/render.ts";
import { renderPoster } from "../apps/api/src/og/poster.ts";
import { CapacityExceeded } from "@aihot/backend/lib/capacity";
import { closeDb } from "@aihot/backend/db";

after(closeDb);
test("distinct cold cards and posters share admission and reject overflow without rendering", async () => {
  let release!: () => void;
  const held = ogRenderCapacity.run(() => new Promise<void>(resolve => { release = resolve; }));
  const title = `cold-admission-${Date.now()}`;
  try {
    await assert.rejects(renderOg({ kicker: "test", title }), CapacityExceeded);
    await assert.rejects(renderPoster({ url: "https://example.org/test", kicker: "test", title, summary: "test", source: "test", date: "2026-10-23", score: null }), CapacityExceeded);
  } finally { release(); await held; }
  assert.equal(await ogRenderCapacity.run(async () => "recovered"), "recovered");
});
