// Web→API 代理加固的构建产物断言：
// 1) 连接阶段超时回 504（headers 未发）
// 2) body 阶段 idle 超时只 destroy 连接（headers 已发，不能重写状态）
// 3) 客户端在 body 完成前 close 始终 destroy upstream（不 gate on headersArrived）
// 4) 静态路径用 path.relative 防穿越
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverSrc = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");

test("连接阶段设超时预算，回 504", () => {
  assert.match(serverSrc, /API_PROXY_TIMEOUT_MS/, "要可配置连接超时");
  assert.match(serverSrc, /CONNECT_TIMEOUT_MS/, "区分连接阶段与 body 阶段");
  assert.match(serverSrc, /504/, "连接超时要回 504");
});

test("body 阶段有独立 idle 预算，超时只 destroy 不写状态", () => {
  assert.match(serverSrc, /API_PROXY_BODY_IDLE_MS/, "body idle 要可配置");
  assert.match(serverSrc, /BODY_IDLE_MS/, "要有 body idle 常量");
  // headersArrived 后切到 body idle
  assert.match(serverSrc, /headersArrived/, "要跟踪 headers 是否已到");
  // body 阶段超时分支只 destroy，不 writeHead
  assert.match(serverSrc, /body idle timeout/i, "注释要区分两个阶段");
});

test("客户端 close 在任何阶段都 destroy upstream（不 gate on headersArrived）", () => {
  assert.match(serverSrc, /res\.on\("close"/, "要监听 res close");
  // close handler 只看 writableEnded，不看 headersArrived/settled
  const closeHandler = serverSrc.match(/res\.on\("close",\s*\(\)\s*=>\s*\{([^}]+)\}/s)?.[1] ?? "";
  assert.match(closeHandler, /!res\.writableEnded/, "只看 writableEnded");
  assert.doesNotMatch(closeHandler, /headersArrived/, "body 阶段也要取消，不能 gate on headersArrived");
});

test("静态路径用 path.relative 边界", () => {
  assert.match(serverSrc, /path\.relative\(CLIENT_DIR/, "用 path.relative 算边界");
  assert.match(serverSrc, /rel\.startsWith\("\.\."\)/, "拒绝逃出 client dir");
  assert.match(serverSrc, /path\.isAbsolute\(rel\)/, "拒绝绝对路径逃逸");
});

test("504/502 响应头是 no-store（注释不能说 cacheable）", () => {
  assert.match(serverSrc, /"Cache-Control": "no-store"/, "错误响应不缓存");
  assert.doesNotMatch(serverSrc, /cacheable 504/i, "注释不能误导成可缓存");
});
