// Mobile audit: walk the reader-facing routes at phone widths and report what a phone actually sees —
// horizontal overflow, tap targets below the 44px guideline, unreadably small type, and fixed layers that
// eat the screen. Screenshots land next to the JSON so a finding can be looked at, not just counted.
//
//   node scripts/mobile-audit.ts --base https://xxc2007.me/geohot --out D:/tmp/mobile-audit
//   node scripts/mobile-audit.ts --base http://127.0.0.1:3000 --widths 360,390,430
//
// Chrome is found the same way `scripts/shoot.ts` finds it (no new dependency): headless Chrome plus the
// DevTools protocol over the WebSocket client Node ships with.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3000" },
    out: { type: "string", default: "D:/tmp/mobile-audit" },
    widths: { type: "string", default: "390" },
    chrome: { type: "string" },
    port: { type: "string", default: "9333" },
    scroll: { type: "string", default: "0" },
    routes: { type: "string", default: "/,/all,/daily,/about,/?category=frontier,/topics" },
  },
});

function findChrome(): string {
  const candidates = [
    flags.chrome,
    ...["chromium-1243", "chromium-1242", "chromium-1241", "chromium-1240", "chromium"]
      .flatMap((dir) => [
        path.join(homedir(), "AppData", "Local", "ms-playwright", dir, "chrome-win64", "chrome.exe"),
        path.join(homedir(), ".cache", "ms-playwright", dir, "chrome-linux", "chrome"),
      ]),
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    "/usr/bin/google-chrome",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) { console.error("找不到 Chrome/Chromium，用 --chrome 指路"); process.exit(2); }
  return found;
}

/** What to measure on every page, in the page's own words. */
const PROBE = `(() => {
  const vw = window.innerWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const describe = (el) => {
    const cls = (el.className && typeof el.className === "string") ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + cls + (text ? " — " + text : "");
  };
  const overflow = document.documentElement.scrollWidth - vw;
  const wide = [...document.querySelectorAll("body *")]
    .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1)
    .slice(0, 6).map((el) => ({ el: describe(el), right: Math.round(el.getBoundingClientRect().right), w: Math.round(el.getBoundingClientRect().width) }));
  const small = [...document.querySelectorAll("a, button, [role=button], input, select, summary")]
    .filter((el) => visible(el) && el.getBoundingClientRect().top < window.innerHeight * 2)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width < 40 || r.height < 40; })
    .slice(0, 8).map((el) => { const r = el.getBoundingClientRect(); return { el: describe(el), w: Math.round(r.width), h: Math.round(r.height) }; });
  const tinyType = [...document.querySelectorAll("body *")]
    .filter((el) => el.children.length === 0 && visible(el) && (el.textContent || "").trim().length > 3)
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
    .slice(0, 6).map((el) => ({ el: describe(el), font: getComputedStyle(el).fontSize }));
  const fixed = [...document.querySelectorAll("body *")]
    .filter((el) => visible(el) && ["fixed", "sticky"].includes(getComputedStyle(el).position))
    .filter((el) => el.getBoundingClientRect().height > window.innerHeight * 0.25)
    .slice(0, 4).map((el) => ({ el: describe(el), h: Math.round(el.getBoundingClientRect().height), pos: getComputedStyle(el).position }));
  return { viewport: [vw, window.innerHeight], docHeight: document.documentElement.scrollHeight, overflow, wide, small, tinyType, fixed, title: document.title };
})()`;

const chrome = findChrome();
const port = Number(flags.port);
const profile = path.join(flags.out!, ".chrome-profile");
mkdirSync(flags.out!, { recursive: true });

const child: ChildProcess = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore", detached: false });

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any> };
let nextId = 1;
async function connect(url: string): Promise<Cdp & { close: () => void; events: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = (e) => reject(e); });
  const pending = new Map<number, (v: any) => void>();
  const events: Array<Record<string, unknown>> = [];
  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: Record<string, any> };
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result); pending.delete(msg.id); return; }
    // Page-level failures are the reason a route can render an error box while its HTTP status is 200.
    if (msg.method === "Runtime.exceptionThrown") events.push({ kind: "exception", text: (msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "").slice(0, 200) });
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type !== "log") events.push({ kind: "console." + String(msg.params?.type), text: (msg.params?.args ?? []).map((a: any) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200) });
    if (msg.method === "Network.loadingFailed") events.push({ kind: "net", text: `${msg.params?.type ?? ""} ${String(msg.params?.errorText ?? "")}`.trim().slice(0, 160) });
    if (msg.method === "Network.responseReceived") {
      const status = Number(msg.params?.response?.status ?? 0);
      if (status >= 400) events.push({ kind: "http", text: `${status} ${String(msg.params?.response?.url ?? "").slice(0, 160)}` });
    }
  };
  return {
    send: (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params: params ?? {} })); }),
    close: () => ws.close(),
    events,
  };
}

async function targetFor(): Promise<string> {
  const deadline = Date.now() + 15_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (error) { last = String(error); }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`CDP not reachable on ${port}: ${last}`);
}

const base = flags.base!.replace(/\/+$/, "");
const widths = flags.widths!.split(",").map(Number).filter((n) => n > 0);
const routes = flags.routes!.split(",").map((r) => r.trim()).filter(Boolean);
const cdp = await connect(await targetFor());
await cdp.send("Network.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
const report: Array<Record<string, unknown>> = [];

try {
  for (const width of widths) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    for (const route of routes) {
      const url = `${base}${route}`;
      cdp.events.length = 0;
      const nav = await cdp.send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, 2500));
      const scrollTo = Number(flags.scroll);
      if (scrollTo > 0) {
        await cdp.send("Runtime.evaluate", { expression: `window.scrollTo(0, document.body.scrollHeight * ${scrollTo}); true` });
        await new Promise((r) => setTimeout(r, 600));
      }
      const evaluated = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
      const value = evaluated?.result?.value as Record<string, unknown> | undefined;
      if (!value) { report.push({ width, route, error: JSON.stringify(evaluated).slice(0, 200) }); continue; }
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(flags.out!, `${width}${route.replace(/[^a-z0-9]+/gi, "_") || "_home"}.png`);
      if (shot?.data) writeFileSync(file, Buffer.from(shot.data, "base64"));
      report.push({ width, route, nav: nav?.frameId ? "ok" : nav, ...value, problems: cdp.events.slice(0, 12), shot: path.basename(file) });
      console.log(JSON.stringify(report[report.length - 1]));
    }
  }
} finally {
  cdp.close();
  await new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve()));
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the profile dir is disposable */ }
}

writeFileSync(path.join(flags.out!, "report.json"), JSON.stringify(report, null, 1));
console.log(`\n报告：${path.join(flags.out!, "report.json")}`);
