#!/usr/bin/env node
/**
 * InstaBox 保活（挂在主库上跑，不依赖任何人的电脑）。
 *
 * 为什么需要它：
 *   - 免费档固定「30 分钟没人用就自动暂停」，这个值在 API 上是 403 spec_not_allowed，改不了；
 *   - 免费档每次运行还有 maxRunMinutes（起 120 分钟，用得多会长到 480），到点平台会把机器停掉；
 *   - 沙箱里的执行器只往外连（ssh 隧道），平台看不到任何「入向活动」，所以光跑进程不算有人在用。
 *
 * 这个脚本做三件事，每 60 秒一轮：
 *   1. 读一次机器状态；不在 running 就 POST /wake 把它叫起来；
 *   2. 叫着之后（以及每 10 分钟）执行一条极短命令 —— 这既是「入向活动」，也顺手确认执行器还活着；
 *   3. 执行器没在跑就调 /data/geohot-boot/bootstrap.sh 装回去（根盘可能被模板重置，/data 才是持久的）。
 *
 * 环境：INSTABOX_MACHINE（机器 id）、INSTABOX_TOKEN_FILE（token 文件，600）、
 *       INSTABOX_API（默认 https://api.instabox.sh）、INSTABOX_POLL_MS（默认 60000）、
 *       INSTABOX_ACTIVE_MS（默认 600000，多久做一次入向活动）。
 * token 只从文件读，永远不打印、不进日志。
 */
import { readFile } from "node:fs/promises";

const API = (process.env.INSTABOX_API ?? "https://api.instabox.sh").replace(/\/+$/, "");
const MACHINE = process.env.INSTABOX_MACHINE?.trim();
const TOKEN_FILE = process.env.INSTABOX_TOKEN_FILE?.trim() || "/etc/geohot/instabox-token";
const POLL_MS = positive(process.env.INSTABOX_POLL_MS, 60_000, 15_000);
const ACTIVE_MS = positive(process.env.INSTABOX_ACTIVE_MS, 600_000, 60_000);
const BOOTSTRAP = "/data/geohot-boot/bootstrap.sh";

function positive(raw, fallback, min) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, machine: MACHINE, ...extra }));
}

async function call(path, init = {}, timeoutMs = 25_000) {
  const token = (await readFile(TOKEN_FILE, "utf8")).trim();
  if (!token) throw new Error("instabox token file is empty");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

async function state() {
  const res = await call(`/v1/machines/${encodeURIComponent(MACHINE)}`);
  if (res.status !== 200 || !res.body) throw new Error(`state failed: ${res.status} ${res.text.slice(0, 120)}`);
  return res.body;
}

async function wake() {
  // 2026-11-16 实测：机器被暂停后 /wake 会回 409 machine_not_running（"start it first"），
  // 真正能把它拉起来的是 /start；两个都试，按状态挑顺序，省一次无用的 409。
  const res = await call(`/v1/machines/${encodeURIComponent(MACHINE)}/wake`, { method: "POST", body: "{}" }, 120_000);
  if (res.status >= 300) throw new Error(`wake failed: ${res.status} ${res.text.slice(0, 160)}`);
  return res.body ?? {};
}

async function start() {
  const key = `geohot-hold-${MACHINE}-${Math.floor(Date.now() / 60_000)}`;
  const res = await call(
    `/v1/machines/${encodeURIComponent(MACHINE)}/start`,
    { method: "POST", body: "{}", headers: { "idempotency-key": key } },
    180_000,
  );
  if (res.status >= 300) throw new Error(`start failed: ${res.status} ${res.text.slice(0, 160)}`);
  return res.body ?? {};
}

/** 不在 running 时先 /start（suspended 只有它能救），/start 不适用才退回 /wake。 */
async function revive(state) {
  const suspended = ["suspended", "stopped", "stopping", "unknown"].includes(String(state));
  const first = suspended ? start : wake;
  const second = suspended ? wake : start;
  try {
    return { via: first === start ? "start" : "wake", body: await first() };
  } catch (error) {
    const note = String(error.message ?? error).slice(0, 120);
    return { via: second === start ? "start" : "wake", body: await second(), firstError: note };
  }
}

async function run(cmd, timeoutMs = 60_000) {
  const res = await call(
    `/v1/machines/${encodeURIComponent(MACHINE)}/exec`,
    { method: "POST", body: JSON.stringify({ cmd, timeoutSeconds: Math.ceil(timeoutMs / 1000) }) },
    timeoutMs + 10_000,
  );
  if (res.status >= 300) throw new Error(`exec failed: ${res.status} ${res.text.slice(0, 160)}`);
  return res.body ?? {};
}

/** 执行器要在岗：不在岗就把 /data 上的那份自举脚本重放一遍（幂等）。 */
async function ensureExecutor() {
  const probe = await run("systemctl is-active geohot-exec-tunnel geohot-exec-worker | tr '\\n' ' '", 60_000);
  const text = String(probe?.stdout ?? "");
  if (text.includes("active") && !text.includes("inactive") && !text.includes("failed")) return { ok: true, text };
  const boot = await run(`sudo -n ${BOOTSTRAP} || ${BOOTSTRAP}`, 90_000);
  return { ok: false, text, boot: String(boot?.stdout ?? "").slice(-120) };
}

if (!MACHINE) {
  log("config-error", { note: "INSTABOX_MACHINE is empty" });
  process.exit(2);
}

let lastNote = "";
let lastActiveAt = 0;
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; });

log("start", { api: API, pollMs: POLL_MS, activeMs: ACTIVE_MS });
while (!stopping) {
  try {
    const m = await state();
    const now = Date.now();
    const running = m.state === "running" && m.runtime?.ready !== false;
    if (!running) {
      const note = `state=${m.state} cooldown=${m.cooldownUntil ?? "none"}`;
      if (note !== lastNote) log("wake", { note });
      lastNote = note;
      let revived = null;
      try {
        revived = await revive(m.state);
        log("revived", { via: revived.via, firstError: revived.firstError ?? null });
      } catch (error) {
        log("wake-failed", { error: String(error.message).slice(0, 160) });
      }
      if (revived) {
        await new Promise((r) => setTimeout(r, 25_000));
        try {
          const probe = await ensureExecutor();
          log("boot", { executor: probe.text.trim() });
        } catch (error) {
          log("boot-failed", { error: String(error.message).slice(0, 160) });
        }
      }
    } else if (now - lastActiveAt >= ACTIVE_MS) {
      lastActiveAt = now;
      lastNote = "";
      const probe = await ensureExecutor();
      log("active", {
        note: `executor=${probe.ok ? "in-pool" : "bootstrap"} runStartedAt=${m.runStartedAt ?? "?"} maxRunMinutes=${m.maxRunMinutes ?? "?"}`,
      });
    }
  } catch (error) {
    const note = String(error.message ?? error).slice(0, 160);
    if (note !== lastNote) log("error", { note });
    lastNote = note;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
log("stop");
