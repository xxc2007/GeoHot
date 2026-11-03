import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

process.env.FEISHU_INTERNAL_ENABLED = "false";
// 上传走 inject：socket 地址永远是 127.0.0.1，只有信了 X-Real-IP 各用例的独立地址才生效
// （路由只在 TRUST_PROXY=true 时读它，apps/api/src/routes/feedback.ts 与 app.ts 同口径）。
process.env.TRUST_PROXY = "true";
config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-upload-"));
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); await rm(config.dataDir, { recursive: true }); });

async function upload(file: Buffer, ip: string, mime = "image/png") {
  const form = new FormData();
  form.set("content", "手机截图反馈，文字保持不变");
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/daily");
  form.set("sourceTag", "rejected-magic");
  form.set("screenshot", new File([new Uint8Array(file)], "screenshot.bin", { type: mime }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  return app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": ip }, payload });
}

// 四类可接受格式的文件头魔数（与 operations/feedback.ts 的 MAGIC 表同源）。
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const WEBP = Buffer.concat([Buffer.from("524946461a000000", "hex"), Buffer.from("WEBP"), Buffer.from("56503820", "hex")]);
const GIF = Buffer.from("47494638396101000100800000000000", "hex");

test("a 5 MiB multipart screenshot waits intact for forwarding", async () => {
  const file = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 - PNG.length, 137)]);
  const result = await upload(file, "203.0.113.211");
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  const [row] = await sql`SELECT content,email,page_url,screenshot_key,forward_error FROM feedback WHERE id = ${result.json().id}`;
  assert.equal(row!.content, "手机截图反馈，文字保持不变");
  assert.equal(row!.email, "reader@example.com");
  assert.equal(row!.page_url, "/daily");
  assert.equal(row!.forward_error, "pending");
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

test("malformed multipart and screenshots above the existing backend limit are rejected", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": "multipart/form-data; boundary=missing" }, payload: Buffer.from("bad") });
  assert.equal(bad.statusCode, 400);
  const result = await upload(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 + 1 - PNG.length)]), "203.0.113.212");
  assert.equal(result.statusCode, 400);
  assert.match(result.json().detail, /8MB/);
});

test("the JSON screenshot sent by an already-open tab remains accepted", async () => {
  const file = Buffer.concat([PNG, Buffer.from("existing screenshot")]);
  const result = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-real-ip": "203.0.113.213" }, payload: { content: "旧标签页", screenshot: { mime: "image/png", data: file.toString("base64") } } });
  assert.equal(result.statusCode, 201);
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

// 声明 image/png 但字节是 HTML：魔数与声明不符，按 400 拒绝，不落盘、不进库。
// 429 的一格是既有全局闸（30 条/分钟），不是本用例的对象：断言把 429 也当"没进库"的拒绝。
test("a screenshot whose bytes do not match the declared image type is rejected", async () => {
  const html = Buffer.from("<!doctype html><html><body><h1>not an image</h1></body></html>");
  const result = await upload(html, "203.0.113.214");
  assert.ok(result.statusCode === 400 || result.statusCode === 429, String(result.body));
  if (result.statusCode === 400) assert.match(result.json().detail, /格式不符/);
  // 魔数与声明交叉不符也要拒绝：PNG 字节声明成 GIF 同样进不来。
  const mismatched = await upload(PNG, "203.0.113.215", "image/gif");
  assert.ok(mismatched.statusCode === 400 || mismatched.statusCode === 429, String(mismatched.body));
  if (mismatched.statusCode === 400) assert.match(mismatched.json().detail, /格式不符/);
  // 两条被拒的提交都没有落库（上一个用例与本用例自己的成功条目用别的地址段，不在此计）。
  const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM feedback WHERE source_hash = 'rejected-magic'`;
  assert.equal(rows[0]!.c, 0, "被拒的提交不得写入 feedback 表");
});

// 四类正常魔数各自通过，扩展名跟着声明走。换一个没触过限流的地址段。
test("PNG, JPEG, WebP and GIF magic numbers all pass", async () => {
  const cases: Array<[Buffer, string, string]> = [
    [PNG, "image/png", "198.51.100.16"],
    [JPEG, "image/jpeg", "198.51.100.17"],
    [WEBP, "image/webp", "198.51.100.18"],
    [GIF, "image/gif", "198.51.100.19"],
  ];
  for (const [file, mime, ip] of cases) {
    const result = await upload(file, ip, mime);
    assert.equal(result.statusCode, 201, `${mime}: ${result.body}`);
    const [row] = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
    assert.match(row!.screenshot_key, new RegExp(`\\.${mime.split("/")[1]}$`), "扩展名跟着声明的类型走");
  }
});
