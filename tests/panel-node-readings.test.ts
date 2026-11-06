import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("心跳带上远端机器的体检数据", () => {
  const source = read("packages/backend/src/operations/heartbeat.ts");
  assert.match(source, /load: Number\(loadavg\(\)\[0\]\.toFixed\(2\)\)/);
  assert.match(source, /memTotal: totalmem\(\)/);
  assert.match(source, /memFree: freemem\(\)/);
  assert.match(source, /diskFree = fsStat\.bavail \* fsStat\.bsize/);
});

test("接口把体检数据透给面板，字段名与心跳一致", () => {
  const source = read("apps/api/src/routes/server-console.ts");
  for (const field of ["load", "memTotal", "memFree", "diskFree", "diskTotal"]) {
    assert.match(source, new RegExp(`${field}: typeof row\\.value\\?\\.${field} === "number"`));
  }
});

test("面板把远端节点画成表格，缺数据时留破折号", () => {
  const source = read("apps/web/app/routes/admin/server.tsx");
  const card = source.slice(source.indexOf('<Card title="协同节点">'));
  assert.ok(card.length > 0, "协同节点卡片还在");
  for (const header of ["负载", "内存", "磁盘"]) assert.ok(card.includes(header), `表头缺 ${header}`);
  assert.ok(card.includes('n.load===null?"—"'), "负载为空时要有占位");
  assert.equal((source.match(/const gb=/g) ?? []).length, 1, "gb 只能定义一次");
});
