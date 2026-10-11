# Space Bunny 摘要思考预留额度证据与离线设计（2026-10-11）

范围：只读生产回执的数值与布尔元数据、公开官方文档/模型映射、本地代码静态分析。不读取或打印凭据和正文，不调用模型，不改代码，不部署/上传/配置/备份/迁移演练。HEAD 134ad74 已有根 agent 458/458 与全类型检查；本轮无代码变化，不重复测试。

## 同版本实际回执

快照时间 2026-10-11 13:08:25 +08。限定 service=opencode、model=space-bunny-free、purpose=summarize_article、当前 promptVersion 尾缀 identity-context@cf3735653e。所有请求摘要 maxTokens=2048。

| 回执状态 | finish_reason | 数量 | completion token范围 | reasoning token范围 | final非空数量 | reasoning非空数量 |
| --- | --- | ---: | --- | --- | ---: | ---: |
| completed | stop | 226 | 490–2047 | 430–1967 | 226 | 226 |
| completed | length | 11 | 2048 | 1963–2040 | 11 | 11 |
| failed | length | 748 | 2047–2048 | 2028–2066 | 3 | 748 |

failed 为回执的当前状态，不能作为独立请求成功率，也不能把全部 failed 解读为未知回执。745/748 最终正文为空；另外3条非空也未成为可用结果。failed 中14条 reasoning_tokens 大于 completion_tokens，表明供应商 token 分项不完全自洽，不能用两者相减当作精确正文 token 数。没有输出正文或 reasoning 文字。

所有 space-bunny-free 回执只有 summarize_article（2048）以及3条旧 ops.probe-door（512）；没有 understand_article，也没有超过2048的摘要/理解请求。所以既有样本能证明 reasoning 确实消耗本次输出额度、边界耗尽与失败相关，不能证明本站曾成功使用8048、更不能证明6000追加额度必能完成。先前6条安全拒收样本均 contentNULL、length、completion2048、reasoning2047–2048，仍与本次聚合一致。没有发现需要把 reasoning 作为正文的证据。

## 官方依据与支持边界

OpenCode [Zen 官方文档](https://docs.opencode.ai/docs/zen/) 声明提供经团队测试的模型并给出 API/模型目录。公开 `https://opencode.ai/zen/v1/models` 的 space-bunny-free 条目只含 id/object/created/owned_by，没有参数或上限字段。

OpenCode 同组织维护的 [models.dev 原始模型定义](https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/space-bunny-free.toml) 在本轮真实读取中明确给出 reasoning=true、interleaved.field=reasoning_content、limit.output=524288，effort 枚举为 low/medium/high/xhigh/max。对应 [公开目录 JSON](https://models.dev/api.json) 同值。这是模型映射的发布能力声明，不是本账户当前Zen路由实际兑现上限的生产实测。没有 none/off，不猜测禁用字段，也不主动选择 low。模型匿名预览身份不解匿名，不假设内部模型家族。

官方 opencode dev 分支旧 provider/transform.ts URL 本轮不可用；没有拿第三方 issue 内容替代参数支持依据。8048 低于发布 output 上限及本站65536硬上限，但需要部署后真实请求才能确认路由接受和写作质量。

## 最小离线补丁设计（尚未实施）

仅精确 spec.key=space-bunny-free 且 purpose=summarize_article 的当前请求，在现有 requestFor 唯一参数计算处启用已有 REASONING_HEADROOM=6000。当前摘要 maxTokens2048计算为8048，保留原全局MAX_OUTPUT_TOKENS裁剪；不新增reasoning_effort或disable参数，不修改registry/model binding、score/understand/其它模型、并发或预算请求计数。该变化会允许同一次请求消耗更多 token/时间，不能说资源开销不变，且不保证需要恰6000；它复用现有机制和硬上限，属于有失败证据与发布能力依据的受控候选。

思考识别若同时决定超时，采用现有 reasoning=240s 的策略需明确测试；不自行增加这个既有超时。新摘要body max_tokens8048、无新extra；其它purpose仍2048及原120s默认。候选为 local-only，是否实施由根 agent 决定。

请求身份变化须与旧精确身份恢复一起做：旧space-bunny summary的maxTokens2048、extra undefined、其它user/system/promptVersion/temperature/json/attemptTag全相同，添加到同池跨成员recovery-only候选，绝不能成为新dispatch选项。

- 旧 received/completed 先精确复用，返回实际模型；零外发。
- 旧 pending/unknown 阻止外发，不能以新8048身份绕过未知保护。
- 旧 failed 保留历史账本，下一次按新8048发送；真实article processing_attempts及第三次ModelOutputError终止仍保持，不能重置文章重试计数。
- current identity、旧identity以及Dots已有旧identity互不混淆；无匹配凭据/模型参数的旧记录不猜测复用。

必要隔离回归：newbody8048无extra、非summary与其它模型参数不变、硬上限保持、跨池旧received/completed零发送、旧pending/unknown阻发、旧failed不发送2048旧参数、坏输出真实worker三次失败边界、Dots现有recovery不回归。只用localhost stub和独立_test库；没有实际供应商探针。实际效果只能在所有目标与最终QA完成后的统一部署后观测，观察真实合格中文稿、length/blank比例、真实pass/block与unknown，不能用stub推断模型质量。
## 后续批准的本地实施与验证

根 agent 基于上述有限证据批准受控本地实现。`llm.ts` 仅精确 space-bunny-free + summarize_article 启用既有6000 headroom；默认摘要2048→8048，保留65536硬上限，使用原reasoning分支默认240s超时，无新extra。泛化legacySummaryParameters，同时保Dots已实现规则；两个模型的精确旧摘要身份均只用于跨池恢复。非摘要和其它模型参数原计算不变。增加同次请求可消耗的token和等待时长，真实Zen路由接受与中文质量仍未验证。

新增`tests/space-summary-request.test.ts`，与已有Dots请求回归在新独立geohot_a13_space_summary_test迁移53项后串行执行，**13/13通过**（2父测试、11子测试）。实际localhost HTTP body验证Space摘要8048无extra、score/understand2048原参数、其它default摘要2048、超大调用65536裁剪；旧received/completed跨池零发送复用，pending/unknown阻发，failed不发2048旧参数；真实worker坏写作第三次failed且不刊发。Dots原参数和旧回执恢复回归保持通过。backend/tests类型检查通过。

finally还原环境、预算、settings、queue/cache，精确测试receipts/sources/articles/jobs/queues清理核查均0，随后DROP独立库。本地修改未提交、未部署、未探针，不以stub结果宣称供应商已改善。根agent负责合并后的全量门禁。