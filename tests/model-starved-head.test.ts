import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 2026-11-08：池子里排第一的成员被上游规则静默饿死时，「顶置」永远不生效。这条守住那个探针位。 */
const source = readFileSync("packages/backend/src/editorial/models.ts", "utf8");

test("modelFor 在选出 serving 之后补一个探针位", () => {
  const serving = source.indexOf("const serving = await servingMembers(listed, capability);");
  const probe = source.indexOf("await keepStarvedHead(serving, head);");
  assert.ok(serving > 0, "modelFor 必须用 servingMembers 选中");
  assert.ok(probe > serving, "探针必须排在 servingMembers 之后");
  const between = source.slice(serving, probe);
  assert.equal(between.includes("\n  const step ="), false, "探针要在按步长挑权重之前");
});

test("池首认配置顺序，不认被重排过的列表", () => {
  // 2026-11-08: 实测 UNDERSTAND 的 listed[0] 变成了池尾那家 —— 在重排后的列表上「顶置」等于没置。
  assert.ok(source.includes("const head = poolOf(chosen)[0];"), "池首要从配置串里取");
  assert.equal(source.includes("keepStarvedHead(serving, listed)"), false, "不许再把重排后的列表当池首");
});

test("探针把配置里的池首补进服务集", () => {
  const start = source.indexOf("async function keepStarvedHead(");
  assert.ok(start > 0, "缺少 keepStarvedHead");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.ok(body.includes("serving: string[], head: string | undefined"), "签名收的是配置里的池首");
  assert.ok(body.includes("if (!head || serving.includes(head)) return;"), "已经在 serving 里就不补");
  // 2026-11-08: 判据改成「先取 sick、再判 benched」——确诊时要能把挡人的键打出来，写成一行就没地方打日志。
  assert.ok(body.includes("const sick = await sickServices();"), "探针要读一次 sick");
  assert.ok(body.includes("if (benched(sick, head))"), "确诊时要说明是谁挡的");
  assert.ok(body.includes("serving.push(head);"), "配置里的池首照旧进服务集");
  assert.ok(body.includes("serving.push(head);"));
});
