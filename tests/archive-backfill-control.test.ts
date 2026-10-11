import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { archiveMonths, archiveSliceCursor, crossrefNextCursor, siteSliceFinished } from "../scripts/backfill-archive.ts";

test("archive month plans cover the requested span exactly and reject invalid/inverted spans", () => {
  assert.deepEqual(archiveMonths("2026-01", "2026-10"), Array.from({ length: 10 }, (_, n) => `2026-${String(n + 1).padStart(2, "0")}`));
  assert.deepEqual(archiveMonths("2025-12", "2026-01"), ["2025-12", "2026-01"]);
  for (const [from, to] of [["2026-00", "2026-10"], ["2026-01", "2026-13"], ["2026-10", "2026-01"], ["2026-1", "2026-10"], ["2000-01", "2020-01"]]) {
    assert.throws(() => archiveMonths(from!, to!));
  }
});

test("CLI rejects an inverted range before attempting a database connection", () => {
  const result = spawnSync(process.execPath, ["scripts/backfill-archive.ts", "--from=2026-10", "--to=2026-01"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unreachable", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--from 不能晚于 --to/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("CLI rejects a --sleep it cannot read, before attempting a database connection", () => {
  // 打错一个字符就把限流读成 NaN，而 `await sleep(NaN)` 立刻返回：门会以最快速度敲 Crossref 的匿名池，
  // 两三次请求就 429，那一轮档案什么都补不回来。这种入口宁可当场拒绝，也不要"看起来在跑"。
  for (const flag of ["--sleep=abc", "--sleep=-1", "--sleep=NaN", "--sleep=1e999"]) {
    const result = spawnSync(process.execPath, ["scripts/backfill-archive.ts", "--from=2026-01", flag], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unreachable", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 2, `${flag} 应当被拒绝：${result.stderr}`);
    assert.match(result.stderr, /--sleep/, `${flag} 的报错没说出是哪个参数`);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  }
  // 0 是合法值（给了 CROSSREF_MAILTO 进 polite 池就不必等），别把它一起挡掉。
  const zero = spawnSync(process.execPath, ["scripts/backfill-archive.ts", "--from=2026-01", "--to=2026-01", "--sleep=0"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unreachable", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.doesNotMatch(zero.stderr, /--sleep/, `--sleep=0 被当成非法值：${zero.stderr}`);
});

test("current month resumes partial work but restarts completed scans to discover late arrivals", () => {
  assert.equal(archiveSliceCursor("2026-10", "2026-10", { status: "pending", cursor: "page-3" }), "page-3");
  assert.equal(archiveSliceCursor("2026-10", "2026-10", { status: "pending", cursor: null }), "*");
  assert.equal(archiveSliceCursor("2026-10", "2026-10", { status: "done", cursor: "old-cursor" }), "*");
  assert.equal(archiveSliceCursor("2026-09", "2026-10", { status: "done" }), null);
  assert.equal(archiveSliceCursor("2026-09", "2026-10", { status: "pending", cursor: "resume" }), "resume");
});

test("a site month closes only with proven dated coverage and completed reads", () => {
  assert.equal(siteSliceFinished("2026-09", "2026-10", false, false, false, 0), true);
  assert.equal(siteSliceFinished("2026-10", "2026-10", false, false, false, 0), false);
  assert.equal(siteSliceFinished("2026-09", "2026-10", false, false, false, 1), false);
  for (const flags of [[true, false, false], [false, true, false], [false, false, true]]) {
    assert.equal(siteSliceFinished("2026-09", "2026-10", flags[0]!, flags[1]!, flags[2]!, 0), false);
  }
});

test("Crossref short/empty terminal pages close even with a next cursor; full pages preserve continuation", () => {
  assert.equal(crossrefNextCursor(7, 100, "last-cursor"), null);
  assert.equal(crossrefNextCursor(0, 100, "last-cursor"), null);
  assert.equal(crossrefNextCursor(100, 100, "next-page"), "next-page");
  assert.equal(crossrefNextCursor(100, 100, null), null); // caller treats this full-page missing cursor as an error
});
