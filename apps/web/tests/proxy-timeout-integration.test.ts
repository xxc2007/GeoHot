// 代理超时与取消的真实集成测试：起真实 web server + 合成 API，
// 验证连接阶段 504、body 挂起后连接断开、客户端中途取消传播到上游。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

let web: ChildProcess;
let api: Server;
let origin = "";
let logs = "";
let upstreamDestroyed = false;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, "http://api.local");
    if (url.pathname === "/api/site/meta") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ changelogVersion: "2026-11-16" }));
    }
    // Connect timeout: never respond at all
    if (url.pathname === "/api/site/hang-connect") {
      return; // no res.end, no headers
    }
    // Body idle: send headers immediately, then never write body
    if (url.pathname === "/api/site/hang-body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{\"items\":[");
      // never end
      return;
    }
    // Client disconnect: track if upstream request closes
    if (url.pathname === "/api/site/slow-body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("[");
      req.on("close", () => { upstreamDestroyed = true; });
      // stream slowly; test will abort
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(n === 1 ? "1" : `,${n}`);
        if (n > 20) { clearInterval(t); res.end("]"); }
      }, 200);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");

  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: {
      ...process.env,
      SITE_URL: "https://xxc2007.me",
      WEB_PORT: "0",
      TRUST_PROXY: "false",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      API_PROXY_TIMEOUT_MS: "600",
      API_PROXY_BODY_IDLE_MS: "600",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("web start timeout: " + logs)), 10_000);
    web.on("exit", () => { clearTimeout(timer); reject(new Error("web exited: " + logs)); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const m = logs.match(/"port":(\d+)/);
      if (m) { origin = `http://127.0.0.1:${m[1]}`; clearTimeout(timer); resolve(); }
    });
    web.stderr!.on("data", (c) => { logs += String(c); });
  });
});

after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>((r) => api.close(() => r()));
});

test("连接阶段超时回 504", async () => {
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/site/hang-connect`, { signal: controller.signal });
  assert.equal(res.status, 504, "未响应的连接应在 600ms 后回 504");
  await res.text();
});

test("body 挂起后连接被 destroy（不挂死）", async () => {
  const controller = new AbortController();
  const started = Date.now();
  try {
    const res = await fetch(`${origin}/api/site/hang-body`, { signal: controller.signal });
    assert.equal(res.status, 200, "headers 应正常到达");
    // 读 body，应该在 ~600ms idle 后被中断
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // 连接被 destroy，读到 ECONNRESET 或 socket hang up
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `body idle 应在 ~600ms 断，实际 ${elapsed}ms`);
  } finally {
    controller.abort();
  }
});

test("客户端中途取消传播到上游", async () => {
  upstreamDestroyed = false;
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/site/slow-body`, { signal: controller.signal });
  assert.equal(res.status, 200);
  // 读一点，然后取消
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(upstreamDestroyed, true, "客户端 abort 后上游请求应被 destroy");
});
