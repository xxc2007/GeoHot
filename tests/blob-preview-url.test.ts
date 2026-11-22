// 反馈页截图预览的地址白名单（lib/safe-url.ts 的 safeBlobSrc）。预览值只可能来自本页
// `URL.createObjectURL(file)`，但交给 `<img src>` 的值一律先过 scheme 判定——这是这个模块的既有规矩
// （文件头），也是 CodeQL `js/xss-through-dom`（"DOM text reinterpreted as HTML"）的出口。
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeBlobSrc } from "../apps/web/app/lib/safe-url.ts";

test("blob: 预览地址放行（createObjectURL 的产物）", () => {
  const url = "blob:http://127.0.0.1:3000/5c1f0a59-4d33-4b2e-9f3e-0a1b2c3d4e5f";
  assert.equal(safeBlobSrc(url), url);
  assert.equal(safeBlobSrc(`  ${url}  `), url, "前后空白去掉后仍是同一个地址");
});

test("别的 scheme 一律不放行", () => {
  assert.equal(safeBlobSrc("javascript:alert(1)"), null);
  assert.equal(safeBlobSrc("data:image/svg+xml,<svg onload=alert(1)>"), null);
  assert.equal(safeBlobSrc("https://evil.example/x.png"), null, "远程地址不该出现在本页预览上");
  assert.equal(safeBlobSrc("vbscript:msgbox(1)"), null);
});

test("空值、坏值与藏起来的控制字符不放行", () => {
  assert.equal(safeBlobSrc(null), null);
  assert.equal(safeBlobSrc(undefined), null);
  assert.equal(safeBlobSrc(""), null);
  assert.equal(safeBlobSrc("not a url"), null, "解析不了的串不算地址");
  assert.equal(safeBlobSrc("java\nscript:alert(1)"), null, "URL 解析器会吃掉换行，判定只看得到 javascript:");
});
