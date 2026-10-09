// 条目页与事件页左上角那条「返回 X」的去处，是怎么从"来路"折出来的。
//
// 这一处之所以单独有测试：`root.tsx` 顶上写着，React Router 在 basename 部署下把 `to="/"` 解析成**裸的
// `/geohot`**，而它自己的匹配器认不出这个串——读者就落在 404 页上，地址栏却显示着正确的 `/geohot/?category=…`。
// 同一个行为在本站已经出过三次事（首页 tab、报告 tab、首页筛选 chip），每一次都在调用点各修一遍：
// chip 那一处改成 `hard: true`（交回浏览器做真导航，见 `features/feed/Filters.tsx`），而**条目页的返回链接
// 是第四个调用点，没人管**。2026-10-09 站长从「政治地理」筛选页点进一条、再点「返回精选」，看到的就是这个。
//
// 所以这里钉两件事：认得哪个页面（名字与剥掉部署前缀后的路径），以及**根那一格必须标成 hard**——
// 只有它是客户端匹配器解不开的，其余路径交给 `<Link>` 是对的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { toAppPath, toPublicPath } from "@aihot/contracts/http-policy";
import { backPlace } from "../apps/web/app/lib/back-place.ts";

test("来路是首页带筛选：认成「精选」，并且标成必须走真导航的那一类", () => {
  const home = backPlace("/?category=geopolitics");
  assert.deepEqual(home, { name: "精选", to: "/?category=geopolitics", hard: true });
  // 裸首页同理：`to="/"` 在 basename 下就是那个解不开的串。
  assert.equal(backPlace("/")?.hard, true);
  assert.equal(backPlace("/")?.to, "/");
});

test("其余页面留在客户端路由里（hard=false），查询串原样带回去", () => {
  assert.deepEqual(backPlace("/all?tag=洪水"), { name: "全部动态", to: "/all?tag=洪水", hard: false });
  assert.equal(backPlace("/hot")?.name, "热点榜");
  assert.equal(backPlace("/starred")?.name, "收藏");
  assert.equal(backPlace("/daily/2026-10-08")?.name, "日报");
  assert.equal(backPlace("/topics/xxx")?.name, "主题页");
  assert.equal(backPlace("/changelog")?.name, "更新日志");
});

test("站外与看不懂的来路不成链接：宁可留一个中性的「返回」", () => {
  assert.equal(backPlace(null), null);
  assert.equal(backPlace(""), null);
  assert.equal(backPlace("https://evil.example/geohot/"), null, "绝对外部地址");
  assert.equal(backPlace("//evil.example/"), null, "协议相对写法指向别人的域名");
  assert.equal(backPlace("/no-such-page"), null, "认不出的路径不猜名字");
});

test("子路径部署下，浏览器给的公开路径要折回应用路径（不剥前缀就会跳到同域的邻站）", () => {
  // 本机没有 BASE_PATH，`appPath()` 原样返回；带前缀的形态由 contracts/http-policy 的纯函数保证，
  // 这里直接断言那一条规则，避免测试依赖构建期注入的环境变量。
  assert.equal(toAppPath("/geohot/", "/geohot"), "/");
  assert.equal(toAppPath("/geohot/all", "/geohot"), "/all");
  assert.equal(toPublicPath("/", "/geohot"), "/geohot/");
  assert.equal(toPublicPath("/geohot/", "/geohot"), "/geohot/", "已经带前缀的不再叠一层");
});
