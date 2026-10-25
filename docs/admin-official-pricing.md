# 后台官方费用折算

入口：后台 → 用量总览。与时间范围、服务、模型筛选同步，使用 30 秒只读统计快照与后台刷新。统计真实请求尝试，包含重试，不包含回放。

这是按 **2026-10-25 核验的当前官方 API 单价**折算历史 Token 的参考费用，不是历史实际账单。标准标价、当前优惠价与原有上游实报账单分开；WorkBuddy、CodeArts、MiniMax Code 的订阅、赠送额度和网关加价不包含在内。统一折合人民币：采用2026-10-23中国外汇交易中心中间价，1,000美元=6,718元（[官方转载](https://hzf.mofcom.gov.cn/article/zyfw/jrfw/jrfwywzn/jrfwwh/hlfxglzy/202610/8917.html)）。费用保留完整计算精度，汇总后四舍五入到元；正数不足半元显示“＜1元”，不伪装成免费。页面单价以每十亿Token的人民币整数参考价展示，原始官方单价仍以本表为核验依据。

| 型号 | 币种 | 输入 / 缓存输入 / 输出（每百万 Token） | 官方来源 |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash | USD | 谷时 0.15 / 0.003 / 0.60；峰时翻倍 | [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
| 腾讯 HY3 | CNY | 1 / 0.25 / 4 | [腾讯 HY3](https://hunyuan.tencent.com/research/hy3?langVersion=zh) |
| Step 5 Preview | USD | 1 / 0.1 / 2.7（国际 API 参考价） | [StepFun 定价](https://platform.stepfun.ai/docs/en/guides/pricing/details) |
| MiniMax M3.1 Flash | USD | 0.15 / 0.015 / 0.60 | [MiniMax 发布说明](https://www.minimax.io/blog/minimax-m31f) |
| Dots3 Note Preview | USD | 0.14 / 0.14 / 0.28；当前限免 | [Dots 官方文档](https://dots.ai/platform/docs) |
| Agnes 3.0 Flash 国际版 | USD | 0.05 / 0.005 / 0.15；当前限免 | [Agnes 国际定价](https://wiki.agnes-ai.com/en/docs/pricing) |
| Agnes 3.0 Flash 国内版 | CNY | 0.35 / 0.035 / 1；当前限免 | [Agnes 国内定价](https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash) |

DeepSeek 峰时是 UTC 周一至周五 01–04、06–10 时，排除中国法定节假日。本版使用[国务院 2026 年节假日通知](https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html)，非 2026 年工作日峰时因节假日未核验显示谷时至峰时区间。周末不因调休工作日变为峰时。

缓存输入包含在总输入 Token 内，仅对命中的部分应用缓存单价。缓存明细缺失时，给出全部命中至全部未命中的价格上下界，不虚构命中率；缺少输入或输出的请求不计金额。Dots 未公布缓存折扣，使用普通输入参考价。国内/国际 Agnes 依接入服务区分。Qoder 等无法核验上游型号的历史别名标注未计价，不套用相似名称价格。显示人民币整数，汇总使用未舍入数值。

价格快照维护在 `packages/backend/src/admin/official-pricing.ts`，每次更新需重新核验官方来源及优惠政策，再更新核验日期。本站未自动抓取网页价格，避免网页结构或单位变化导致错误扣价。费用仅用于展示，不写回 `receipt_attempts.cost` 或预算。

迁移 0089 只扩展轻量统计表与既有维护触发器。上线先迁移，再以单连接运行 `node --env-file=.env scripts/backfill-admin-usage-cache.ts`；脚本只回填派生缓存字段，可断点续跑，受 5 秒语句/250 毫秒锁等待限制。缓存明细就绪标志未完成时，页面不显示部分金额。所有生产调用、unknown 回执、模型池、预算与并发保持原有策略。

## 统计稳定性

用量和模型统计均从私有派生快照读取；HTTP请求不等待全表聚合。快照过期后后台刷新，同一时刻全站只运行一个重型统计聚合，失败后冷却30秒，不排队堆积查询。保留上次成功结果及其真实时间，明确标注正在更新；无成功快照时显示生成中并自动重试，不显示假零。快照按版本、筛选键隔离，最多32个文件，权限700/600，保存于数据目录的admin-statistic-snapshots，最长使用24小时。API重启后可恢复，价格/汇率语义更新时须更新快照版本。模型设置和切换记录仍按当前状态读取。

SelectBench后台列表、详情、导入API和模型页空卡片已移除；离线人工金标校准脚本与历史表保留，不影响模型工作流。
