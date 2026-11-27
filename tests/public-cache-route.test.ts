// nginx 的 $geohot_cache_route 表决定「哪些读者页能进公共缓存」。它不进 nginx -t 就没人能验证行为，
// 所以这里按 nginx 的语义（正则、首次匹配）把这张表读出来跑一遍。
//
// 2026-11-27 现场：/geohot/en 整棵树不在这张表里 ⇒ BYPASS，库一忙就是每屏冷渲染 + 无 use_stale，
// 中文屏同刻靠 STALE 200 顶着。这条测试钉住「/en 在、/en/feedback 与 /en/items/:id/original 不在、
// 后台与单飞 data 路径永远不在」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../deploy/geohot/public-cache.conf", import.meta.url), "utf8");

function routeRules(): Array<[RegExp, boolean]> {
  const block = source.match(/map \$uri \$geohot_cache_route \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, "找不到 $geohot_cache_route 的 map 块");
  // nginx：正则按书写顺序匹配，第一条命中即返回。
  return [...block.matchAll(/^\s+~(\S+)\s+([01]);/gm)].map(([, pattern, value]) => [new RegExp(pattern), value === "1"]);
}

function isCacheable(pathname: string): boolean {
  for (const [pattern, value] of routeRules()) if (pattern.test(pathname)) return value;
  return false;
}

test("/geohot/en 的读者页进公共缓存", () => {
  // /geohot/en.data 走的是 `\.data$` 这一支（单飞 data 的 basename），必须和 / 分支一样命中。
  for (const path of ["/geohot/en", "/geohot/en/", "/geohot/en.data", "/geohot/en/hot", "/geohot/en/all", "/geohot/en/items/abc", "/geohot/en/data.data"]) {
    assert.equal(isCacheable(path), true, `${path} 必须进公共缓存，否则 /en 没有 use_stale 兜底`);
  }
});

test("两个例外显式收回：/en 表单页与 600 秒的 original 页", () => {
  assert.equal(isCacheable("/geohot/en/feedback"), false);
  assert.equal(isCacheable("/geohot/en/feedback.data"), false);
  assert.equal(isCacheable("/geohot/en/items/abc/original"), false);
  assert.equal(isCacheable("/geohot/en/items/abc/original.data"), false);
});

test("前缀不误伤：/geohot/english 与 /geohot/eng 不是 /en", () => {
  assert.equal(isCacheable("/geohot/english"), false);
  assert.equal(isCacheable("/geohot/eng"), false);
});

test("后台与单飞 data 路径永远不进公共缓存", () => {
  for (const path of ["/geohot.data", "/geohot/_root.data", "/geohot/_.data/admin", "/geohot/admin.data", "/geohot/api/admin/sources"]) {
    assert.equal(isCacheable(path), false, `${path} 不能进公共缓存`);
  }
});

test("skip map 只对 GET/HEAD + 可缓存 + 无 Authorization 放行", () => {
  const block = source.match(/map "\$geohot_cache_method:\$geohot_cache_route:\$http_authorization" \$geohot_skip_cache \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, "找不到 $geohot_skip_cache 的 map 块");
  assert.match(block, /default\s+1;/, "默认必须跳过缓存");
  assert.deepEqual([...block.matchAll(/"([^"]*)"\s+0;/g)].map(([, key]) => key), ["1:1:"], "只有 1:1:（GET/HEAD + 可缓存 + 无 Authorization）能放行");
});

test("文件自己写明它不会随 deploy 自动上线", () => {
  assert.match(source, /不会随 deploy\.sh 自动上线/, "这张表是手工安装的，注释里必须写清楚，否则改完仓库等于没改");
  assert.match(source, /grep -rln geohot_cache_route \/etc\/nginx/, "上线前要先确认真实文件名");
});
