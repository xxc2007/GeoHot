// 真实浏览器里切外观时控制台出现过 InvalidStateError: Transition was aborted because of
// invalid state. Document hidden —— 被作废的过渡会让这次选择丢掉（点了深色界面还在浅色）。
// 这里钉住那条兜底：ready 拒绝时补做一次应用，finished 的拒绝也要接住。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("apps/web/app/components/shell/ThemeSwitch.tsx", "utf8");

test("过渡被作废时补做一次应用，并接住两个拒绝", () => {
  assert.match(source, /void transition\.ready\.catch\(\(\) => apply\(\)\);/);
  assert.match(source, /void transition\.finished\?\.catch\(\(\) => \{\}\);/);
});

test("没有视图过渡或用户要求减少动画时直接应用", () => {
  assert.match(source, /if \(!startTransition \|\| window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{/);
  assert.match(source, /\n      apply\(\);\n      return;\n    \}/);
  assert.doesNotMatch(source, /doc\.startViewTransition\(apply\);/);
});
