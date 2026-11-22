// 英文站的两类接线错误，都只在特定环境下才发作，本地根部署 / 干净构建都看不出来：
//
// ① `<Link to>`（以及 navigate()）收的是 public 路径——localePath() / publicPath() 已经带上
//    BASE_PATH，而 React Router 在 basename 部署下会无条件再拼一次 basename，线上得到
//    `/geohot/geohot/en/hot` → 404（2026-11-22 独立审查；语言胶囊与根错误页各一处）。路由目标
//    只认 localeAppPath()（应用路径，剥过前缀）；`<a href>` 才用 localePath()。
//
// ② 英文静态文档直接 `?raw` 导入：industry/pages/terms.en.md 一旦缺失，CI 构建直接挂；
//    privacy 的 import.meta.glob 写法会让英文版回退中文、构建照常通过。两页必须同一套写法。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** 全部 web 源码（app 目录下的 .ts/.tsx），跳过 Mimosa 的 hook 状态目录。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === ".mimosa") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const APP = "apps/web/app";
const read = (path: string) => readFileSync(path, "utf8");

test("路由目标不收 public 路径：<Link to> / navigate() 只认应用路径", () => {
  // `to={localePath(...)}`、`to={publicPath(...)}`、`to={homeHref()}` 都会在 basename 部署下被再拼一次前缀。
  const offenders = srcs().filter((file) => /to=\{(?:localePath|publicPath|homeHref)\(/.test(read(file)));
  assert.deepEqual(offenders, [], "这些文件把带 BASE_PATH 的 public 路径交给了 <Link to>；改用 localeAppPath()");
  const navigations = srcs().filter((file) => /navigate\(\s*(?:localePath|publicPath)\(/.test(read(file)));
  assert.deepEqual(navigations, [], "navigate() 同样只收应用路径");
});

function srcs() {
  return sources(APP);
}

test("语言胶囊用 localeAppPath 拼两种语言（basename 部署下切语言不跳 404）", () => {
  const file = read(join(APP, "components/shell/LangSwitch.tsx"));
  assert.match(file, /import \{[^}]*localeAppPath[^}]*\} from "\.\.\/\.\.\/lib\/i18n"/, "语言胶囊要 import localeAppPath");
  assert.match(file, /localeAppPath\(pathname, l\.key\)/, "去处是应用路径 + 查询串/锚点");
  // 不 import localePath 就无从把 public 路径交给 <Link to>（注释里提到它不受影响）。
  assert.doesNotMatch(file, /import \{[^}]*localePath[^}]*\}/, "localePath 是给 <a href> 的，不能进 <Link to>");
});

test("更新日志 9.0 卡的「去英文版首页」保持 /en，不被折成中文首页", () => {
  // localeAppPath("/en", "zh") === "/"：把 /en 当普通路径过一遍就丢了英文入口。
  const file = read(join(APP, "features/changelog/MajorRelease.tsx"));
  assert.match(file, /to === "\/en"/, "cardHref 必须原样放行 /en");
  assert.match(file, /to\.startsWith\("\/admin"\)/, "/admin 没有 /en 孪生页，同样原样放行");
});

test("英文静态文档缺文件时回退中文，而不是构建失败", () => {
  for (const page of ["terms", "privacy"]) {
    const file = read(join(APP, `routes/${page}.tsx`));
    assert.doesNotMatch(file, new RegExp(`pages/${page}\\.en\\.md\\?raw`), `${page}.tsx 不能对英文版直接 ?raw 导入`);
    assert.match(file, new RegExp(`import\\.meta\\.glob<string>\\("\\.\\.\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/industry\\/pages\\/${page}\\*\\.en\\.md"`), `${page}.tsx 用 glob 匹配英文版（缺文件时键表为空）`);
    assert.match(file, /(?:\?\?|: )\s*(?:copyZh|TERMS_ZH)/, `${page}.tsx 缺文件时回退中文文档`);
  }
});
