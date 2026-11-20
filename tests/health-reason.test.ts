// 2026-11-18 回归：/api/health 的 503 必须把「自家闸/查询忙」与「数据库真不可达」分开，
// 响应带结构化 reason。分类器是纯函数，这里用合成错误钉住四类原因；不连真实库。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { CapacityExceeded, CapacityTimeout } from "@aihot/backend/lib/capacity";
import { classifyProbeError, HealthProbeError } from "@aihot/backend/publication/read-budget";

after(async () => {
  // 模块导入会构造全局池但不会建连；收尾把它关掉，避免测试进程挂着空转句柄。
  await closeDb();
});

test("闸满拒绝 → gate_busy（自家压力，不当数据库故障告警）", () => {
  assert.equal(classifyProbeError(new CapacityExceeded("capacity temporarily exhausted")), "gate_busy");
});

test("查询超时 / 57014 → query_timeout", () => {
  assert.equal(classifyProbeError(new CapacityTimeout(2_000)), "query_timeout");
  assert.equal(classifyProbeError({ code: "57014" }), "query_timeout");
});

test("连接级错误（reset/refused/closed/connect timeout）→ conn_error", () => {
  assert.equal(classifyProbeError({ code: "ECONNRESET" }), "conn_error");
  assert.equal(classifyProbeError({ code: "ECONNREFUSED" }), "conn_error");
  assert.equal(classifyProbeError({ code: "CONNECTION_CLOSED" }), "conn_error");
  assert.equal(classifyProbeError({ code: "CONNECT_TIMEOUT" }), "conn_error");
  assert.equal(classifyProbeError(new Error("timeout exceeded when trying to connect")), "conn_error");
});

test("其它未识别错误 → db_unavailable", () => {
  assert.equal(classifyProbeError(new Error("boom")), "db_unavailable");
  assert.equal(classifyProbeError(undefined), "db_unavailable");
});

test("HealthProbeError 携带 reason 与原始 cause", () => {
  const cause = new Error("socket reset");
  const error = new HealthProbeError("conn_error", "db probe failed", cause);
  assert.equal(error.reason, "conn_error");
  assert.equal(error.cause, cause);
});
