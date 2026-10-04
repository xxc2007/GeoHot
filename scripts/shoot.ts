// Re-capture the README screenshots from a running site, so "the pictures match the pages" is a command
// rather than a promise. docs/shots/*.png are 1440x900 viewport captures of the light theme; after a
// deployment or a domain move, re-run this and the README captions come back into date with the site.
//
//   node scripts/shoot.ts --base https://xxc2007.me/geohot            # the three images in docs/shots
//   node scripts/shoot.ts --base http://127.0.0.1:3000 --out /tmp/x    # a staging build
//
// Chrome is found in the Playwright browser cache, then the usual install locations; nothing is
// downloaded and no dependency is added, because a headless screenshot needs only one flag.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

const SHOTS = [
  { file: "home-light.png", route: "/", label: "精选信息流" },
  { file: "hot-light.png", route: "/hot", label: "地理热点榜" },
  { file: "daily-light.png", route: "/daily", label: "日报头版" },
];

const { values: flags } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3000" },
    out: { type: "string", default: "docs/shots" },
    width: { type: "string", default: "1440" },
    height: { type: "string", default: "900" },
    chrome: { type: "string" },
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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error("找不到 Chrome/Chromium。用 --chrome 指路，或先装一次 Playwright 的浏览器缓存。\n查找过：\n" + candidates.map((c) => `  ${c}`).join("\n"));
    process.exit(2);
  }
  return found;
}

const chrome = findChrome();
const outDir = path.resolve(flags.out!);
mkdirSync(outDir, { recursive: true });
const base = flags.base!.replace(/\/+$/, "");

for (const shot of SHOTS) {
  const target = `${base}${shot.route}`;
  const file = path.join(outDir, shot.file);
  console.log(`→ ${shot.file}  ${target}`);
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    "--force-color-profile=srgb",
    "--virtual-time-budget=8000",
    `--window-size=${flags.width},${flags.height}`,
    `--screenshot=${file}`,
    target,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  const bytes = existsSync(file) ? statSync(file).size : 0;
  if (!bytes) {
    console.error(`✗ ${shot.file} 没有生成（${target} 可能打不开）`);
    process.exit(1);
  }
  console.log(`  ${Math.round(bytes / 1024)} KiB · ${shot.label}`);
}
console.log(`\n完成：${outDir}（换域名或改版式后请同步 README 里的说明日期）`);
