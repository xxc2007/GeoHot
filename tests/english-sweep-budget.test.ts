// 英文 sweep 的读取预算：2026-11-27 现场——执行器的库在读者机上（2 vCPU / 250 IOPS / 891MB），
// 「缺英文正文」那条查询挂到 156 秒，读者页当场 503。五条读现在跑在一个只读事务里、每条 6 秒，
// 预算用完就跳过这一轮（回填慢一轮，好过换读者一次超时）。
// 这条测试是源码级断言：真实的 156 秒没法在测试库上复现，但"有没有这道预算"可以直接读出来。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../packages/backend/src/jobs/english.ts", import.meta.url), "utf8");

test("英文 sweep 的五条读在只读事务里，并带 statement_timeout 预算", () => {
  assert.match(source, /SET TRANSACTION READ ONLY/, "sweep 的读要显式只读");
  assert.match(source, /set_config\('statement_timeout'/, "要设 statement_timeout，否则一条慢查询能把读者页拖成 503");
  assert.match(source, /const SWEEP_STATEMENT_TIMEOUT = "6s"/, "预算值要写在一处，别散落在调用点");
});

test("预算用尽（57014）跳过这一轮，并把原因写在 deferred 里", () => {
  assert.match(source, /code === "57014"/, "57014 要单独处理：它不是故障，是让路");
  assert.match(source, /deferred: true, reason: "sweep budget exhausted"/, "跳过要让运维在报告里看得见原因");
});

test("入队不在只读事务里：读有预算，写不该被同一份预算截断", () => {
  const txEnd = source.indexOf("// 入队放在事务外");
  assert.ok(txEnd > 0, "入队要搬出事务，注释写明原因");
  const before = source.slice(0, txEnd);
  const after = source.slice(txEnd);
  assert.match(before, /return \{ copies, bodies, stories, facts, reports \}/, "事务里只回 id 列表");
  assert.match(after, /enqueue\(QUEUES\.english/, "入队发生在事务之后");
  assert.doesNotMatch(before, /enqueue\(QUEUES\.english/, "事务里不能有写操作");
});
