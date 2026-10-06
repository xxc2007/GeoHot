// 条目页与事件页的四件行为，用真 SSR 输出断言（不起浏览器、不连数据库）：
//   1. 「目录」入口在 ≤1024px 的服务端 HTML 里就存在，抽屉本体按需加载、不在首帧；
//   2. 「返回」按 ?from= 写明去处，落点与文案一致，认不出的来路不编去处；
//   3. 「N 篇报道」那个数等于点开能看到的行数（不含读者自己那一条）；
//   4. 摘要的两行截断挂在 `scripting: enabled` 上——没有脚本时不截断，读者能读完。
// 走的是 build/server/index.js 里那份打过包的路线代码，所以跑之前要先 npm run build -w @aihot/web。
// 这份构建没有 BASE_PATH（根部署）：?from=/geohot/hot 在这里认不出，正是"前缀要按部署剥"的另一面。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);

const items = [
  { id: "di-zhen-can-shu", text: "地震参数", level: 2 },
  { id: "shou-ying-qu-yu", text: "受影响区域", level: 2 },
  { id: "yu-zhen-ji-ding", text: "余震预计", level: 3 },
  { id: "zi-liao-lai-yuan", text: "资料来源", level: 2 },
];

/** 一份 SiteItemDetail：有正文、有 4 级 outline，够把目录与返回两条分支都跑到。 */
const item = {  id: "it-1",
  revision: 1,
  title: "某地发生 5.2 级地震",
  originalTitle: null,
  summary: "北京时间今日凌晨发生 5.2 级地震。",
  reason: "震中位于一座水库的库区。",
  source: { id: "src-1", name: "国家地震台网", kind: "rss", firstParty: true, iconUrl: null },
  links: { aihot: "/items/it-1", original: "https://example.org/report" },
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
    zh: items.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>本节内容。</p>`).join(""),
    original: null,
    zhKind: "original",
    complete: true,
  },
  outline: items,
  relatedStories: [],
  indexable: true,
  markdownAvailable: true,
  group: null,
};

/** 一份 StoryDetail 的最小形状：settled 且没有热度，页面只渲染文字，不碰画布。 */
const report = {
  id: "it-1",
  title: "某地发生 5.2 级地震",
  summary: "北京时间今日凌晨发生 5.2 级地震。",
  source: { id: "src-1", name: "国家地震台网", kind: "rss", firstParty: true, iconUrl: null },
  publishedAt: "2026-10-02T03:04:05.000Z",
  originalUrl: "https://example.org/report",
  selected: true,
  factId: "f-1",
};
const story = {
  publicId: "st-1",
  title: "某地 5.2 级地震",
  status: "settled",
  reportCount: 1,
  sourceCount: 1,
  firstReportAt: "2026-10-02T03:04:05.000Z",
  latestAt: null,
  digest: null,
  digestUpdatedAt: null,
  summary: "一次 5.2 级地震。",
  excerpt: null,
  latest: null,
  whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null, heat: null },
  developments: [],
  officialReports: [],
  timeline: [report],
  heat: [],
  related: [],
};

/** 把页面在服务端渲染成 HTML；除了这一条 item、这一条 story 与站点 meta 之外不打任何请求。 */
async function render(page: string): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/items/")) return Response.json(item);
    if (url.includes("/api/site/stories/")) return Response.json(story);
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    throw new Error(`测试不放行任何真实请求：${url}`);
  }) as typeof fetch;
  try {
    const build = await import(pathToFileURL(SERVER_BUILD).href);
    const handler = createRequestHandler(build, "production");
    const res = await handler(new Request(`https://xxc2007.me${page}`));
    assert.equal(res.status, 200, `SSR 没能渲染 ${page}`);
    return await res.text();
  } finally {
    globalThis.fetch = real;
  }
}

const skip = built ? false : "需要先 npm run build -w @aihot/web";

test("条目的目录入口在服务端 HTML 里就有，抽屉本体等点击之后再加载", { skip }, async () => {
  const html = await render("/items/it-1");
  // 工具栏那个按钮：有名字、明确它要打开一个对话框、并报告自己是关着的。
  assert.match(html, /<button[^>]*aria-label="本文目录"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-expanded="false"[^>]*>[\s\S]{0,400}?目录/);
  // 侧栏里那份目录树照旧（≥1024px 用它），抽屉里的清单与关闭按钮都还没进首帧。
  assert.match(html, /<nav aria-label="本文目录">[\s\S]{0,200}?<a href="#di-zhen-can-shu"/);
  assert.ok(!html.includes("关闭目录"), "TocSheet 是按需加载的，不该出现在首帧");
  // 没有 JavaScript 时那个按钮按不动：outline 本来就在服务端的 HTML 里，noscript 分支给一条不要脚本就能走的路。
  assert.match(html, /<noscript><details[^>]*>[\s\S]{0,160}?本文目录[\s\S]{0,400}?<a href="#di-zhen-can-shu"/);
});

test("?from= 写明返回的去处，落点与文案一致", { skip }, async () => {
  const hot = await render("/items/it-1?from=/hot");
  assert.match(hot, /<a[^>]*href="\/hot"[^>]*>[\s\S]{0,400}?<!-- -->返回热点榜<\/a>/);
  assert.ok(!hot.includes("<!-- -->返回</button>"), "知道去处就不该再留一个光秃秃的、猜落点的返回");

  // 查询串跟着走：从带筛选的 /all 进来，就回到那个筛选结果。
  const tagged = await render(`/items/it-1?from=${encodeURIComponent("/all?tag=地震&page=2")}`);
  assert.match(tagged, /<a[^>]*href="\/all\?tag=[^"]*page=2"[^>]*>[\s\S]{0,400}?<!-- -->返回全部动态<\/a>/);

  // 事件页左上角同一套规矩。
  const fromTopic = await render("/story/st-1?from=/topics/zai-hai");
  assert.match(fromTopic, /<a[^>]*href="\/topics\/zai-hai"[^>]*>[\s\S]{0,400}?<!-- -->主题页<\/a>/);
  assert.ok(fromTopic.includes("某地 5.2 级地震"), "事件页本身照常渲染");
  const plainStory = await render("/story/st-1");
  assert.match(plainStory, /<a[^>]*href="\/hot"[^>]*>[\s\S]{0,400}?<!-- -->热点榜<\/a>/);
});

test("认不出的来路不编去处：站外地址与前缀不符的路径都退回中性的返回", { skip }, async () => {
  const outside = await render(`/items/it-1?from=${encodeURIComponent("//evil.example.com/hot")}`);
  assert.ok(!outside.includes("evil.example.com"), "协议相对地址不能变成落点");
  assert.match(outside, /<!-- -->返回<\/button>/);
  assert.ok(!outside.includes("<!-- -->返回热点榜"), "站外的 /hot 不算来路，不该写成返回热点榜");

  // 这份构建是根部署：/geohot/hot 不属于本站的任何一页。前缀由 appPath() 按构建期的 BASE_PATH 剥，
  // 换 BASE_PATH=/geohot 重新构建后同一条链接就认得，href 也照样带着 /geohot。
  const prefixed = await render(`/items/it-1?from=${encodeURIComponent("/geohot/hot")}`);
  assert.ok(!prefixed.includes("返回热点榜"));
  assert.match(prefixed, /<!-- -->返回<\/button>/);
});

// 「另有 N 篇报道」那句要说的是点开之后看得见的行数。列表把读者正在看的这一条排除了
// （`ReadingGroup.tsx` 的 `others`），提示却印了含它自己的总数——于是写着「3 篇报道」，下面永远只有 2 行。
test("「N 篇报道」等于点开能看到的行数，不含读者自己那一条", { skip }, async () => {
  const previous = item.group;
  try {
    (item as { group: unknown }).group = { factId: "f-1", story: null, reportCount: 3, additionalSourceCount: 0 };
    const html = await render("/items/it-1");
    assert.match(html, />2 篇报道</, "总数 3 减去读者正在看的这一条 = 面板里的 2 行");
    assert.ok(!html.includes("3 篇报道"), "不能再拿含它自己的总数当提示");
    // 多信源那条分支不动：它数的是「家」，本来就是列表之外的信息。
    (item as { group: unknown }).group = { factId: "f-1", story: null, reportCount: 3, additionalSourceCount: 2 };
    const multi = await render("/items/it-1");
    assert.match(multi, /另有 2 家信源报道</);
  } finally {
    (item as { group: unknown }).group = previous;
  }
});

// 事件页摘要是「客户端量一下才知道要不要截断」的那种块。没脚本就量不到，于是按钮不会出现，
// 而截断若照常生效，读者就永远读完整段（`root.tsx` 的 noscript 告示承诺「事件页照常可读」）。
// 所以截断这条规则要挂在「这个浏览器真的能跑脚本」上：不认识这个媒体特性的浏览器整条不匹配，
// 默认落在不截断那一侧——降级方向是对的。
test("摘要的两行截断只在能跑脚本时生效，关掉 JavaScript 也能读完", { skip }, async () => {
  const html = await render("/story/st-1");
  const paragraph = /<p class="[^"]*text-\[14px\][^"]*">北京时间今日凌晨发生 5\.2 级地震。<\/p>/.exec(html)?.[0];
  assert.ok(paragraph, "事件页时间线那条摘要要能定位到");
  assert.match(paragraph, /\[@media\(scripting:enabled\)\]:line-clamp-2/, "截断要挂在 scripting:enabled 上");
  assert.ok(!/\sline-clamp-2/.test(paragraph), "裸的 line-clamp-2 会在没有脚本时也截断，读者没有出路");
});

