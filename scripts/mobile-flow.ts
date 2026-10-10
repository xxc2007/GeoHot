// Interaction walk at phone width: the flows a thumb actually performs, and what each one leaves behind.
// Read-only against whatever base is given; prints one JSON line per step.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3000" },
    width: { type: "string", default: "390" },
    port: { type: "string", default: "9345" },
    chrome: { type: "string" },
    out: { type: "string", default: "D:/tmp/mobile-flow" },
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

const chrome = findChrome();
const port = Number(flags.port);
const width = Number(flags.width);
const base = flags.base!.replace(/\/+$/, "");
mkdirSync(flags.out!, { recursive: true });
const child: ChildProcess = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(flags.out!, ".profile")}`, "about:blank"], { stdio: "ignore" });

let nextId = 1;
async function target(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("CDP not reachable");
}

const ws = new WebSocket(await target());
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (ev: MessageEvent) => {
  const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result); pending.delete(msg.id); }
};
const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const goto = async (url: string) => { await send("Page.navigate", { url }); await new Promise((r) => setTimeout(r, 2500)); };

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

const steps: Array<Record<string, unknown>> = [];
const record = (name: string, value: unknown) => { steps.push({ step: name, value }); console.log(JSON.stringify({ step: name, value })); };

// 1. home → scroll into the list → tap a category chip → does the list change and the page come back to top?
await goto(`${base}/`);
await evaluate("window.scrollTo(0, 1200); true");
const before = await evaluate("({ y: Math.round(window.scrollY), first: document.querySelector('main a[href*=\"/items/\"]')?.textContent?.slice(0, 24) })");
const chipTapped = await evaluate(`(() => {
  const chip = [...document.querySelectorAll('nav a')].find((a) => a.textContent.trim() === '前沿地理');
  if (!chip) return { ok: false, why: 'chip not found' };
  chip.click();
  return { ok: true, href: chip.getAttribute('href') };
})()`);
await new Promise((r) => setTimeout(r, 2500));
const after = await evaluate("({ url: location.pathname + location.search, y: Math.round(window.scrollY), first: document.querySelector('main a[href*=\"/items/\"]')?.textContent?.slice(0, 24), count: document.querySelectorAll('main a[href*=\"/items/\"]').length })");
record("tap-category-chip", { tapped: chipTapped, before, after });

// 2. open the first item from the list → then go back → is the scroll position kept?
const itemHref = await evaluate("document.querySelector('main a[href*=\"/items/\"]')?.getAttribute('href') ?? null");
await evaluate("window.scrollTo(0, 600); true");
const scrollBeforeNavigate = await evaluate("Math.round(window.scrollY)");
if (itemHref) {
  // `base` already carries the deployment subpath, so the href from the page is used as-is (joining base
  // with it again produced /geohot/geohot/... on the first run — a probe bug that looked like a 404).
  await goto(itemHref.startsWith("http") ? itemHref : `${new URL(base).origin}${itemHref}`);
  const itemState = await evaluate("({ title: document.title.slice(0, 40), h1: document.querySelector('h1')?.textContent?.slice(0, 30), hasBack: !!document.querySelector('a[href=\"/\"], button') })");
  await send("Page.navigateToHistoryEntry", {}).catch(() => {});
  await evaluate("history.back(); true");
  await new Promise((r) => setTimeout(r, 2000));
  const backState = await evaluate("({ url: location.pathname, y: Math.round(window.scrollY) })");
  record("open-item-then-back", { itemHref, scrollBeforeNavigate, itemState, backState });
}

// 3. the bottom tab bar's 更多 — what does it do?
await goto(`${base}/`);
const more = await evaluate(`(() => {
  const btn = document.querySelector('a[href$="/more"]') ?? [...document.querySelectorAll('nav a, nav button')].find((el) => el.textContent.trim() === '更多');
  if (!btn) return { ok: false };
  const tag = btn.tagName.toLowerCase();
  btn.click();
  return { ok: true, tag, href: btn.getAttribute?.('href') ?? null };
})()`);
await new Promise((r) => setTimeout(r, 1500));
const moreAfter = await evaluate("({ url: location.pathname + location.search, dialog: !!document.querySelector('[role=dialog], [role=menu]'), text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120) })");
record("tap-more", { more, moreAfter });

// 4. the search control on the home page
await goto(`${base}/`);
const search = await evaluate(`(() => {
  const el = [...document.querySelectorAll('a[href*="q="], button[aria-label*="搜索"], input[type=search]')][0];
  if (!el) return { ok: false };
  const tag = el.tagName.toLowerCase();
  el.click();
  return { ok: true, tag, href: el.getAttribute('href') ?? null };
})()`);
await new Promise((r) => setTimeout(r, 1200));
const searchAfter = await evaluate("({ url: location.pathname + location.search, input: !!document.querySelector('input[type=search], input[placeholder*=\"搜索\"]'), focused: document.activeElement?.tagName?.toLowerCase() })");
record("tap-search", { search, searchAfter });

ws.close();
await new Promise<void>((res) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => res()));
try { rmSync(path.join(flags.out!, ".profile"), { recursive: true, force: true }); } catch { /* disposable */ }
