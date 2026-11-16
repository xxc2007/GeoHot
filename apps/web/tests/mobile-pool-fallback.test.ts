// 手机首页切「全部」取不到数据时，不能只给「再试一次」把人卡死。
// 站长 2026-11-16 线上复测：pool 503/429 后整屏停在错误态，没有去 /all 的出口。
// 这里断言错误态同时带「再试一次」和「去全部列表看看」两条路。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bundle = readFileSync(fileURLToPath(new URL("../build/server/index.js", import.meta.url)), "utf8");

test("错误态同时给再试一次和去全部列表", () => {
  assert.equal(bundle.includes("再试一次"), true, "保留重试");
  assert.match(bundle, /去全部列表看看/, "错误态要给读者一个离开首页的出口");
});

test("去全部列表链接指向 /all（带当前筛选）", () => {
  // MobileHome.tsx 里用 listPath("/all", ...) 拼链接；构建后应保留 listPath 调用形态
  assert.match(bundle, /listPath\("\/all"/, "链接要走 listPath 保留 category/channel");
});
