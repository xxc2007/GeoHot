// 后台嵌的 Magpie 面板与「模型池探针」的速率上限：面板一次加载几十上百个资源，
// 240/分钟这种给普通接口定的数会让资源拿 429，面板只剩导航栏（2026-11-16 真浏览器实测 19 个 429）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../apps/api/src/routes/server-console.ts", import.meta.url), "utf8");

test("Magpie 面板的代理预算按「一个面板的资源数」定，不按普通接口", () => {
  const route = source.slice(source.indexOf("/api/admin/magpie-proxy/*"));
  const match = /rateLimit:\{max:(\d+),timeWindow:'1 minute'\}/.exec(route);
  assert.ok(match, "代理路由要显式给出自己的速率上限");
  const max = Number(match[1]);
  assert.ok(max >= 1000, `面板一开就要上百个资源，上限 ${max}/分钟太紧，会打成 429`);
  assert.ok(max <= 6000, `上限 ${max}/分钟已经不像是「有界」了`);
});

test("放宽的只有面板代理这一条：别的桶一个都没动", () => {
  // server-console.ts 在没有全局桶时会补一个 600/分钟 的兜底桶——它必须保持原值，
  // 否则「给面板宽限」就会变成「给所有接口宽限」。
  assert.match(source, /global:true, max:600, timeWindow:'1 minute'/);
  // 服务器面板的采样接口仍然只有 30/分钟。
  assert.match(source, /"\/api\/admin\/server", \{config:\{rateLimit:\{max:30,timeWindow:'1 minute'\}\}\}/);
});
