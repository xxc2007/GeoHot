// The Agent 接入 page is read by the agents that connect to this site, so a tool it forgets to list is a tool
// nobody calls. It said 「五个工具」 and listed five bullets while `apps/api/src/routes/mcp.ts` registered
// seven (found by a read-only docs audit, 2026-10-04: the weekly and monthly reports were missing) — and the
// page's own target audience is the reader that goes looking for the tools by name.
//
// The count is now derived from `MCP_TOOL_NAMES` in the page itself, so the only thing left to pin is that
// every tool name is actually on the page, and that the prose never goes back to a hand-written numeral.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";

const page = readFileSync(new URL("../apps/web/app/routes/agent.tsx", import.meta.url), "utf8");

test("每一个 MCP 工具都在 Agent 接入页上点名，工具数量不写死", () => {
  for (const key of Object.keys(MCP_TOOL_NAMES)) {
    assert.ok(page.includes(`{T.${key}}`), `agent.tsx 的清单漏了 ${key}（MCP 注册了 ${Object.keys(MCP_TOOL_NAMES).length} 个工具，页面列不出来的那几个等于不存在）`);
  }
  // The heading and the section title both read the count off the table; a numeral back in either is the drift
  // this file exists to catch.
  assert.equal(/["»」]?[一二三四五六七八九十]+\s*个工具/.test(page), false, "「几个工具」必须由 MCP_TOOL_NAMES 推出，不能手写数字");
  assert.ok(page.includes("const TOOL_COUNT = Object.keys(T).length;"), "agent.tsx 不再从 MCP_TOOL_NAMES 数工具数：本文件的断言要跟着重新想");
});
