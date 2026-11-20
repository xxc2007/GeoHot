# 后台官方费用折算

入口：后台 → 用量总览。与时间范围、服务、模型筛选同步，使用 30 秒只读统计快照与后台刷新。统计真实请求尝试，包含重试，不包含回放。

## 成本口径

- **价卡来源只认官方页面 / 官方手册 / 合同与实际账单**；本站不自动抓取网页价格，避免网页结构或单位变化导致错误扣价。
- **`billing_kind` 口径**：价卡表五值——`equivalent-public-api`（公开 API 刊例/等值估算）、`subscription`（订阅制，不单按 token 计价）、`free`（免费）、`no-price`（无公开价）、`unverified`（未核实）；迁移 0124 的 CHECK 另保留 `actual`，共六类。`actual` 只来自回执 `cost_basis='actual'`；价卡侧任何公开 API 价都落 `equivalent-public-api`，绝不写 actual。Seed 侧 `public-api → equivalent-public-api`、`no-public-price → no-price` 由 `packages/backend/src/admin/pricing-map.ts` 归一。订阅、免费、无公开价分列展示，不混进 API 单价折算；查不到官方价标 `no-price`，未核实标 `unverified`，不估算、不套用相似名称价格。
- **按调用时有效价卡计价**：DeepSeek 峰谷按请求开始时的北京时间规则解析，不还原历史调价；历史用量按所选时间范围内有效单价折算，不是实际账单或订阅扣款。
- **单价版本化**：`pricing_rates` 表（迁移 0124）存最新价卡行，`OFFICIAL_RATES` 常量只作 seed/兜底；表无行或迁移未跑时回落常量并标记 `stale`。价卡 seed 随迁移落库：`scripts/migrate.ts` 自动调 `seedPricingRates`，干净克隆跑 `npm run db:migrate` 即幂等 upsert 仓库内 A/B/C 映射（`database/seeds/pricing/map-{A,B,C}.json`，当前 47 条；条数以 seed 文件与 `pricing_rates` 表现查为准），无需手工导入。
- **异步核对**：`geohot-pricing-check` 单元复核价卡与汇率并 upsert；`geohot-pricing-rates-refresh.{service,timer}` 只校验现有 seed 价组合——`OnCalendar=06:10 Asia/Shanghai`、`Persistent=true`，执行 `/usr/bin/node tooling/refresh-pricing-rates.ts`；HTTP 200 不算成功，必须解析出正数 input/output 单价才置 `stale=false`；失败/无法解析则写 `last_error`、置 `stale=true`，保留最后成功价卡，不清空费率，也不解析新价、不自动改价。页面请求时不打外网。价卡缺标注项（missingLabels）不阻塞出账。
- **汇率单一事实源**：优先 `fx_rates` 表最新行，无记录时回落 `CNY_FX` 兜底常量；不在文档里抄写死汇率数值。
- 费用仅用于展示，不写回 `receipt_attempts.cost` 或预算。

## 单价与模型对照

当前各模型的币种、输入/缓存输入/输出单价、`billing_kind`、官方来源链接与核验日期，以后台「用量总览」价卡和 `pricing_rates` 表为准；代码种子常量见 `packages/backend/src/admin/official-pricing.ts` 的 `OFFICIAL_RATES`。文档不另维护一份会过期的价格表。

- DeepSeek 峰时为 UTC 周一至周五 01–04、06–10 时，排除中国法定节假日；周末不因调休工作日变为峰时。节假日表写在 `peakFactor` 内。
- 缓存输入包含在总输入 Token 内，仅对命中的部分应用缓存单价。缓存明细缺失时按缓存命中价折算（单一口径，不显示区间）；缺少输入或输出的请求不计金额。未公布缓存折扣的渠道按普通输入参考价。国内/国际 Agnes 依接入服务区分。Qoder 等无法核验上游型号的历史别名标注未计价，不套用相似名称价格。显示人民币整数，汇总使用未舍入数值。

## 统计与回填

用量和模型统计从私有派生快照读取；HTTP 请求不等待全表聚合。单次统计 SQL 截止 30 秒，后台刷新同一时刻全站只运行一个重型统计聚合，失败后冷却 30 秒，不排队堆积查询。保留上次成功结果及其真实时间，明确标注正在更新；无成功快照时显示生成中并自动重试，不显示假零。

首次快照的可用性判据由 `usageHeadroomFor` 计算，必须与 resource-cron 同口径：`availableMiB >= 64`、`memoryFull < 40`、`ioFull < 40`、`cpuSome < 70`、`diskFreeMiB >= 3072`。旧阈值要求 `memoryFull < 15`、`ioFull < 40`，在 891MiB 读者机的常态压力（现场 memoryFull 20–32）下会永远无法生成第一份快照，页面长期停在 `status.state=unavailable`，不是“正在生成”的正常冷启动。部署后必须实测 `/api/admin/usage?range=today` 返回 `ready` 或 `stale` 且 `rows` 非空或明确为零；仍为 `unavailable` 时查 headroom 和聚合错误，不能只重启 API。

无有效价卡（订阅、免费、无公开价、未核实）的调用计入未计价，不估算、不倒算。快照按版本、筛选键隔离，最多 32 个文件，权限 700/600，保存于数据目录的 `admin-statistic-snapshots`，最长使用 24 小时。API 重启后可恢复；价格/汇率语义更新时须更新快照版本。模型设置和切换记录仍按当前状态读取。

轻量统计表与维护触发器由迁移扩展；上线先迁移，再以单连接运行 `node --env-file=.env scripts/backfill-admin-usage-cache.ts`。脚本只回填派生缓存字段，可断点续跑，受 5 秒语句 / 250 毫秒锁等待限制。缓存明细就绪标志未完成时，页面不显示部分金额。所有生产调用、unknown 回执、模型池、预算与并发保持原有策略。

SelectBench 后台列表、详情、导入 API 和模型页空卡片已移除；离线人工金标校准脚本与历史表保留，不影响模型工作流。
