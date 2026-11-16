// 2026-11-16 复审根因：/api/health 旧探针是 `sql`SELECT 1`` 套一个 2s Promise.race。
// race 只 reject JS，底层查询要么继续占着连接、要么在饱和池里排队——box 一 wedge，
// 每个探针都叠上去，探针本身成了第二个泄漏（它本是用来发现慢查询泄漏的）。
// 这里钉住新实现：探针走独立 gate(1,0)，2s 到点调 query.cancel()——
// postgres.js 对未派发的查询直接出队（不拿连接），对运行中查询发服务器端 cancel。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");
const readBudget = await readFile(new URL("../packages/backend/src/publication/read-budget.ts", import.meta.url), "utf8");

test("health 路由调用 dbHealthProbe，不再裸跑 SELECT 1 + Promise.race", () => {
  assert.match(app, /await dbHealthProbe\(\)/, "health 必须走有界探针");
  assert.match(app, /from "@aihot\/backend\/publication\/read-budget"/, "探针从 read-budget 导入");
  // 旧的孤儿 race 必须消失：不能再有 Promise.race 包住裸 sql`SELECT 1`。
  assert.doesNotMatch(app, /Promise\.race\(\[\s*sql`SELECT 1`/, "health 不能再用孤儿 Promise.race");
  // 不再从 db 直接导入 sql（探针自己持有取消权）。
  assert.doesNotMatch(app, /import \{ sql \} from "@aihot\/backend\/db"/, "app.ts 不再直接依赖裸 sql");
});

test("dbHealthProbe 用独立 gate(1,0) 且 2s 到点 cancel 查询", () => {
  assert.match(readBudget, /new CapacityGate\(1, 0\)/, "探针独立闸：1 在飞、0 排队");
  assert.match(readBudget, /const query = sql`SELECT 1`/, "探针只做最轻的 SELECT 1");
  assert.match(readBudget, /setTimeout\(\(\) => query\.cancel\(\), 2_000\)/, "2s 到点必须真正 cancel，不能只 reject JS");
  // 关键：不能再用 Promise.race 把查询晾在池里。
  assert.doesNotMatch(readBudget, /Promise\.race\(\[/, "探针不得用孤儿 Promise.race");
});

test("探针失败一律 503+Retry-After，busy 与真故障不混淆", () => {
  assert.match(app, /reply\s+\.code\(503\)/, "不可用必须 503");
  assert.match(app, /Retry-After", "5"/, "503 带 Retry-After: 5");
  assert.match(app, /code === "57014"/, "57014（含我们自己 cancel）按 busy 处理");
});
