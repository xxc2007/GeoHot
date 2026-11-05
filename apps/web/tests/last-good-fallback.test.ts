import assert from "node:assert/strict";
import { test } from "node:test";
const build = await import(new URL("../build/server/index.js", import.meta.url).href);
const route = Object.values(build.routes).find((r: any) => r.id === "routes/home") as any;

// 2026-11-06 01:4x 现场：夜档开起来之后，SSR 取时间线偶尔要 15 秒以上，
// `AbortSignal.timeout` 一断就整页 503 —— 读者看到「暂时不可用」，其实只是这一屏数据晚了半分钟。
// 这条用例钉住：第一次读成功会留底稿；第二次上游超时（fetch 抛 AbortError）时，
// 页面交出上一份好数据，而不是把 503 甩给读者。
test("a timed-out read serves the last good payload instead of a 503 page", async () => {
  const original = globalThis.fetch;
  const body = (title: string) => ({ cards: [{ id: title, title, anchorAt: "2026-11-05T20:00:00.000Z", timelineAt: "2026-11-05T20:00:00.000Z", source: { name: "test" } }], dayCounts: {}, refreshAt: "2026-11-05T20:05:00.000Z", filters: {} });
  let round = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/api/site/")) return Response.json({});
    if (url.includes("/api/site/calendar")) return Response.json({ month: "2026-11", days: [] });
    if (url.includes("/api/site/pool")) return Response.json({ total: 0, items: [], page: 1, pageCount: 1, generatedAt: "2026-11-05T20:00:00.000Z" });
    round += 1;
    if (round === 1) return Response.json(body("first-good"));
    // 第二次起模拟「上游卡住直到超时」：AbortSignal 的超时在测试里来得慢，这里直接抛同型错误。
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }) as typeof fetch;
  try {
    const first = await route.module.loader({ request: new Request("https://example.test/"), params: {}, context: {} });
    const second = await route.module.loader({ request: new Request("https://example.test/"), params: {}, context: {} });
    const payload = (r: any) => (r?.data?.data ?? r?.data ?? r);
    assert.equal((payload(first) as any).cards[0].title, "first-good");
    assert.equal((payload(second) as any).cards[0].title, "first-good", "the reader keeps the last good screen");
  } finally {
    globalThis.fetch = original;
  }
});