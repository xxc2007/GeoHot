import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 2026-11-14：一条 /feed/all.xml 在生产上实测 66–168 秒（listedCondition 里带
// EXISTS article_workflow_readiness，再按 coalesce(published_at, discovered_at) 排序，
// 没有能裁剪的索引），它把慢盘占满、别的读者被判 busy 拿 503。
// 这里钉住订阅源的进程内缓存：十分钟只算一次、并发只算一次、过期先给旧的再后台换新。
const source = readFileSync(new URL("../apps/api/src/routes/feeds.ts", import.meta.url), "utf8");
const { cachedFeed, FEED_TTL_MS } = (await import("../apps/api/src/routes/feeds.ts")) as {
  cachedFeed: (key: string, build: () => Promise<string>) => Promise<string>;
  FEED_TTL_MS: number;
};

test("订阅源缓存十分钟，且过期后仍有六小时可用来兜底", () => {
  assert.equal(FEED_TTL_MS, 10 * 60_000);
  assert.match(source, /const FEED_STALE_MS = 6 \* 3600_000;/);
});

test("同一个 key 连续两次只算一次", async () => {
  let calls = 0;
  const build = async () => {
    calls += 1;
    return `<xml>${calls}</xml>`;
  };
  const first = await cachedFeed("test:once", build);
  const second = await cachedFeed("test:once", build);
  assert.equal(first, second);
  assert.equal(calls, 1);
});

test("并发请求只在飞一次，不会把慢查询叠起来", async () => {
  let calls = 0;
  const build = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "<xml>slow</xml>";
  };
  const all = await Promise.all([cachedFeed("test:inflight", build), cachedFeed("test:inflight", build), cachedFeed("test:inflight", build)]);
  assert.deepEqual(all, ["<xml>slow</xml>", "<xml>slow</xml>", "<xml>slow</xml>"]);
  assert.equal(calls, 1);
});

test("构建失败时不把坏结果写进缓存", async () => {
  let calls = 0;
  const boom = async () => {
    calls += 1;
    throw new Error("boom");
  };
  await assert.rejects(() => cachedFeed("test:boom", boom));
  const ok = await cachedFeed("test:boom", async () => {
    calls += 1;
    return "<xml>ok</xml>";
  });
  assert.equal(ok, "<xml>ok</xml>");
  assert.equal(calls, 2);
});
