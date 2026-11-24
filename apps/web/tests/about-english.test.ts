// /en/about 的英文面守卫（2026-11-24）：
//  1. 正文与四个环节都走字典的 en 一侧，不再出现「本页没有英文版」的整页标注；
//  2. 最新精选只轮播真有英文标题的条目——ENGLISH_TEXT=fallback 时名单里混着中文条目，
//     不能拿中文标题顶成英文页的最新精选；
//  3. 中文页的「最近精选」原样保留中文标题（这一次改动不碰中文输出）。
// 走 build/server/index.js 的打包产物，所以跑之前要先 npm run build -w @aihot/web。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);

/** 线上 fallback 模式的真实形状：精选里只有少数带 title_en，信源名是域名（没有 name_en 也不算中文）。 */
const STATS = {
  sources: 1000,
  heatOnlySources: 12,
  items: 2845,
  selected: 7196,
  dailies: 4,
  lang: "en",
  sourceKinds: { rss: 300, web_list: 300, json_list: 68 },
  day: { collected: 24, selected: 2 },
  sampleSources: [
    { name: "jornal.usp.br", kind: "rss", heatOnly: false },
    { name: "agupubs.onlinelibrary.wiley.com", kind: "web_list", heatOnly: false },
  ],
  latest: [
    {
      id: "zh-1",
      title: "USP参与COP31气候大会 大会未就整体政治决定达成共识",
      source: "jornal.usp.br",
      url: "https://jornal.usp.br/example",
    },
    {
      id: "en-1",
      title: "Magnitude 7.1 earthquake strikes southern Tibet near the Yarlung Tsangpo suture",
      titleEn: "Magnitude 7.1 earthquake strikes southern Tibet near the Yarlung Tsangpo suture",
      source: "agupubs.onlinelibrary.wiley.com",
      url: "https://agupubs.onlinelibrary.wiley.com/example",
    },
  ],
};

const CONTACT = { makerAvatar: null };

/** 只看读者可见的文字：hydration 的 loader 数据会把整份 stats（含中文标题）塞进 <script>。 */
function visible(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ").replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ").replace(/<[^>]+>/g, " ");
}

async function render(pathname: string): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    if (url.includes("/api/site/contact")) return Response.json(CONTACT);
    if (url.includes("/api/site/stats")) return Response.json({ ...STATS, lang: url.includes("lang=en") ? "en" : "zh" });
    throw new Error(`测试不放行任何真实请求：${url}`);
  }) as typeof fetch;
  try {
    const build = await import(pathToFileURL(SERVER_BUILD).href);
    const handler = createRequestHandler(build, "production");
    const base = String(build.basename ?? "/").replace(/\/+$/, "");
    const res = await handler(new Request(`https://xxc2007.me${base}${pathname}`));
    assert.equal(res.status, 200, `SSR 没能渲染 ${pathname}`);
    return await res.text();
  } finally {
    globalThis.fetch = real;
  }
}

test("/en/about 不说「没有英文版」，最新精选只留英文条目", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/en/about");
  const text = visible(html);
  assert.ok(text.includes("About GEOHOT"), "英文页正文没有渲染");
  assert.ok(text.includes("1,000"), "英文页的信源数没有按英文千位分隔");
  assert.ok(text.includes("Magnitude 7.1 earthquake"), "最新精选里没有英文标题");
  assert.ok(!text.includes("USP参与COP31"), "英文页的最新精选仍在显示中文标题");
  assert.ok(!text.includes("no English version"), "英文页仍挂着「没有英文版」的标注");
  assert.ok(!/[\u4e00-\u9fff]/.test(text), "英文页可见文字里仍有中文");
});

test("/about 的最近精选仍是中文标题（中文输出不变）", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/about");
  const text = visible(html);
  assert.ok(text.includes("最近精选"), "中文页的「最近精选」不见了");
  assert.ok(text.includes("1000"), "中文页的信源数没有保持原来的写法");
  assert.ok(text.includes("USP参与COP31气候大会"), "中文页没有显示中文标题的精选");
  assert.ok(!text.includes("Magnitude 7.1 earthquake"), "中文页混进了英文标题");
});