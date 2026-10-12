// 报警是站长唯一会主动读的东西。而一张没登记过的服务名在这套里出来的样子是：
//   "dots 拒绝服务，可能欠费或账号失效 / 影响：相关功能停了 / 去 dots 后台看余额和账号状态"
// 三句都是回退值拼出来的，看起来像一条报警，实际上什么都没告诉人。
// 2026-10 陆续接进来的五把模型门（agnes-cn、dots、openrouter、opencode、workbuddy）就是这么裸奔的，
// 其中 dots 与 workbuddy 两扇承担着这台机器上判定调用的大头。
//
// PROVIDERS 会长，MODELS 也会长，所以这条判据不能靠人记：MODELS 里出现过的每一个 service，
// 都必须在这张表里有自己的名字、自己的影响、自己的去处。回退值本身就是要拦的东西。
import assert from "node:assert/strict";
import { test } from "node:test";

import { MODELS } from "@aihot/backend/providers/llm";
import { providerConsole, providerName, providerStops } from "@aihot/backend/operations/alerts";

test("MODELS 里每一把门在报警里都有自己的名字、影响和去处", () => {
  const services = [...new Set(Object.values(MODELS).map((m) => m.service))];
  assert.ok(services.length >= 5, `MODELS 至少该有五把门，实得 ${services.length} —— 这条用例失去意义了`);
  const missing: string[] = [];
  for (const service of services) {
    if (providerName(service) === service) missing.push(`${service}（没登记名字，报警会直接喊服务名）`);
    if (providerStops(service) === "相关功能停了") missing.push(`${service}（影响是回退值，等于没说）`);
    if (providerConsole(service) === `${service} 后台`) missing.push(`${service}（去处是回退值"去 ${service} 后台"）`);
  }
  assert.deepEqual(missing, [], `这些服务在 operations/alerts.ts 的 PROVIDERS 里没有登记：\n  ${missing.join("\n  ")}`);
});

// 上面那条判据遍历的是 MODELS 里的门。光那样还能被"把 MODELS 里那两路和 PROVIDERS 里那一行一起删掉"
// 绕过去（两边同时消失，遍历就少一项，测试照样绿），所以这里点名：这七把门必须还有名字。
// 它们都是生产上真在接活的一扇（2026-10-12 实测 workbuddy 与 dots 合起来承担判定调用的大头；
// workbuddy-cn 是同日接上的第二份账号额度 —— 国际版账号的 deepseek 被频率墙打到 19:10，
// 中国版同刻 3.7 秒正常，两份额度互为备份才让"一个账号被墙"不等于"这一步没有模型"）。
test("这七把门不许从报警里消失（点名，不接受「两边一起删」）", () => {
  for (const service of ["llm", "agnes-cn", "dots", "openrouter", "opencode", "workbuddy", "workbuddy-cn"]) {
    assert.notEqual(providerName(service), service, `${service} 从 PROVIDERS 里没了`);
  }
});

// 上面那条判据依赖"没登记时确实会拿到回退值"。这一句把它钉住，否则第一条可以永远绿。
test("没登记的服务名会原样返回（所以上面那条不是空断言）", () => {
  assert.equal(providerName("no-such-door"), "no-such-door");
  assert.equal(providerStops("no-such-door"), "相关功能停了");
  assert.equal(providerConsole("no-such-door"), "no-such-door 后台");
});
