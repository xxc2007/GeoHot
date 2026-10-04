// One rule for the boolean safety valves (AGENTS.md: 开发和测试时保持安全阀关闭). The same variable name used
// to be read three ways — `!== "false"` in the worker and the alerts, `bool()` in config.ts, `=== "true"` in
// the Feishu notifier — so `COLLECT_ENABLED=0` left the worker poking 85 upstream sources every minute while
// the rest of the process believed collection was off. These tests pin the table for `envFlag`/`isCollectEnabled`
// and keep the read points from re-forking.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { envFlag, isCollectEnabled, isModelCallsEnabled, REPO_ROOT } from "@aihot/backend/config";

const NAME = "VALVE_TABLE_PROBE";
const savedValue = process.env[NAME];
after(() => {
  if (savedValue === undefined) delete process.env[NAME];
  else process.env[NAME] = savedValue;
});

/** Everything that must mean off, whatever the fallback is. */
const OFF = ["0", "false", "FALSE", "False", "fAlSe", "off", "no", "n", "2", "yes", "true1", " ", "tr ue"];
/** Everything that must mean on. */
const ON = ["1", "true", "TRUE", "True"];

test("envFlag: 0 / false / off and any other non-empty spelling are off; only 1 and true are on", () => {
  for (const value of OFF) {
    process.env[NAME] = value;
    assert.equal(envFlag(NAME, true), false, `${JSON.stringify(value)} with fallback true must read as off`);
    assert.equal(envFlag(NAME, false), false, `${JSON.stringify(value)} with fallback false must read as off`);
  }
  for (const value of ON) {
    process.env[NAME] = value;
    assert.equal(envFlag(NAME, false), true, `${JSON.stringify(value)} must read as on`);
    assert.equal(envFlag(NAME, true), true, `${JSON.stringify(value)} must read as on`);
  }
});

test("envFlag: an empty value is the caller's fallback, never a silent on", () => {
  process.env[NAME] = "";
  assert.equal(envFlag(NAME, true), true, "an empty value is not a value: a valve that defaults open stays open");
  assert.equal(envFlag(NAME, false), false, "…and one that defaults closed stays closed");
  delete process.env[NAME];
  assert.equal(envFlag(NAME, true), true, "a missing variable is the same as an empty one");
  assert.equal(envFlag(NAME, false), false, "…and never reads as on by accident");
});

test("COLLECT_ENABLED and MODEL_CALLS_ENABLED read through that one rule", () => {
  for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED"] as const) {
    const read = name === "COLLECT_ENABLED" ? isCollectEnabled : isModelCallsEnabled;
    const saved = process.env[name];
    try {
      for (const value of ["0", "false", "FALSE", "off"]) {
        process.env[name] = value;
        assert.equal(read(), false, `${name}=${value} must stop the pipeline reaching out`);
      }
      for (const value of ["1", "true", "TRUE"]) {
        process.env[name] = value;
        assert.equal(read(), true, `${name}=${value} is the deployment asking for it`);
      }
      process.env[name] = "";
      assert.equal(read(), true, `${name}= falls back to the documented default (on unless written down)`);
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }
});

test("development stays closed by what is shipped, not by a default", () => {
  // The defaults above are on, so a clean clone is only safe because the template writes the valves down.
  const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    assert.match(example, new RegExp(`^${name}=false$`, "m"), `.env.example must ship ${name}=false`);
    assert.equal(envFlag(name, false), false, `${name} must not be switched on here (tests inherit .env)`);
  }
});

test("no second reading of COLLECT_ENABLED survives outside config.ts", () => {
  const roots = [path.join(REPO_ROOT, "packages"), path.join(REPO_ROOT, "apps"), path.join(REPO_ROOT, "industry")];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  for (const root of roots) if (statSync(root).isDirectory()) walk(root);
  const readers = files.filter((file) => {
    if (file.endsWith(path.join("src", "config.ts"))) return false;
    const text = readFileSync(file, "utf8");
    // Only a read counts: `envFlag("COLLECT_ENABLED", …)` lives in config.ts, and comments may name the valve.
    return /process\.env\.COLLECT_ENABLED|env\["COLLECT_ENABLED"\]|"COLLECT_ENABLED"|\bCOLLECT_ENABLED\b\s*[!=]==/.test(text.replace(/^[ \t]*\/\/.*$/gm, ""));
  });
  assert.deepEqual(readers.map((f) => path.relative(REPO_ROOT, f)), [], "read the valve through isCollectEnabled(), never by hand");
});
