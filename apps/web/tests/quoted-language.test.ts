// fallback 模式的中文引用译文在 /en 上仍是中文：条目页与列表卡片都要带 `lang="zh-Hans"`
// 和一句 “Quoted translation in Chinese”，不能因为字段名叫 translation 就当成英文译文。
// 走 build/server/index.js，所以先 `npm run build -w @aihot/web`。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);
const GENERATED_AT = "2026-11-23T02:00:00.000Z";
const ZH_QUOTE = "被引用帖子的中文译文。";
const ORIGINAL = "被引用帖子的中文原文。";

const QUOTED = {
  authorName: "Quoted Author",
  handle: "quoted",
  text: ORIGINAL,
  url: "https://x.com/quoted/status/1",
  translation: ZH_QUOTE,
  translationLocale: "zh" as const,
};

const ITEM = {
  id: "x-1", revision: 1, title: "Magnitude 7.1 earthquake strikes southern Tibet", originalTitle: null,
  summary: "The network recorded the quake at 06:12.", reason: null,
  source: { id: "s-1", name: "CENC", kind: "x_search" as const, firstParty: false, iconUrl: null, nameLocale: "en" as const },
  links: { aihot: "/items/x-1", original: "https://x.com/quoted/status/1" },
  publishedAt: GENERATED_AT, discoveredAt: GENERATED_AT, timelineAt: GENERATED_AT,
  category: null, tags: [], score: 80, selected: true, channel: "x" as const, story: null,
  x: { authorName: "Post Author", handle: "post", avatarUrl: null, quoted: QUOTED, media: [] },
  textLocale: "en" as const, readingMode: "summary-licence" as const, author: null, language: "zh",
  body: null, outline: [], relatedStories: [], indexable: false, markdownAvailable: false, group: null,
  topics: [{ slug: "earthquakes", name: "Earthquakes" }],
};

const FEED_ITEM = {
  id: "x-1", title: ITEM.title, originalTitle: null, summary: ITEM.summary, reason: null,
  source: { name: "CENC", nameLocale: "en" as const },
  publishedAt: GENERATED_AT, timelineAt: GENERATED_AT, category: null, tags: [], score: 80, selected: true,
  channel: "x" as const, textLocale: "en" as const,
  x: { authorName: "Post Author", handle: "post", avatarUrl: null, media: [], quoted: { ...QUOTED, url: undefined } },
};

const POOL = {
  filters: { channel: "all", category: null, tag: null, topic: null, q: null, tab: "time" },
  items: [FEED_ITEM], page: 1, pageCount: 1, total: 1, todayCount: 1, freshness: GENERATED_AT, generatedAt: GENERATED_AT,
};

async function render(pathname: string): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    if (url.includes("/api/site/items/x-1")) return Response.json(ITEM);
    if (url.includes("/api/site/topics")) return Response.json({ topics: [{ slug: "earthquakes", name: "Earthquakes", nameEn: "Earthquakes" }] });
    if (url.includes("/api/site/pool")) return Response.json(POOL);
    if (url.includes("/api/site/calendar")) return Response.json({ month: "2026-11", days: [] });
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

test("条目页：fallback 的中文引用译文带 lang 与 in Chinese 说明", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/en/items/x-1");
  assert.ok(html.includes("Quoted translation in Chinese"), "缺少中文引用译文的说明");
  assert.ok(html.includes("lang=\"zh-Hans\""), "中文译文没有 zh-Hans 语言属性");
  assert.ok(html.includes(ZH_QUOTE), "中文译文没有渲染");
});

test("列表卡片：fallback 的中文引用译文同样带 lang 与 in Chinese 说明", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/en/all");
  assert.ok(html.includes("Quoted translation in Chinese"), "卡片缺少中文引用译文的说明");
  assert.ok(html.includes("lang=\"zh-Hans\""), "卡片的中文译文没有 zh-Hans 语言属性");
  assert.ok(html.includes(ZH_QUOTE), "卡片的中文译文没有渲染");
});