// 三条「参数错误被报成别的东西」的边界，钉在这里：
//   1. `?page=abc` / `?page=0` 以前经 Number() 变成 NaN/0，`loadTopicPage` 对 page<1 返回 null，
//      于是参数错误被回答成 404「topic page not found」——读起来像这个主题不存在。
//   2. `?topic=` 没跟 tag 一样截断，8KB 的主题名会原样进 DB 查询。
//   3. 静态文件（图标等）的 If-None-Match 只做 `===`，浏览器带 `W/"a", W/"b"` 列表就永远拿不到 304。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("主题分页参数写错时回答 400，而不是把主题说成不存在", async () => {
  for (const page of ["abc", "0", "1.5", "-3"]) {
    const res = await app.inject({ method: "GET", url: `/api/site/topics/not-a-topic?page=${encodeURIComponent(page)}` });
    assert.equal(res.statusCode, 400, `page=${page} 应当是参数错误，实际 ${res.statusCode}`);
    assert.equal(res.json().code, "invalid_request");
  }
});

test("分页参数合法但主题不存在时，仍然是 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/site/topics/not-a-topic?page=2" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "not_found");
});

test("主题名过长时先拒绝，不把 8KB 送进查询", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/timeline?topic=${"a".repeat(61)}` });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "invalid_request");
});

test("静态图标的 If-None-Match 认弱校验符与列表，不只认全等", async () => {
  const first = await app.inject({ method: "GET", url: "/logo.svg" });
  assert.equal(first.statusCode, 200);
  const etag = first.headers.etag as string;
  assert.ok(etag, "静态文件应当有 ETag");

  const list = await app.inject({ method: "GET", url: "/logo.svg", headers: { "if-none-match": `W/"stale-tag", ${etag}` } });
  assert.equal(list.statusCode, 304, "列表里带上自己的 ETag 就该 304");

  const star = await app.inject({ method: "GET", url: "/logo.svg", headers: { "if-none-match": "*" } });
  assert.equal(star.statusCode, 304);

  const miss = await app.inject({ method: "GET", url: "/logo.svg", headers: { "if-none-match": 'W/"nope"' } });
  assert.equal(miss.statusCode, 200, "对不上就照常回 200");
});
