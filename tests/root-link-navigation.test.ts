// 子路径部署下，`<Link to="/">` 是一个静默的 404 陷阱：React Router 把它解析成**裸的 `/geohot`**
// （basename 之外没有尾斜杠），而它自己的匹配器认不出这个串——地址栏被 root.tsx 的历史补丁修好了，
// 页面却已经渲染成 404。本站为此已经修过四处（首页 tab、报告 tab、首页筛选 chip、条目页与事件页的
// 返回链接），每一次都是"点进去正常、点出去再点回来就 404"。
//
// 所以这条不测行为、只测**写法**：任何指向根的 `<Link>` 必须带 `reloadDocument`（或干脆是 `<a href>`），
// 否则它就是一个只有点击才会暴露的坑。这类"只有真点才会红"的缺陷，用一次全仓扫描钉住比逐个点击便宜。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const APP = path.resolve(import.meta.dirname, "../apps/web/app");

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return tsx(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}

const files = tsx(APP);
assert.ok(files.length > 40, `扫到了 ${files.length} 个文件，路径不对吧`);

test("指向根的 <Link> 一律带 reloadDocument：不带的那一种在 /geohot 前缀下必然 404", () => {
  const offenders: string[] = [];
  for (const f of files) {
    // 整行注释要先去掉：这条规则管的是代码，不是解释这个坑的注释——本文件写下的那段说明里就有一句
    // `<Link to="/">`，不剥掉的话测试会去举报一段正在解释该缺陷的注释。
    const src = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const m of src.matchAll(/<Link\b[\s\S]{0,400}?\/>/g)) {
      const tag = m[0];
      if (!/\bto=(?:"\/"|\{"\/"\}|`\/`)/.test(tag)) continue;
      if (!/reloadDocument/.test(tag)) offenders.push(`${path.relative(APP, f)}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `这些根链接会让读者落在 404 上：\n${offenders.join("\n")}`);
});

test("条目页与事件页的返回去处，首页那一格必须走真导航", () => {
  // 只测接线：backPlace 已经给出 hard（back-place.test.ts 测它的判定），这里要保证两个页面真的读了它，
  // 而不是哪天重构时又退回成 `<Link to={back.to}>`——那正是站长 2026-10-09 报的那一单。
  for (const rel of ["routes/item.tsx", "routes/story.tsx"]) {
    const src = readFileSync(path.join(APP, rel), "utf8");
    assert.match(src, /hard/, `${rel} 不再处理 hard：首页那格的返回链接会 404`);
    assert.match(src, /publicPath\((back|backTarget)\.to\)/, `${rel} 的 hard 分支没有走 publicPath，前缀会丢`);
  }
});
