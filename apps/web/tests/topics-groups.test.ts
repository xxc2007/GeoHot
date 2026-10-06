// 主题页那三组（区域与机构 / 自然与人文领域 / 内容与题材）的名字与说明，只写在 `industry/topics.json` 里。
//
// 2026-10-06 之前网页自带一份手抄的常量：改词表里的组名，页面上还是旧字——两处各写一份的东西迟早分叉，
// 本仓库已经为这个形状付过几次账（见 `docs/known-issues.md` 里那些「唯一出处」）。
// 这条测试用**改过的组名**渲染，页面显示改过的名字才算数；照抄常量的话这条会红。
//
// 走的是 build/server/index.js 里那份打过包的路线代码，所以跑之前要先 npm run build -w @aihot/web。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);

/** 词表里来的三组，名字改成一眼能认出的标记：页面若印出它们，说明读的是接口而不是常量。 */
const GROUPS = [
  { key: "company", name: "标记·机构组", blurb: "标记·机构组说明" },
  { key: "field", name: "标记·领域组", blurb: "标记·领域组说明" },
  { key: "genre", name: "标记·题材组", blurb: "标记·题材组说明" },
];
const TOPICS = [
  { slug: "qing-zang-gao-yuan", name: "青藏高原", group: "company", definition: "以青藏高原为范围的主题。", total: 12, recent: 2, indexable: true, latestAt: null },
];

async function render(): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/site/topics")) return Response.json({ topics: TOPICS, groups: GROUPS });
    if (url.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    throw new Error(`测试不放行任何真实请求：${url}`);
  }) as typeof fetch;
  try {
    const build = await import(pathToFileURL(SERVER_BUILD).href);
    const handler = createRequestHandler(build, "production");
    const res = await handler(new Request("https://xxc2007.me/topics"));
    assert.equal(res.status, 200, "SSR 没能渲染 /topics");
    return await res.text();
  } finally {
    globalThis.fetch = real;
  }
}

test("主题页的三组名与说明来自接口（词表），页面不再自带一份", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const html = await render();
  for (const g of GROUPS) {
    assert.ok(html.includes(g.name), `组名 ${g.name} 没出现在页面上：说明页面用的是自己那份写死的常量`);
    assert.ok(html.includes(g.blurb), `组说明 ${g.blurb} 没出现在页面上`);
  }
  // 与词表里那三行原文一模一样的三句，不该再从页面源码里印出来。
  for (const hardcoded of ["按地区与观测发布主体追踪", "按地理领域深挖", "按内容形态浏览"]) {
    assert.ok(!html.includes(hardcoded), `页面里还留着写死的「${hardcoded}」`);
  }
  // 那句导语现在由分组名拼出来：接口说三组，导语里就该是三组的名字（空格与原版一致，不多一个）。
  assert.match(html, />按标记·机构组、标记·领域组、标记·题材组浏览 <span class="num">1<\/span> 个主题/, "导语里的分组名也该来自接口");
  assert.match(html, /<span class="num">1<\/span> 个主题/, "主题数仍由数据自己数");
});
