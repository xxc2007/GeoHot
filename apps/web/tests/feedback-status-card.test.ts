// 公开反馈页（/feedback）：「查询处理状态」折叠卡在页面上真实渲染，成功页带「当前状态：已收到」
// 徽标与编号查询提示。走 build/server/index.js 里打过包的路线代码，先 npm run build -w @aihot/web。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequestHandler } from "react-router";

const SERVER_BUILD = path.resolve(import.meta.dirname, "../build/server/index.js");
const built = existsSync(SERVER_BUILD);

async function render(url: string, init?: RequestInit): Promise<{ status: number; html: string }> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const u = String(input);
    if (u.includes("/api/site/meta")) return Response.json({ changelogVersion: null });
    throw new Error(`测试不放行任何真实请求：${u}`);
  }) as typeof fetch;
  try {
    const build = await import(pathToFileURL(SERVER_BUILD).href);
    const handler = createRequestHandler(build, "production");
    const base = String(build.basename ?? "/").replace(/\/+$/, "");
    const res = await handler(new Request(`https://xxc2007.me${base}${url}`, init));
    return { status: res.status, html: await res.text() };
  } finally {
    globalThis.fetch = real;
  }
}

test("反馈页渲染出「查询处理状态」折叠卡标题（展开后的表单随客户端状态渲染）", { skip: built ? false : "需要先 npm run build -w @aihot/web" }, async () => {
  const { html } = await render("/feedback");
  assert.equal(html.includes("查询处理状态"), true, "折叠卡标题没出现在页面上");
  assert.equal(html.includes("编号和提交时留的邮箱"), true, "折叠卡的说明缺失");
  assert.equal(html.includes("aria-expanded"), true, "折叠卡不是可展开控件");
});

test("成功视图整屏居中、状态徽标恒为已收到、带编号查询提示（hydrate 后由 done 状态渲染；SSR 源码断言）", async () => {
  // SSR 初始状态是 idle，done 视图只在客户端出现——这里直接钉源码里的三个特征，
  // 防止将来把成功页又塞回左对齐阅读栏或删掉状态徽标。
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(path.resolve(import.meta.dirname, "../app/routes/feedback.tsx"), "utf8");
  assert.ok(source.includes("min-h-[calc(100dvh-9rem)] w-full flex-col items-center justify-center"), "done 视图不再整屏居中");
  assert.ok(source.includes("当前状态：已收到"), "done 视图状态徽标缺失或不再是「已收到」");
  assert.ok(source.includes("本页下方查询处理进度"), "编号查询提示缺失");
  assert.ok(source.includes("api/site/feedback-status"), "查询卡没有指向状态接口");
});
