import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

// 背景（2026-11-06）：服务器在 postgresql.auto.conf 里把 `lock_timeout` 设成全局 2 秒。
// 那是给读者定的上限，但后台的咨询锁是**排队**用的：同一个 service 的预算判定、同一批素材的
// 身份归并本来就该一个接一个。2 秒把排队当故障，13:00 起每小时 350–815 篇带着
// `canceling statement due to lock timeout` 掉回重试，槽位从 1 加到 13、出口反而从 750/h 掉到 300/h。
// 这条用例钉住两件事：会话级放宽、读者那条路仍然收紧。

const db = readFileSync(new URL("../packages/backend/src/db.ts", import.meta.url), "utf8");
const readBudget = readFileSync(new URL("../packages/backend/src/publication/read-budget.ts", import.meta.url), "utf8");
const receipts = readFileSync(new URL("../packages/backend/src/providers/receipts.ts", import.meta.url), "utf8");

test("the shared pool lets background advisory locks queue instead of failing at 2s", () => {
  const m = db.match(/connection:\s*\{[^}]*lock_timeout:\s*(\d[\d_]*)/);
  assert.ok(m, "db.ts 的 connection 里应当有 lock_timeout");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ms >= 10_000, `会话级 lock_timeout 至少 10 秒，实测 ${ms}ms`);
});

test("readers still give up early: read-budget keeps its own short lock_timeout", () => {
  assert.match(readBudget, /set_config\('lock_timeout',\s*'1[0-9]{3}'/);
  // 会话级 15 秒不该把读者一起拖住：那条事务必须自己写回一个更短的数。
  const m = readBudget.match(/set_config\('lock_timeout',\s*'(\d+)'/);
  assert.ok(m && Number(m[1]) <= 2_000, "读者路径的 lock_timeout 必须 ≤2000ms");
});

test("the budget lock queue has its own bound, set per transaction", () => {
  // 2026-11-08 更新：会话级 15 秒仍然是对的（别的后台事务不该被 2 秒砍），但**这一个**事务要更浅的
  // 上界——生产上 11 个会话在这把锁上等了 8–11 秒、持锁方 idle in transaction 18 秒，读者被一起拖到
  // 3.3 秒 / 503。所以 claim 自己 SET LOCAL 一个秒级 lock_timeout，超时在 claimWithQueueLimit 里
  // 映射成 ReceiptBusyError（调用方本来就当"稍后再来"重试），不再无止境排队。
  const claim = receipts.slice(receipts.indexOf("const claimed = await claimWithQueueLimit"), receipts.indexOf("if (claimed.kind === \"reuse\")"));
  assert.match(claim, /pg_advisory_xact_lock\(hashtext\(\$\{"budget:" \+ service\}\)\)/);
  const helper = receipts.slice(receipts.indexOf("async function claimWithQueueLimit"), receipts.indexOf("export function logicalKeyFor"));
  assert.match(helper, /set_config\('lock_timeout',[^)]*,\s*true\)/, "只能用事务级 set_config(..., true)");
  const m = receipts.match(/const CLAIM_QUEUE_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(m, "队列上限应当是一个命名常量");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ms <= 5_000, `队列上限必须小于会话级的 15 秒（实测 ${ms}ms）`);
  assert.match(helper, /ReceiptBusyError/, "超时要映射成可重试的 ReceiptBusyError");
});
