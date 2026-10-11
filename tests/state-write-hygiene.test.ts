// `articles.updated_at` is the only stamp that says "when did this row's processing state last change".
// The extraction path bumped it; the processing-state writes did not. Consequence measured on production
// 2026-10-11: counting "archive rows finished per hour" by `updated_at` undercounted the real finish rate by
// hours (the histogram showed nothing for 18:00-20:00 while 76 rows had in fact terminalised), and two
// rounds' worth of capacity decisions were made on that wrong number. It also means the safety net at
// `jobs/content.ts` (`processing_state = 'analyzed' AND updated_at < now() - interval '10 minutes'`) is
// never debounced the way its comment says it is: a row that just became analyzed is eligible immediately.
//
// Changing this cannot disturb a reader: the pool's ETag/freshness and the sitemap use
// `publications.updated_at`, and `publication/pool.ts` documents why they stopped using the article stamp.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";

/** Everything the shipped code is made of — the same tree the other repo-wide guards walk. */
function sourceFiles(): string[] {
  const roots = ["packages", "apps", "scripts", "tooling"].map((d) => path.join(REPO_ROOT, d));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) files.push(full);
    }
  };
  for (const root of roots) if (statSync(root).isDirectory()) walk(root);
  return files;
}

/** Code without line comments: a comment may describe a state change without performing one. */
const code = (file: string) => readFileSync(file, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Every `UPDATE articles … SET …` statement in the tree, as (file, line, statement text).
 * A template's closing backtick is found as the first `` `; `` at or after the statement: counting backticks
 * instead lands on the closing tick of a nested `` ${`…`} `` expression, which cut the statement short and
 * reported a false offender on the line that writes `processing_error = ${`receipt …`}`.
 */
function articleUpdates(): Array<{ file: string; line: number; sql: string }> {
  const found: Array<{ file: string; line: number; sql: string }> = [];
  for (const file of sourceFiles()) {
    const text = code(file);
    for (const match of text.matchAll(/\bUPDATE\s+articles\b/g)) {
      const from = match.index!;
      const end = text.indexOf("`;", from);
      if (end < 0) continue;
      const statement = text.slice(from, end);
      if (!/SET/.test(statement)) continue;
      found.push({ file: path.relative(REPO_ROOT, file), line: text.slice(0, from).split("\n").length, sql: statement.replace(/\s+/g, " ").trim() });
    }
  }
  return found;
}

test("写 processing_state 的那几条 UPDATE 必须一起刷新 updated_at", () => {
  const stateWrites = articleUpdates().filter((u) => /processing_state\s*=/.test(u.sql));
  assert.ok(stateWrites.length >= 8, `扫描只找到 ${stateWrites.length} 条状态写入，判据本身可能已经失效`);
  const stale = stateWrites.filter((u) => !/updated_at\s*=\s*now\(\)/.test(u.sql));
  assert.deepEqual(stale.map((u) => `${u.file}:${u.line}`), [],
    "状态变了而 updated_at 不动，档案完成速率与 10 分钟去抖就都读不到真相");
});

