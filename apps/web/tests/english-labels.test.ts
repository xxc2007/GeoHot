// 2026-11-23 验收的两条英文面守卫：
//  1. 英文列表卡片的 AI 摘要回退中文时，每张卡自己带一枚 "AI digest, in Chinese"（不能只靠顶部一句）；
//  2. /en/hot 的副标题在 1 个事件时说 "event"，不是 "The 1 events"。
// 走 build/server/index.js 的打包产物，所以跑之前要先 npm run build -w @aihot/web。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);

const GENERATED_AT = "2026-11-23T02:00:00.000Z";

/** A card whose AI summary is Chinese: the exact shape `/en/all` receives in ENGLISH_TEXT=fallback. */
const ZH_ITEM = {
  id: "zh-1",
  revision: 1,
  title: "中国地震台网中心正式测定西藏南部 Mw 7.1 地震",
  originalTitle: null,
  summary: "中国地震台网中心发布测定结果，震中位于西藏南部，震源深度 10 千米。",
  reason: null,
  source: { name: "中国地震台网中心", nameLocale: "zh" },
  publishedAt: "2026-11-23T01:30:00.000Z",
  timelineAt: "2026-11-23T01:30:00.000Z",
  category: "physical",
  tags: [],
  score: 80,
  selected: true,
  channel: "news",
  textLocale: "zh",
};

const EN_ITEM = {
  ...ZH_ITEM,
  id: "en-1",
  title: "Magnitude 7.1 earthquake strikes southern Tibet",
  summary: "The China Earthquake Networks Center reports the epicentre in southern Tibet at a depth of 10 km.",
  source: { name: "CENC", nameLocale: "en" },
  textLocale: "en",
};

const POOL = {
  filters: { channel: "all", category: null, tag: null, topic: null, q: null, tab: "time" },
  items: [ZH_ITEM, EN_ITEM],
  page: 1,
  pageCount: 1,
  total: 2,
  todayCount: 2,
  freshness: GENERATED_AT,
  generatedAt: GENERATED_AT,
};

const HOT = {
  computedAt: GENERATED_AT,
  ruleVersion: null,
  windowHours: 48,
  entries: [{
    rank: 1,
    story: { publicId: "s-1", title: "西藏南部 Mw 7.1 地震" },
    heat: 128,
    trend: "up",
    trendPct: 12,
    badges: [],
    participantCount: 1,
    sourceCount: 1,
    signalCount: 1,
    reportCount: 1,
    sourceNames: ["中国地震台网中心"],
    latestAt: GENERATED_AT,
    firstReportAt: GENERATED_AT,
    representative: null,
    participants: [],
    spark: [1, 2],
    summary: "中国地震台网中心测定西藏南部 Mw 7.1 地震，震源深度 10 千米。",
    latest: null,
    cover: null,
    textLocale: "zh",
  }],
  lang: "en",
};

async function render(pathname: string): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    if (url.includes("/api/site/pool")) return Response.json(POOL);
    if (url.includes("/api/site/calendar")) return Response.json({ month: "2026-11", days: [] });
    if (url.includes("/api/site/hot")) return Response.json(HOT);
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

test("英文列表卡片的逐卡语言标注：中文 AI 摘要的卡片自己说 AI digest, in Chinese", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/en/all");
  const badges = html.split("AI digest, in Chinese").length - 1;
  assert.equal(badges, 1, "两张卡里只有中文摘要那一张该带标注，实际标注数不对");
  // 标注必须落在中文那张卡的 DOM 里，而不是页头那句总说明里。
  const zhCard = html.indexOf('data-item-id="zh-1"');
  const enCard = html.indexOf('data-item-id="en-1"');
  const badge = html.indexOf("AI digest, in Chinese");
  assert.ok(zhCard >= 0 && enCard > zhCard, "两张卡都该渲染出来");
  assert.ok(badge > zhCard && badge < enCard, "标注不在中文卡片的 DOM 里");
});

test("英文热点页副标题在 1 个事件时说 event", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render("/en/hot");
  assert.ok(html.includes("event most discussed in the past 48 hours"), "副标题没出现");
  assert.ok(!html.includes("events most discussed"), "1 个事件仍然用了复数 events");
  // 移动端元信息不许被卡片裁掉：信源名字串要能折行，承载它的那一行也要能换行。
  assert.ok(html.includes("break-words"), "信源名字串没有可折行的类");
  assert.ok(html.includes("flex flex-wrap items-center gap-x-3 gap-y-1"), "voices 行没有可换行容器");
  // 热点页的卡片也按同一条规矩逐卡标注，而不是只靠顶部那句。
  assert.ok(html.includes("AI digest, in Chinese"), "热点卡片没有逐卡语言标注");
});

test("英文日报的分节标题没有漏译「未归类」", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../app/features/report/format.ts"), "utf8");
  assert.match(source, /"未归类":\s*"Uncategorised"/, "SECTION_HEADINGS_EN 缺少 未归类 的英文");
});

test("主题页的接口读按主数据预算，不再被 topics 前缀当成配菜", async () => {
  const { SSR_BUDGET_MS, ssrBudgetMs } = await import("../app/lib/api.server.ts");
  // 2026-11-23 验收：`/api/site/topics` 的前缀一并匹配了 `/api/site/topics/<slug>`，主题详情页
  // 只等 1.5 秒，接口稍慢即整站 503。详情与索引都是各自页面的主数据。
  assert.equal(ssrBudgetMs("/api/site/topics/usgs?page=1"), SSR_BUDGET_MS);
  assert.equal(ssrBudgetMs("/api/site/topics?lang=en"), SSR_BUDGET_MS);
  assert.equal(ssrBudgetMs("/api/site/hot?lang=en"), SSR_BUDGET_MS);
  // 首页手机段的收录池、日历仍是配菜（/all 自己用 budgetMs 覆盖成主预算）。
  assert.equal(ssrBudgetMs("/api/site/pool?channel=all"), 1_500);
  assert.equal(ssrBudgetMs("/api/site/calendar?month=2026-11"), 1_500);
});
