// Exercise the operator CLI itself. Partial periods need no database reads; an accidental
// daily run would hit the deliberately unreachable test database and fail instead of printing a plan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
function run(args: string[]) {
  return spawnSync(process.execPath, ["scripts/backfill-papers.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/geohot_cli_test",
      NODE_ENV: "test",
      AIHOT_ENVIRONMENT: "test",
      MODEL_CALLS_ENABLED: "false",
      COLLECT_ENABLED: "false",
      AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials",
    },
  });
}

test("weekly/monthly-only plans do not compose or even query daily periods", () => {
  for (const kinds of ["weekly", "monthly", "weekly,monthly", " weekly , weekly "]) {
    const result = run([`--kinds=${kinds}`, "--from=2026-01-01", "--to=2026-01-01"]);
    assert.equal(result.error, undefined, `${kinds}: ${result.error}`);
    assert.equal(result.status, 0, `${kinds}: ${result.stderr}`);
    assert.match(result.stdout, /计划 0 期/);
    assert.doesNotMatch(result.stdout, /没有可刊条目|已出刊|会出刊/);
  }
});

test("invalid kind lists fail explicitly before touching the database", () => {
  for (const kinds of ["", "annual", "daily,annual", "daily,", ",weekly", "weekly,,monthly"]) {
    const result = run([`--kinds=${kinds}`, "--from=2026-01-01", "--to=2026-01-01"]);
    assert.equal(result.status, 2, `${JSON.stringify(kinds)}: ${result.stderr}`);
    assert.match(result.stderr, /--kinds 必须/);
    assert.doesNotMatch(result.stdout, /计划/);
  }
});

test("invalid dates and reversed ranges fail before touching the database", () => {
  for (const args of [
    ["--from=2026-02-30"],
    ["--to=2026-13-01"],
    ["--from=2026-02-01", "--to=2026-01-01"],
  ]) {
    const result = run(["--kinds=weekly", ...args]);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /计划/);
  }
});

test("summary output is opt-in JSON with full partial-period information", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "geohot-paper-cli-"));
  try {
    const file = path.join(dir, "summary.json");
    const result = run(["--kinds=weekly,monthly", "--from=2026-01-01", "--to=2026-01-01", `--summary-file=${file}`]);
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(file, "utf8");
    const summary = JSON.parse(raw);
    assert.equal(summary.version, 1);
    assert.equal(summary.mode, "plan");
    assert.deepEqual(summary.kinds, ["weekly", "monthly"]);
    assert.deepEqual(summary.plan, []);
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.partial.length, 2);
    assert.doesNotMatch(raw, /postgres:\/\/|DATABASE_URL|test:test/);
    assert.equal(run(["--summary-file="]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("database env acknowledgement accepts only DATABASE_URL and rejects conflicting targets", () => {
  for (const args of [
    ["--database-url-env=OTHER_DATABASE"],
    ["--database-url-env="],
    ["--database-url-env=DATABASE_URL", "--database-url=postgres://test:test@localhost/other_test"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--database-url-env 仅接受/);
  }
  const result = run(["--apply", "--database-url-env=DATABASE_URL", "--kinds=weekly", "--from=2026-01-01", "--to=2026-01-01"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /出刊 0 期/);
});
