// box 常驻保活：在主库（24 小时在线、不依赖本机）上长期跑一个 MCP 会话，
// 每 60 秒做一次真实工具调用（list_dir /workspace）。
//
// 为什么不是「定时唤醒」：平台按「有没有客户端在用它」判断空闲，定时器每 4 分钟
// 只能把已经休眠的 box 拉起来（中间仍有 0–4 分钟不可用）。这里保持会话 + 每分钟一次
// 真实调用，让 box 一直有活动，从而不留休眠窗口；一旦连接断了就自己重连（重连握手
// 本身也会唤醒休眠中的 box）。
//
// 事实依据（2026-11-14 实测）：MCP 端点 https://mcp.box.simular.ai/mcp/<id> 只暴露
// shell/read_file/browser_* 等工具，没有 box_ensure；但完成 initialize 握手就能把
// hibernate 的 box 唤醒（实测 state: hibernated → running）。
import { readFileSync } from "node:fs";

const TOKEN_FILE = process.env.BOX_TOKEN_FILE || "/etc/geohot/box-token";
const BOX_ID = process.env.BOX_ID || "cb-7fa22857e41f";
const ENDPOINT = `https://mcp.box.simular.ai/mcp/${BOX_ID}`;
const TICK_MS = Number(process.env.BOX_HOLD_TICK_MS || 60_000);

const token = readFileSync(TOKEN_FILE, "utf8").trim();
if (!token) {
  console.log("no token");
  process.exit(1);
}

const baseHeaders = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

function parseBody(text, contentType) {
  if ((contentType || "").includes("text/event-stream")) {
    const out = [];
    for (const block of text.split("\n\n")) {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        out.push(JSON.parse(line.slice(6)));
      } catch {}
    }
    return out.at(-1) ?? null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let sid = null;
let nextId = 1;

async function rpc(method, params) {
  const headers = { ...baseHeaders };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  const newSid = res.headers.get("mcp-session-id");
  if (newSid) sid = newSid;
  return { status: res.status, body: parseBody(text, res.headers.get("content-type")) };
}

async function handshake() {
  sid = null;
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "geohot-box-hold", version: "1" },
  });
  if (init.status !== 200) throw new Error(`initialize status=${init.status}`);
  // notifications/initialized：无 id，服务端一般回 202
  const headers = { ...baseHeaders, "mcp-session-id": sid };
  await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  log(`handshake ok sid=${sid ? "set" : "none"}`);
}

async function tick() {
  if (!sid) await handshake();
  const probe = await rpc("tools/call", { name: "list_dir", arguments: { path: "/workspace" } });
  if (probe.status !== 200 || probe.body?.error) {
    throw new Error(`probe status=${probe.status} err=${probe.body?.error?.message ?? "none"}`);
  }
  log("awake");
}

// 主循环：任何异常都退避 15 秒后重新握手（重连会顺带唤醒休眠中的 box）。
for (;;) {
  try {
    await tick();
  } catch (error) {
    log(`reconnect: ${(error && error.message) || error}`);
    sid = null;
    await new Promise((r) => setTimeout(r, 15_000));
    continue;
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
