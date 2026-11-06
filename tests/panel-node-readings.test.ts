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

test("心跳键带上主机名，两台同角色的执行器不会互相覆盖", () => {
  const source = read("packages/backend/src/operations/heartbeat.ts");
  // 武汉与杭州的 role 都是 content-executor：只按 role 存，后心跳的那台会把先前的覆盖掉，
  // 面板上就只显示一台机器。键里必须带 hostname()。
  assert.match(source, /heartbeat\.\$\{role\}@\$\{hostname\(\)\}/);
  for (const file of ["apps/api/src/routes/server-console.ts", "packages/backend/src/admin/runs.ts"]) {
    const consumer = read(file);
    assert.ok(consumer.includes('.split("@")[0]'), `${file} 要把键里的主机名剥掉再当角色展示`);
  }
  const migration = read("database/migrations/0111_heartbeat_host_keys.sql");
  assert.match(migration, /DELETE FROM settings WHERE key LIKE 'heartbeat\.%' AND key NOT LIKE '%@%'/);
});

test("远端节点像主库一样报资源与单元状态", () => {
  const beat = read("packages/backend/src/operations/heartbeat.ts");
  // 主库面板能看到的四项指标 + 服务表，远端机器都得自己报，主库不 SSH 出去。
  for (const field of ["cpuPercent", "swapTotal", "swapFree", "uptime", "cpus", "services", "ports"]) {
    assert.ok(beat.includes(`${field}`), `心跳缺 ${field}`);
  }
  assert.ok(beat.includes('"systemctl"'), "单元状态要问 systemctl");
  const page = read("apps/web/app/routes/admin/server.tsx");
  assert.ok(page.includes("{(n.services??[]).length===0"), "远端节点要有自己的服务表");
  assert.ok(page.includes("n.cpuPercent"), "远端节点要有自己的 CPU 卡");
});

test("面板把远端节点画成表格，缺数据时留破折号", () => {
  const source = read("apps/web/app/routes/admin/server.tsx");
  const card = source.slice(source.indexOf('<Card title="协同节点">'));
  assert.ok(card.length > 0, "协同节点卡片还在");
  for (const header of ["负载", "内存", "磁盘"]) assert.ok(card.includes(header), `表头缺 ${header}`);
  assert.ok(card.includes('n.load===null?"—"'), "负载为空时要有占位");
  assert.equal((source.match(/const gb=/g) ?? []).length, 1, "gb 只能定义一次");
});
