#!/usr/bin/env node
// InstaBox 保活：免费档「30 分钟没人用就自动暂停」，而沙箱里的执行器是**主动往外连**（SSH 隧道到主库），
// 平台看不到任何入向活动，所以只要没人调 API，它 30 分钟就睡过去，心跳随即消失。
//
// 这里每 20 分钟打一次 POST /v1/machines/<id>/wake：文档写明它「Records activity on a running machine」，
// 也就是既算活动、又在真睡了的时候把它叫醒（等待 resume 完成）。和 box 的常驻 MCP 会话是同一个思路，
// 只是 InstaBox 的 MCP 网关不接受我们的 API key（实测 401 invalid bearer token），所以走 REST。
//
// 环境：
//   INSTABOX_TOKEN_FILE  默认 /etc/geohot/instabox-token（600，只放 key）
//   INSTABOX_MACHINE     机器 id（m_...）
//   INSTABOX_EVERY_MS    默认 20 分钟
import { readFileSync } from "node:fs";

const tokenFile = process.env.INSTABOX_TOKEN_FILE || "/etc/geohot/instabox-token";
const machine = (process.env.INSTABOX_MACHINE || "").trim();
const everyMs = Number(process.env.INSTABOX_EVERY_MS || 20 * 60_000);
const api = process.env.INSTABOX_API || "https://api.instabox.sh";

function token() {
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch (error) {
    console.error(JSON.stringify({ event: "token-unreadable", file: tokenFile, error: String(error?.message ?? error) }));
    return "";
  }
}

if (!machine) {
  console.error(JSON.stringify({ event: "no-machine", hint: "设置 INSTABOX_MACHINE=m_..." }));
  process.exit(2);
}

let last = "";
let backoff = everyMs;

async function tick() {
  const key = token();
  if (!key) {
    // 没有 key 就别空转：退到最慢，等运维补文件
    backoff = Math.min(30 * 60_000, Math.max(everyMs, backoff * 2));
    return;
  }
  let note;
  try {
    const res = await fetch(`${api}/v1/machines/${machine}/wake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    let state = "";
    let suspended = "";
    try {
      const parsed = JSON.parse(body);
      state = parsed.state ?? "";
      suspended = parsed.autoSuspendedAt ?? "";
    } catch {}
    note = `status=${res.status} state=${state}${suspended ? ` autoSuspendedAt=${suspended}` : ""}`;
    if (res.status === 200) {
      backoff = everyMs;
    } else if (res.status === 429 || res.status === 409 || res.status >= 500) {
      backoff = Math.min(30 * 60_000, backoff * 2);
      note += ` body=${body.slice(0, 160)}`;
    } else {
      // 401/403 这类是配置问题，重复打印没有意义，只记一次
      backoff = Math.min(30 * 60_000, everyMs * 4);
      note += ` body=${body.slice(0, 160)}`;
    }
  } catch (error) {
    backoff = Math.min(30 * 60_000, backoff * 2);
    note = `error=${String(error?.message ?? error)}`;
  }
  if (note !== last) {
    console.log(JSON.stringify({ event: "wake", machine, note, nextMs: backoff }));
    last = note;
  }
}

console.log(JSON.stringify({ event: "start", machine, everyMs }));
for (;;) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, backoff));
}
