import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const cycle = readFileSync(path.join(root, "deploy/geohot/archive-cycle.sh"), "utf8").replace(/\r/g, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const withoutImports = (source: string) => source.replace(/^import .*?;\n/gm, "");

async function selection(sources: Array<{ id: string }>, ledger: object[], filter = "") {
  const body = cycle.match(/SELECTOR=\$\(cat <<'NODE'\n([\s\S]*?)\nNODE\n\)/)![1];
  const files = new Map<string, string>();
  const sql = async (parts: TemplateStringsArray) => parts.join("").includes("SELECT id FROM sources") ? sources : ledger;
  await new AsyncFunction("process", "sql", "closeDb", "beijingDate", "isValidDate", "archiveDoorFilter", "readFileSync", "writeFileSync", "renameSync", withoutImports(body))(
    { argv: ["node", "2026-01-01", "2026-02-28", "run", "state", "6", "100", filter] }, sql, async () => {},
    () => "2026-10-23", () => true, () => "", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    (name: string, value: string) => files.set(name, value), (from: string, to: string) => files.set(to, files.get(from)!),
  );
  return files;
}

test("past archive window fully done is successful; absent or mismatched doors still fail", async () => {
  const done = await selection([{ id: "journal" }], [{ source_id: "journal", month: "2026-01", status: "done" }, { source_id: "journal", month: "2026-02", status: "done" }]);
  assert.equal(done.get("run/slices.tsv"), "");
  assert.equal(JSON.parse(done.get("run/slices.json")!).completed, true);
  await assert.rejects(selection([], []), /No matching archive sources/);
  await assert.rejects(selection([{ id: "journal" }], [], "typo"), /No matching archive sources/);
  const pending = await selection([{ id: "journal" }], [{ source_id: "journal", month: "2026-01", status: "done" }]);
  assert.deepEqual(JSON.parse(pending.get("run/slices.json")!).selected, [{ source: "journal", month: "2026-02" }]);
  const dir = mkdtempSync(path.join(tmpdir(), "geohot-cycle-lifecycle-"));
  try {
    writeFileSync(path.join(dir, "slices.tsv"), "");
    writeFileSync(path.join(dir, "slices.json"), done.get("run/slices.json")!);
    const branch = cycle.slice(cycle.indexOf('  if [[ ! -s "$RUN_DIR/slices.tsv" ]]'), cycle.indexOf("  slice_no=0"));
    const run = spawnSync("bash", ["-c", `RUN_DIR="$1"; CYCLE_RESULT=0\n${branch}\nexit "$CYCLE_RESULT"`, "bash", dir.replace(/\\/g, "/")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /historical archive slices complete/);
    writeFileSync(path.join(dir, "slices.json"), '{"eligible":0,"completed":false}');
    const invalid = spawnSync("bash", ["-c", `RUN_DIR="$1"; CYCLE_RESULT=0\n${branch}\nexit "$CYCLE_RESULT"`, "bash", dir.replace(/\\/g, "/")], { encoding: "utf8" });
    assert.equal(invalid.status, 1, invalid.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TERM and INT drain one in-flight paper without starting the next period", async () => {
  const source = withoutImports(readFileSync(path.join(root, "scripts/backfill-papers.ts"), "utf8").replace(/\r/g, ""));
  const executable = stripTypeScriptTypes(source, { mode: "strip" });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const fakeProcess = Object.assign(new EventEmitter(), { env: {}, argv: ["node", "papers"], exitCode: 0, exit(code: number) { throw new Error(`Unexpected exit ${code}`); } });
    let started = 0, completed = 0, closed = false;
    const saved = new Map<string, object>();
    const date = (value: Date | number) => new Date(Number(value) + 8 * 3600_000).toISOString().slice(0, 10);
    const midnight = (value: string) => new Date(`${value}T00:00:00+08:00`);
    const compose = async (key: string) => {
      started++;
      fakeProcess.emit(signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      completed++;
      saved.set(key, { readable: true, sections: [{ items: [{}] }], flashes: [] });
      return { key, entries: 1 };
    };
    const bindings = {
      process: fakeProcess, console: { log() {}, error() {} },
      parseArgs: () => ({ values: { from: "2021-04-15", to: "2021-04-16", kinds: "daily", apply: true, "database-url-env": "DATABASE_URL" } }),
      writeFile: async () => {}, closeDb: async () => { closed = true; }, sql: async () => [{ n: 0 }],
      addDays: (key: string, amount: number) => date(Number(midnight(key)) + amount * 86400_000),
      beijingDate: date, beijingMidnight: midnight, isoWeekLabel: () => "unused", isoWeekRange: () => null, isValidDate: () => true,
      candidates: async () => [{}], composeDaily: compose, composeMonthly: compose, composeWeekly: compose,
      dailyWindow: (key: string) => ({ start: midnight(key), end: new Date(Number(midnight(key)) + 86400_000) }),
      editionsAhead: async () => [], monthlyWindow: () => ({}), reportInput: async () => ({}), reportInputUnchanged: async () => false,
      loadReport: async (_kind: string, key: string) => saved.get(key) ?? null,
    };
    fakeProcess.env = { DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/offline_fixture" };
    await new AsyncFunction(...Object.keys(bindings), executable)(...Object.values(bindings));
    assert.equal(started, 1, signal);
    assert.equal(completed, 1, "in-flight result must finish before closing the database");
    assert.equal(saved.size, 1);
    assert.equal(closed, true);
    assert.equal(fakeProcess.listenerCount(signal), 0, "signal listeners are removed after drain");
  }
  const unit = readFileSync(path.join(root, "deploy/geohot/systemd/geohot-archive.service"), "utf8");
  assert.match(unit, /^TimeoutStopSec=285s$/m);
  assert.match(cycle, /--kill-after=255s/);
});
