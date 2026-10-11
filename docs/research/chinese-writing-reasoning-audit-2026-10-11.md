# 中文写作空正文与思考令牌审计（2026-10-11）

本轮只读线上元数据并在内存检查最多 10 条回执；实现和验证均在本地。没有调用线上模型、修改生产参数、提高预算或输出上限，没有部署、上传、push、备份或迁移演练。当前工作门禁仍是全部目标内容、刊物、移动端和最终检查完成后统一交付。

## 生产样本与可确认原因

观察时间：2026-10-11 12:40:28（Asia/Shanghai）。精确 writer 拒收样本为 9 条：OpenCode space-bunny-free 6 条，Dots dots3-note-prev 3 条。它们的最终 `choices[0].message.content` 全部为空或 NULL，`finish_reason` 全部为 `length`。最终正文、重新解析后的 title/summary/body 均无中文，正文标签缺失，无 `<think>` 标签；纯解析重放接受数为 0/9。思考字段中 9/9 有中文，但它们属于 reasoning_content，不能作为可发表正文。报告不保存原文、完整模型回答或凭据。

| 服务/模型 | 样本 | request max_tokens | completion_tokens | reasoning_tokens | 最终正文 | reasoning_content |
| --- | ---: | ---: | ---: | --- | --- | --- |
| OpenCode / space-bunny-free | 6 | 2048 | 2048 | 2047–2048，6/6 提供此 usage 字段 | 6/6 空 | 6/6 非空且含中文 |
| Dots / dots3-note-prev | 3 | 8048 | 8048 | usage 未提供，未知 | 3/3 空 | 3/3 非空且含中文 |

该有界样本支持“输出额度耗尽时尚未形成最终正文”，并不支持“解析器丢失了正确中文正文”。Dots 的思考令牌具体数量未知，不能把全部 completion_tokens 断言为 reasoning_tokens。此观察不能代表全部历史回执，不能证明关闭思考后的真实内容质量已改善。之前短窗真实统计可见 OpenCode 明确拒收，但它也不能替代本表逐条检查。

`parseTranslateOutput` 对匿名合成的中文标签格式能正常提取；`noChineseAnswer` 对空 final content 仍拒收。未将思考过程作为正文，未无证据修改解析器。

## 参数依据与最小本地改动

Dots 官方 [API 文档](https://dots.ai/platform/docs) 的公开文档资产 [ApiDocsPage-BmqUQLeI.js](https://dots.ai/platform/assets/ApiDocsPage-BmqUQLeI.js) 包含短回答请求示例，使用 `chat_template_kwargs.enable_thinking=false`。本轮仅采用这一已确认的 Dots 控制，不猜测 OpenCode 的同名支持。

OpenCode 官方 [Zen 文档](https://docs.opencode.ai/docs/zen/) 提供公开模型目录入口；[模型文档](https://docs.opencode.ai/docs/models/) 中其它模型的 reasoning 参数示例不能证明 space-bunny-free 兼容。公开目录对应条目只有基本模型元数据，本轮未找到该免费模型可验证的禁用思考参数。因此不更换绑定、不添加未确认控制、不注册模型，不做付费探针。

`packages/backend/src/providers/llm.ts` 在唯一请求参数计算函数 `requestFor` 中，只针对 `dots3-note-prev` + `summarize_article` 归一化为禁用思考，删除该摘要请求的 `reasoning_effort=high`。摘要原本调用给定的 2048 输出额度保持 2048，不提高上限；由于不再开启思考，原有 6000 reasoning headroom 不再追加。score/understand 等非摘要 purpose 保持原参数与原上限计算。模型池、预算、并发、扫描节奏和账本不变。

为防请求身份变化导致重复购买，旧参数摘要身份（enable_thinking=true/high，原 8048 上限）加入精确 recovery-only 候选。旧身份不加入新 dispatch 选择。当前池内其它成员查询同样包含 Dots 的旧身份，复用后实际模型仍报告 Dots。

- 旧 received/completed：恢复并解析已有结果，不外发；解析拒收仍按现有流程处理。
- 旧 pending/unknown：在预算锁和外发之前阻止新请求，保留未知保护。
- 旧 failed：保持旧记录，不按旧思考参数重新发送；下一次实际外发采用新摘要参数，坏输出仍受真实 worker 第三次失败上限保护。
- 不修改 receipts/receipt_attempts 状态、费用或 usage，不抹掉旧付费历史。

## 本地验证与边界

新增 `tests/dots-summary-request.test.ts` 使用 localhost stub 和独立 `geohot_a13_dots_summary_test`（127.0.0.1:5433）。53 个迁移完成后，针对性测试 **6/6 通过**（父测试 + 5 个子测试），backend/tests TypeScript 检查通过。

验证了新摘要 HTTP body 为 2048、禁用思考且无 high；score/understand 仍为 8048、开启思考且 high；旧 received/completed 跨池恢复零发送；旧 pending/unknown 跨池阻发且状态保持；旧 failed 只恢复身份不新发送旧参数；合格新摘要可再次复用；匿名空正文与中文 reasoning 仍拒收；真实 registerContentJobs/worker 对坏写作执行三次后 failed，没有刊发。测试 finally 还原环境、预算、设置、队列和模型缓存并清除测试数据。

清理核查：test receipts/sources/articles/jobs/queues 均为 0；随后 DROP 上述独立测试库。未运行生产探针。全库回归由根 agent 在合并后统一运行。

线上是否能得到更多合格中文摘要仍待最终统一部署后的实际工作流观测；此次 local stub 验证参数与恢复安全性，不把 stub 成功当成供应商实际效果。OpenCode 空正文瓶颈尚无已证实的参数修复，继续保持原参数与输出拒收保护。