// 站长 2026-11-16 的两条指令：①agnes 用最新版本 + 最强调理；②hy3 全部换成 hy4 flash。
//
// 这份用例只钉**判据**，不钉探针结果：上游 id、档位、以及「不许再有别名指向 hy3」。
// 探针当天的实测（谁 200、谁 403）写在 llm.ts 的注释里，会随账号状态变化，不适合在这里断言。
import "./setup.ts";
import { strict as assert } from "node:assert";
import test from "node:test";
import { MODELS } from "@aihot/backend/providers/llm";

test("hy3 的别名全部退休，池子里只剩 hy4 flash", () => {
  // `auto-hy3` 也一并退场：magpie 侧回 `404 group/auto-hy3`，留着只会每天浪费调用。
  const stale = Object.keys(MODELS).filter((key) => key.includes("hy3"));
  assert.deepEqual(stale, [], "注册表里不该再有 workbuddy 系 hy3 的别名；文书写在 llm.ts 的那段注释里");

  const hy4 = Object.keys(MODELS).filter((key) => key.includes("hy4")).sort();
  assert.deepEqual(hy4, ["workbuddy-ai-hy4", "workbuddy-cn-hy4", "workbuddy-desktop-hy4", "workbuddy-hy4"]);
});

test("每条 hy4 都用上游真实的 id，且带对 provider 前缀", () => {
  // 2026-11-16 1-token 探针：magpie 3426 认 `workbuddy/hy4-flash`，不认裸 `hy4-flash`
  // （`magpie knows no model "hy4-flash"`）。3066 桥反过来吃裸 id。两种形状各有出处。
  assert.equal(MODELS["workbuddy-hy4"]!.model, "hy4-flash");
  assert.equal(MODELS["workbuddy-cn-hy4"]!.model, "hy4-flash");
  assert.equal(MODELS["workbuddy-desktop-hy4"]!.model, "workbuddy/hy4-flash");
  assert.equal(MODELS["workbuddy-ai-hy4"]!.model, "workbuddy-ai/hy4-flash");

  assert.equal(MODELS["workbuddy-hy4"]!.service, "workbuddy");
  assert.equal(MODELS["workbuddy-cn-hy4"]!.service, "workbuddy-cn");
  assert.equal(MODELS["workbuddy-desktop-hy4"]!.service, "workbuddy-desktop");
  assert.equal(MODELS["workbuddy-desktop-hy4"]!.baseUrlEnv, "WORKBUDDY_DESKTOP_BASE_URL");
});

test("hy4 的每一扇都按站长要求写死最强推理档", () => {
  for (const key of ["workbuddy-hy4", "workbuddy-cn-hy4", "workbuddy-desktop-hy4", "workbuddy-ai-hy4"]) {
    assert.deepEqual(MODELS[key]!.extra, { reasoning_effort: "max" }, `${key} 必须是 max`);
  }
  // hy4 flash 未实测视觉（hy3 实测是「把图 token 化再答错颜色」），所以不许声明 vision。
  assert.equal(MODELS["workbuddy-desktop-hy4"]!.vision, false);
  assert.equal(MODELS["workbuddy-hy4"]!.vision, false);
});

test("agnes 门读得到最强调理，且模型可由部署覆盖", () => {
  // 门本身不做选择：`extra` 从 LLM_EXTRA_JSON / AGNES_CN_EXTRA_JSON 读，模型从
  // LLM_MODEL / AGNES_CN_MODEL 读。部署把两家都钉在 `agnes-3.0-flash` + `{"reasoning_effort":"max"}`。
  // 这里断言的是「这条路真的存在」，所以哪天有人把 get extra() 写死，这条会红。
  const llm = MODELS["default"];
  const cn = MODELS["agnes-3.0-flash-cn"];
  assert.ok(llm && cn, "两个 agnes 别名都要在注册表里");
  assert.equal(typeof Object.getOwnPropertyDescriptor(llm, "extra")?.get, "function", "国际化那扇要从环境读");
  assert.equal(typeof Object.getOwnPropertyDescriptor(cn, "extra")?.get, "function", "国内那扇要从环境读");

  const before = process.env.LLM_EXTRA_JSON;
  process.env.LLM_EXTRA_JSON = JSON.stringify({ reasoning_effort: "max" });
  try {
    assert.deepEqual(llm!.extra, { reasoning_effort: "max" });
  } finally {
    if (before === undefined) delete process.env.LLM_EXTRA_JSON;
    else process.env.LLM_EXTRA_JSON = before;
  }
});
