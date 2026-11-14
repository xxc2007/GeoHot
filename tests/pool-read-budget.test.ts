// 2026-11-15 现场：主库只有 ~250 IOPS，`WITH listed …` 那条要几十秒。原来 pool 45 秒就过期、
// 3 分钟就当陈旧，等于让机器不停重算；后台一开就 io.full=99、首页 503。这里钉住三件事：
// 缓存窗口放长、现算有硬预算、超预算时交回底稿/陈旧值而不是无限等。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../apps/api/src/routes/site.ts", import.meta.url), "utf8");

test("pool 的新鲜窗口是五分钟、可用窗口是三十分钟", () => {
  assert.match(source, /const POOL_FRESH_MS = 5 \* 60_000;/);
  assert.match(source, /const POOL_SERVE_MS = 30 \* 60_000;/);
  assert.match(source, /const POOL_STALE_MS = 30 \* 60_000;/);
  assert.doesNotMatch(source, /POOL_FRESH_MS = 45_000/, "45 秒的窗口已经证明会自激");
});

test("现算最多等 20 秒，超时抛出来交给底稿", () => {
  assert.match(source, /Promise\.race\(\[\s*loadPool\(args\),/);
  assert.match(source, /pool budget exceeded/);
  assert.match(source, /setTimeout\(\(\) => reject\(/, "预算必须真的挂一个计时器");
});

test("缓存头跟着窗口一起放长到 300 秒", () => {
  assert.match(source, /etagPrefix: "pool", cacheControl: "public, max-age=300, s-maxage=300"/);
  assert.doesNotMatch(source, /etagPrefix: "pool", cacheControl: "public, max-age=45/, "浏览器与 CDN 不该比源站更急");
});

test("预热器两分钟一轮，不再是二十秒", async () => {
  const timer = await readFile(new URL("../deploy/geohot/systemd/geohot-warm-pages.timer", import.meta.url), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* \*:0\/2:00/);
  assert.match(timer, /OnUnitActiveSec=120s/);
});
