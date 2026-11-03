// 条目页的原文链接防护：`links.original` 是采集链给的字符串，前端不假设上游已经筛过
// scheme（lib/safe-url.ts）——`javascript:` 之类只能落成纯文本，绝不写进 href。
// 用真 SSR 输出断言（不起浏览器、不连数据库），走的是 build/server/index.js 里那份
// 打过包的路线代码，所以跑之前要先 npm run build -w @aihot/web。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);
const base = built ? String((await import(pathToFileURL(SERVER_BUILD).href)).basename ?? "/").replace(/\/+$/, "") : "";

const outline = [
  { id: "di-zhen-can-shu", text: "地震参数", level: 2 },
  { id: "shou-ying-qu-yu", text: "受影响区域", level: 2 },
];

/** 一份 SiteItemDetail：只有 original 这个字段按参数给——其余形状与 item-toolbar.test.ts 同源。 */
const item = (original: string) => ({ id: "it-1",
  revision: 1,
  title: "某地发生 5.2 级地震",
  originalTitle: null,
  summary: "北京时间今日凌晨发生 5.2 级地震。",
  reason: null,
  source: { id: "src-1", name: "国家地震台网", kind: "rss", firstParty: true, iconUrl: null },
  links: { aihot: "/items/it-1", original },
  publishedAt: "2026-10-02T03:04:05.000Z",
  discoveredAt: "2026-10-02T03:10:00.000Z",
  timelineAt: "2026-10-02T03:04:05.000Z",
  category: null,
  tags: ["地震"],
  score: 78,
  selected: true,
  channel: "news",
  story: null,
  x: null,
  hasTranslation: false,
  bodyLanguage: "zh",
  readingMode: "full",
  author: null,
  language: "zh",
  body: {
    zh: outline.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>本节内容。</p>`).join(""),
    original: null,
    zhKind: "original",
    complete: true,
  },
  outline,
  relatedStories: [],
  indexable: true,
  markdownAvailable: true,
  group: null,
});

/** 把条目页渲染成 HTML；除了这一条 item 与站点 meta 之外不打任何请求。 */
async function render(original: string): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/items/")) return Response.json(item(original));
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    throw new Error(`测试不放行任何真实请求：${url}`);
  }) as typeof fetch;
  try {
    const build = await import(pathToFileURL(SERVER_BUILD).href);
    const handler = createRequestHandler(build, "production");
    const res = await handler(new Request(`https://xxc2007.me${base}/items/it-1`));
    assert.equal(res.status, 200, "SSR 没能渲染条目页");
    return await res.text();
  } finally {
    globalThis.fetch = real;
  }
}

const skip = built ? false : "需要先 npm run build -w @aihot/web";

test("javascript: 的原文地址渲染为纯文本，不进任何 href", { skip }, async () => {
  const html = await render("javascript:alert(document.cookie)");
  assert.ok(!/href\s*=\s*"javascript:/i.test(html), "HTML 里出现了 javascript: 链接");
  assert.ok(!/href\s*=\s*"\s*\/\//i.test(html), "协议相对地址也不能写进 href");
  // 三处原文入口（桌面按钮、手机条、页脚来源行）都要降级成不带 href 的纯文本，且说得清楚为什么。
  const degraded = html.match(/<span[^>]*title="原文地址不是 http\(s\)[^>]*>/g) ?? [];
  assert.ok(degraded.length >= 3, `桌面按钮、手机条与页脚来源行都该有降级提示，实际 ${degraded.length} 处`);
  assert.match(html, /<span[^>]*title="原文地址不是 http\(s\) 地址，只作文字显示"[^>]*>打开原文<\/span>/, "桌面按钮降级为不带 href 的纯文本");
  assert.match(html, /来源：[\s\S]{0,200}?<span[^>]*>[\s\S]{0,80}?国家地震台网<\/span>/, "页脚来源行降级后仍显示来源名");
});

test("http(s) 的原文地址照常成为外链（对照组）", { skip }, async () => {
  const html = await render("https://example.org/report");
  assert.match(html, /<a[^>]*href="https:\/\/example\.org\/report"[^>]*rel="noopener noreferrer"/);
  assert.ok(!html.includes("原文地址不是 http"), "安全地址不该出现降级提示");
});
