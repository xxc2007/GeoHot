import assert from "node:assert/strict";
import { test } from "node:test";
import { routingWeights, type RoutingSample } from "../packages/backend/src/editorial/routing-weights.ts";

const members = ["fast", "slow", "new"].map(name => ({ name, service: name, model: name }));
const sample = (name: string, ms: number, extra: Partial<RoutingSample> = {}): RoutingSample => ({ service: name, model: name, purpose: "group_article", total: 10, accepted: 10, median_ms: ms, pending: 0, ...extra });
test("routing learns same-step real latency without excluding unmeasured or slower healthy members", () => {
  assert.deepEqual([...routingWeights(members,"group_article",[sample("fast",10000)])].map(x=>x[1]),[1,1,1]);
  assert.equal(routingWeights([members[0]!,members[0]!,members[1]!],"group_article",[sample("fast",10000)]).get("fast"),1,'configured duplicate weights are not independent evidence');
  assert.deepEqual([...routingWeights(members,"group_article",[sample("fast",10000),sample("slow",40000)])].map(x=>x[1]),[4,1,1]);
  assert.deepEqual([...routingWeights(members,"group_review",[sample("fast",10000),sample("slow",40000)])].map(x=>x[1]),[1,1,1]);
});
test("routing does not reward failed output, tiny stub timings or overloaded members", () => {
  assert.deepEqual([...routingWeights(members,"group_article",[sample("fast",1),sample("slow",10)])].map(x=>x[1]),[1,1,1]);
  assert.deepEqual([...routingWeights(members,"group_article",[sample("fast",10000,{accepted:3}),sample("slow",40000)])].map(x=>x[1]),[1,1,1]);
  const measured=[sample("fast",10000,{pending:3}),sample("slow",40000)];
  assert.equal(routingWeights(members,"group_article",measured).get("fast"),1);
  assert.equal(routingWeights(members,"group_article",[sample("fast",10000),sample("slow",40000),sample("new",10)]).get("new"),1);
});
