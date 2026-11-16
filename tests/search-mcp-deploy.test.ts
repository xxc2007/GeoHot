import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WRAPPER = new URL("../deploy/geohot/bin/search-mcp-launch.sh", import.meta.url);
const DROPIN = new URL("../deploy/geohot/systemd/geohot-worker.service.d/zzz-search-mcp.conf", import.meta.url);

/**
 * 2026-11-16 全服务器自治改造：search MCP 部署骨架。
 * 当前 search-providers.ts 直接 HTTP 调用 ddg-lite，尚未 spawn MCP；
 * 本脚本是未来迁移预留，默认关闭，不声称已生效。
 */

test("wrapper passes bash syntax check", () => {
  execFileSync("bash", ["-n", fileURLToPath(WRAPPER)]);
});

test("default disabled (ENABLED!=1) exits 0 silently without running node", () => {
  // With ENABLED unset/0, the script must exit 0 before reaching exec node.
  const out = execFileSync("bash", [fileURLToPath(WRAPPER)], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "", "disabled mode must produce no output");
});

test("enabled but binary missing exits non-zero (fail loudly, not silent degrade)", () => {
  try {
    execFileSync("bash", [fileURLToPath(WRAPPER)], {
      env: { PATH: process.env.PATH, GEOHOT_SEARCH_MCP_ENABLED: "1", GEOHOT_SEARCH_MCP_BIN: "/nonexistent/mcp.js" },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(false, "should have exited non-zero");
  } catch (e: any) {
    assert.notEqual(e.status, 0, "exit code must be non-zero when enabled but binary missing");
    assert.match(e.stderr || "", /refusing to silently degrade/i);
  }
});

test("wrapper caps Node V8 heap at 128MB (under worker cgroup 150M)", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.match(text, /--max-old-space-size=128/);
  // Must NOT claim 192MB which would exceed the 150M cgroup
  assert.ok(!/--max-old-space-size=192/.test(text), "heap must not exceed 128MB");
});

test("wrapper disables browser fetch (no headless Chrome dependency)", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.match(text, /MCP_BROWSER_FETCH="\$\{MCP_BROWSER_FETCH:-false\}"/);
});

test("wrapper enforces search/fetch timeouts and concurrency cap", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.match(text, /MCP_SEARCH_TIMEOUT_MS="\$\{MCP_SEARCH_TIMEOUT_MS:-15000\}"/);
  assert.match(text, /MCP_FETCH_TIMEOUT_MS="\$\{MCP_FETCH_TIMEOUT_MS:-20000\}"/);
  assert.match(text, /MCP_MAX_CONCURRENCY="\$\{MCP_MAX_CONCURRENCY:-2\}"/);
});

test("default providers list is empty (DDG-lite/Bing both unlicensed for server automation)", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.match(text, /MCP_ENABLED_PROVIDERS="\$\{MCP_ENABLED_PROVIDERS:-}"/);
  // Must NOT default to ddg-lite or bing
  assert.ok(!/:-ddg-lite/.test(text), "DDG-lite must not be default (ToS forbids server automation)");
  assert.ok(!/:-.*bing/.test(text), "Bing must not be default (ToS unconfirmed)");
});

test("wrapper does not bind any TCP port", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.ok(!/listen\s*\(/.test(text), "must not call listen()");
  assert.ok(!/0\.0\.0\.0:\d+/.test(text), "must not bind 0.0.0.0");
  assert.ok(!/--port=\d+/.test(text), "must not pass --port");
});

test("wrapper reads keys from private env file, not hardcoded", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  assert.match(text, /\/etc\/geohot\/search-mcp\.env/);
  assert.ok(!/sk-[a-zA-Z0-9]{10,}/.test(text), "must not hardcode OpenAI-style key");
  assert.ok(!/AIza[a-zA-Z0-9_-]{10,}/.test(text), "must not hardcode Google key");
});

test("wrapper does not claim worker already spawns MCP (current state is direct HTTP)", () => {
  const text = readFileSync(fileURLToPath(WRAPPER), "utf8");
  // The header must acknowledge search-providers.ts currently uses direct HTTP,
  // not claim MCP is already wired up.
  assert.match(text, /search-providers\.ts.*直接 HTTP|尚未 spawn MCP|预留/);
});

test("drop-in defaults to disabled (grayscale off)", () => {
  const text = readFileSync(fileURLToPath(DROPIN), "utf8");
  assert.match(text, /GEOHOT_SEARCH_MCP_ENABLED=0/);
});

test("drop-in references private key env path, not committed secrets", () => {
  const text = readFileSync(fileURLToPath(DROPIN), "utf8");
  assert.match(text, /\/etc\/geohot\/search-mcp\.env/);
});

test("drop-in does not reference localhost", () => {
  const text = readFileSync(fileURLToPath(DROPIN), "utf8");
  assert.ok(!/localhost|127\.0\.0\.1/.test(text), "must not reference localhost");
});
