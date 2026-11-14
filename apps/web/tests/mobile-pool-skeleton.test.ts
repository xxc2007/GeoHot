// 手机「全部」那一段加载时不能再出现「正在取收录池…」这句话。
//
// 站点 2026-11-14 的站长截图里，手机切到「全部」会停在这行字上等一趟冷查询；
// 现在改成同形状骨架（`正在载入收录池` 只做无障碍标签，不上屏）。这条测试盯住构建产物：
// 交付出去的包里既不能有那句话，也不能把骨架的 aria 标签换成别的。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bundle = readFileSync(fileURLToPath(new URL("../build/server/index.js", import.meta.url)), "utf8");

test("手机说「正在载入收录池」，不再说「正在取收录池」", () => {
  assert.equal(bundle.includes("正在取收录池"), false, "这行字会让读者以为页面卡死");
  assert.equal(bundle.includes("正在载入收录池"), true, "骨架要有无障碍标签，读屏才知道在等什么");
});

test("骨架带 aria-busy，读者眼里是结构而不是空白", () => {
  assert.match(bundle, /"aria-busy":\s*"true"/, "骨架要标 busy，读屏才不会以为内容已经到底");
});

test("取不到时给「再试一次」，不把错误码糊在屏幕上", () => {
  assert.equal(bundle.includes("再试一次"), true);
});
