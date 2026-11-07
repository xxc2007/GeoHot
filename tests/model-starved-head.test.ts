import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 2026-11-08：池子里排第一的成员被上游规则静默饿死时，「顶置」永远不生效。这条守住那个探针位。 */
const source = readFileSync("packages/backend/src/editorial/models.ts", "utf8");

test("modelFor 在选出 serving 之后补一个探针位", () => {
  const serving = source.indexOf("const serving = await servingMembers(listed, capability);");
  const probe = source.indexOf("await keepStarvedHead(serving, listed);");
  assert.ok(serving > 0, "modelFor 必须用 servingMembers 选中");
  assert.ok(probe > serving, "探针必须排在 servingMembers 之后");
  const between = source.slice(serving, probe);
  assert.equal(between.includes("\n  const step ="), false, "探针要在按步长挑权重之前");
});

test("探针只补没有失败证据的头部成员", () => {
  const start = source.indexOf("async function keepStarvedHead(");
  assert.ok(start > 0, "缺少 keepStarvedHead");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.ok(body.includes("const head = listed[0];"));
  assert.ok(body.includes("if (!head || serving.includes(head)) return;"), "已经在 serving 里就不补");
  assert.ok(body.includes("if (benched(await sickServices(), head)) return;"), "确诊失败的成员不补");
  assert.ok(body.includes("serving.push(head);"));
});
