// Cloudflare 的邮箱保护在边缘把 `xxc200707@qq.com` 换成 `[email protected]` 并包一层
// `/cdn-cgi/l/email-protection` 的链接，服务端 HTML 与客户端从 JSON 渲染出的文本于是不一致 ——
// 2026-11-05 用真实 Edge 打开 /changelog 实测到 Minified React error #418。
// 修法是让含 `@` 的纯文本段落在带 `suppressHydrationWarning` 的 <span> 里渲染：
// 服务端标记不能直接查出这个属性（它只被 React 用来跳过比对），所以这里钉两件事：
// 邮箱必须原样留在文本里，且必须被单独一层 span 包住（那一层才是携带抑制标记的位置）。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("更新日志里的邮箱被单独包一层，边缘改写不至于让 hydrate 报错", async () => {
  const server = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dirname, ".."),
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const mod = await server.ssrLoadModule("/app/features/changelog/text.tsx");
    const Inline = mod.Inline as (props: { text: string }) => ReactElement;
    const html = renderToStaticMarkup(createElement(Inline, { text: "联系邮箱 xxc200707@qq.com、反馈邮箱直发" }));

    assert.match(html, /xxc200707@qq\.com/, "邮箱必须原样出现在标记里");
    assert.match(html, /<span>联系邮箱 xxc200707@qq\.com、反馈邮箱直发<\/span>/, "含 @ 的段落要单独成一段");
    // 不含 @ 的普通段落不额外加壳：多一层 span 会改变行内排版的换行点。
    const plain = renderToStaticMarkup(createElement(Inline, { text: "只是普通一句话" }));
    assert.equal(plain, "只是普通一句话");
  } finally {
    await server.close();
  }
});