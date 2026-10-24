// 首页链接在当前 Router 下的真实导航行为由 apps/web/tests/home-navigation.test.ts 覆盖。
// 本文件只保留本轮未改动的条目页与事件页 hard-return 接线检查。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const APP = path.resolve(import.meta.dirname, "../apps/web/app");

test("条目页与事件页的返回去处，首页那一格必须走真导航", () => {
  // 只测接线：backPlace 已经给出 hard（back-place.test.ts 测它的判定），这里要保证两个页面真的读了它，
  // 而不是哪天重构时又退回成 `<Link to={back.to}>`——那正是站长 2026-10-09 报的那一单。
  for (const rel of ["routes/item.tsx", "routes/story.tsx"]) {
    const src = readFileSync(path.join(APP, rel), "utf8");
    assert.match(src, /hard/, `${rel} 不再处理 hard：首页那格的返回链接会 404`);
    assert.match(src, /publicPath\((back|backTarget)\.to\)/, `${rel} 的 hard 分支没有走 publicPath，前缀会丢`);
  }
});
