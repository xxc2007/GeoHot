import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

const source = `test-curated-archive-${tag()}`;
const dir = mkdtempSync(path.join(tmpdir(), "geohot-archive-state-"));
const input = path.join(dir, "items.jsonl");
const original = "2026-01-12T09:30:00+08:00";
const item = { kind: "material", sourceId: source, title: "River survey", url: `https://example.com/${source}`,
  publishedAt: original, timelineAt: "2026-01-13T00:00:00Z", discoveredAt: "2026-01-14T00:00:00Z",
  bodyText: "Original river survey body", raw: { upstream: "official-survey" } };
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'Archive test','external','T1','editorial')`;
  writeFileSync(input, JSON.stringify(item) + "\n");
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});
function run(args: string[]) {
  const result = spawnSync(process.execPath, ["scripts/seed-curated.ts", "--input", input, "--enforce-source", ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000,
    env: { ...process.env, MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.split(/\r?\n/).findLast((line) => line.startsWith("{"))!);
}
test("archive imports real source time and body, queues analysis once and preserves identity on rerun", async () => {
  const dry = run(["--archive", "--dry-run"]);
  assert.equal(dry.archive, true);
  assert.equal(dry.keepTimes, true);
  assert.equal(dry.rescaled, false);
  assert.equal(dry.historicalAfterIngest, 1);
  const before = Date.now();
  const first = run(["--archive"]);
  assert.equal(first.created, 1);
  assert.equal(first.queued, 1);
  assert.equal(first.realignedToPlannedTimes, 0);
  const [row] = await sql`SELECT * FROM articles WHERE source_id=${source}`;
  assert.equal(row!.published_at.toISOString(), new Date(original).toISOString());
  assert.equal(row!.timeline_at.toISOString(), new Date(original).toISOString());
  assert.ok(row!.discovered_at.getTime() >= before && row!.discovered_at.getTime() <= Date.now());
  assert.equal(row!.backfill_reason, "archive");
  assert.equal(row!.body_text, item.bodyText);
  assert.equal(row!.raw.upstream, item.raw.upstream);
  assert.equal(row!.raw._geohot.authoredDiscoveredAt, item.discoveredAt);
  assert.ok(row!.processing_queued_at);
  const second = run(["--archive"]);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.queued, 0);
  const [again] = await sql`SELECT discovered_at, revision FROM articles WHERE id=${row!.id}`;
  assert.equal(again!.discovered_at.toISOString(), row!.discovered_at.toISOString());
  assert.equal(again!.revision, 1);
});
test("a later archive synopsis cannot replace an existing original body", async () => {
  const [before] = await sql`SELECT body_text,revision FROM articles WHERE source_id=${source}`;
  writeFileSync(input, JSON.stringify({ ...item, bodyText: "Short synopsis" }) + "\n");
  const out = run(["--archive"]);
  const [after] = await sql`SELECT body_text,revision FROM articles WHERE source_id=${source}`;
  assert.equal(after!.body_text, before!.body_text);
  assert.equal(after!.revision, before!.revision);
  assert.equal(out.updated, 0);
  writeFileSync(input, JSON.stringify(item) + "\n");
});
test("default replay continues to rescale old source dates without enabling archive", () => {
  const replay = run(["--dry-run", "--as-of=2026-10-10T08:00:00+08:00"]);
  assert.equal(replay.archive, false);
  assert.equal(replay.keepTimes, false);
  assert.equal(replay.rescaled, true);
  assert.equal(replay.historicalAfterIngest, 0);
});
