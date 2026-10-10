import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("archive CLI refuses conflicting modes and missing/future source dates before database access", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "geohot-archive-cli-"));
  const input = path.join(dir, "items.jsonl");
  const run = (args: string[]) => spawnSync(process.execPath, ["scripts/seed-curated.ts", "--archive", "--input", input, ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DATABASE_URL: "postgres://test:test@127.0.0.1:1/geohot_cli_test", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
  });
  try {
    writeFileSync(input, JSON.stringify({ kind: "material", sourceId: "test", title: "Archive", url: "https://example.com/archive" }) + "\n");
    for (const [args, message] of [
      [["--as-of=2026-01-01"], /mutually exclusive/],
      [["--route=http"], /requires --route inproc/],
      [[], /missing or invalid publishedAt/],
    ] as const) {
      const result = run([...args]);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
    }
    for (const dates of [
      { publishedAt: "2999-01-01T00:00:00Z" },
      { publishedAt: "2026-01-01T00:00:00Z", timelineAt: "2999-01-01T00:00:00Z" },
      { publishedAt: "not-a-date" },
    ]) {
      writeFileSync(input, JSON.stringify({ kind: "item", ...dates }) + "\n");
      const result = run([]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing or invalid publishedAt|invalid or future/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
