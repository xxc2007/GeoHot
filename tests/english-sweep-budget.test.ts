// 英文 sweep 的读取预算：2026-11-27 现场——执行器的库在读者机上（2 vCPU / 250 IOPS / 891MB），
// 「缺英文正文」那条查询挂到 156 秒，读者页当场 503。五条读现在各自一个只读事务、各 6 秒预算。
// 更关键的一步是**逐组结算**：五条读共用一个事务时，只要一条撞上预算，57014 就把已经查出来的
// 另外四组一起回滚——生产 4.5 小时里 30 多轮 sweep 全部 deferred，created 只涨不消。
// 这条测试是源码级断言：真实的 156 秒没法在测试库上复现，但"有没有这道预算、是不是逐组结算"可以直接读出来。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../packages/backend/src/jobs/english.ts", import.meta.url), "utf8");

test("英文 sweep 的每条读在各自只读事务里，并带 statement_timeout 预算", () => {
  assert.match(source, /SET TRANSACTION READ ONLY/, "sweep 的读要显式只读");
  assert.match(source, /set_config\('statement_timeout'/, "要设 statement_timeout，否则一条慢查询能把读者页拖成 503");
  assert.match(source, /const SWEEP_STATEMENT_TIMEOUT = "6s"/, "预算值要写在一处，别散落在调用点");
});

test("五组各跑一个 sweepGroup：一组超时不再连坐其它四组", () => {
  const groups = [...source.matchAll(/await sweepGroup<[^>]+>\("([a-z-]+)"/g)].map(([, name]) => name);
  assert.deepEqual(groups, ["copy", "body", "story", "fact-titles", "report"], "五组都要走各自的事务");
  assert.match(source, /skipped\.push\(name\)/, "超时的那一组要被记下来");
  assert.match(source, /english sweep groups skipped: budget exhausted/, "被跳过的组要留在日志里");
});

test("预算用尽（57014）仍然把其它组入队，并把原因与被跳过的组写进报告", () => {
  assert.match(source, /code === "57014"/, "57014 要单独处理：它不是故障，是让路");
  assert.match(source, /deferred: true, reason: "sweep budget exhausted"/, "跳过要让运维在报告里看得见原因");
  assert.match(source, /skippedGroups: skipped/, "被跳过的组名要进 job_runs detail，否则和「本来没活」分不开");
  const enqueueAt = source.indexOf("// 入队放在事务外");
  const deferredAt = source.indexOf('reason: "sweep budget exhausted"');
  assert.ok(enqueueAt > 0 && deferredAt > enqueueAt, "入队发生在 deferred 结算之前：部分入队不能因为有一组超时被丢掉");
});

test("入队不在只读事务里：读有预算，写不该被同一份预算截断", () => {
  const txEnd = source.indexOf("// 入队放在事务外");
  assert.ok(txEnd > 0, "入队要搬出事务，注释写明原因");
  const before = source.slice(0, txEnd);
  const after = source.slice(txEnd);
  assert.match(before, /const found = \{ copies, bodies, stories, facts, reports \}/, "读只回 id 列表");
  assert.match(after, /enqueue\(QUEUES\.english/, "入队发生在事务之后");
  assert.doesNotMatch(before, /enqueue\(QUEUES\.english/, "事务里不能有写操作");
});

// 同一类病：运营便利的扫描也不能把读者拖死。2026-11-27 实测 ops.recover 的 unknown 回执扫描
// 跑了 474 秒（2.8GB receipts + 相关子查询），同期 /en 503。它现在带 5 秒预算、超时跳过一轮。
test("unknown 回执扫描带 5 秒预算，超时就跳过这一轮", () => {
  const runs = readFileSync(new URL("../packages/backend/src/admin/runs.ts", import.meta.url), "utf8");
  assert.match(runs, /const RELEASE_SCAN_BUDGET = "5s"/, "预算要写在一处");
  assert.match(runs, /set_config\('statement_timeout', \$\{RELEASE_SCAN_BUDGET\}, true\)/, "扫描要在带预算的事务里");
  assert.match(runs, /unknown-receipt scan skipped: budget exhausted/, "跳过要在日志里留一句");
});
