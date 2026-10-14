# 第九十五轮：把 10 扇模型门摘出生产池（2026-10-14 21:14–21:33 CST）

站长看着上一轮那张盘点表点名删门。这一轮只动生产配置，不动代码、不动前端、不重建。
所有数字都是当场从 `budgets` / `receipts` / `receipt_attempts` / `articles` 与生产 `.env` 读的，
不是复述上一轮的读数——两批读数之间线上一直在写，差几分钟就不一样。

## 一、删了什么，凭什么删

| 门（成员名） | 24h 尝试 | 24h 答出 | 失败率 | 摘它的依据 |
| --- | --- | --- | --- | --- |
| `space-bunny-free`（opencode） | 26 | **0** | 100% | 全是 `HTTP 403 FreeTierError`；当天 62 条终态 `failed` 里 **25 条**就是它钉的 |
| `or-nemotron-ultra` | 67 | 31 | 53.7% | 六条成员共用**同一个账号**的免费日额，成员多不多给容量 |
| `or-nemotron-nano` | 44 | 15 | 65.9% | 同上 |
| `or-dots-studio` | 42 | 14 | 66.7% | 同上，且它有 1 条 `unusable output` 也把条目钉死 |
| `or-lfm` | 39 | **0** | 100% | 同上 |
| `or-nemotron-super` | 29 | **0** | 100% | 同上 |
| `or-north-mini-code` | 25 | **0** | 100% | 同上 |
| `workbuddy-glm-flash` | 2,024 | 1,666 | **17.6%** | 340 次 `workbuddy rate limited (HTTP 429)`；同一个模型在中国版账号上只败 0.2% |
| `workbuddy-cn-glm-flash` | 1,820 | 1,814 | 0.2% | 站长按精简要求一起摘（它本身是健康的） |
| `workbuddy-cn-deepseek-flash` | 2,406 | 2,403 | 0.0% | 同上；它是全站额度最大的一笔：727.5 credits/24h、19.95M token/24h |

六条 OpenRouter 加 opencode 合计只贡献当天 **60 次答复（占吞吐 0.2%）和 0.30M token（占 0.16%）**，
却贡献了全站失败的 **15.7%**。三条 WorkBuddy 成员是另一类：它们能答，但站长要的是把门数收下来。

改完之后：`MODEL_POOL` 17 → **7**，`UNDERSTAND_MODEL` 与 `TRANSLATE_MODEL` 各 15 → **7**（三条变量行现在是同一组名字），
`OPENROUTER_API_KEY` 与 `OPENCODE_API_KEY` 两行从 `.env` 删除（值只留在那份 root-only 备份里）。
保留的 7 扇：`agnes-3.0-flash-cn, default, dots3-note-prev, workbuddy-hy3, workbuddy-step5-preview, workbuddy-cn-hy3, workbuddy-cn-step5-preview`。

**没有动的东西是故意的**：`budgets` 那 15 行一行没删（没有 budgets 行就没有熔断，见 `providers/receipts.ts` 的提前返回）；
`providers/llm.ts` 的注册表条目也留着（`poolOf()` 会把不在池里的名字直接忽略，恢复只需把 key 与名字加回 `.env`）；
两把 WorkBuddy 的 key 都还在用（各自桥上的 hy3 与 step-5-preview）。

## 二、怎么保证不伤线上

1. 改前先看窗口：`geohot-archive.service` 必须 `inactive`（21:11 实测 load 1.37，一轮刚结束）才动手。
2. 改 `.env` 用一个**带闸门的脚本**（默认 DRY-RUN）：三条池行必须命中预期成员数、摘完必须正好等于那 7 个名字、
   保留的 5 把凭据逐条比对"值未改动"、除这 5 行外每一行必须字节相同——任何一条不过就拒写。
   实测：`文件 62 行 → 60 行，sha256 ef31cbd3fbd2f115… → 27b1b2e8c1837990…`。
3. 备份 `/root/geohot-env.pre-slim-<STAMP>`（600，root），含被删两把 key 的原值，可一键回退。
4. 只重启读池子的三个单元（worker / api / brain）；**web 与两条 workbuddy 桥不重启**——web 不调模型，
   桥的凭据面没变，少重启一个就少一分在飞条目被钉住的风险。
5. 验"路由真的变了"而不是验"文件改对了"：重启后 3 分钟 `receipts` 里只有那 7 扇在答；
   最近 60 秒 `receipt_attempts` 里那 10 扇 0 次尝试；队列里 1,880 个 `content.analyze` 任务的负载
   只有 `articleId` 一个键、**没有任何 model 字段**，所以排队的活会按新池子重新分门，不存在旧任务打到已摘的门。

## 三、多维测试的结果

| 维度 | 判据 | 结果 |
| --- | --- | --- |
| 能力→门 的解析 | 让站点自己的 `modelSources()` 回答 11 个能力各有哪些门在服务 | 11 个能力全部 **7 配置 / 7 在服务**，含没人看见也在跑的 `translate` 与 `report`；那 10 个名字一处都不出现 |
| 真实工作流 | 重启后各门的答复数与失败形状 | 7 门都在答，`failed` 形状 0 条新类型；没有 `no usable model` / 空池 类报错 |
| 读者面 | 20 个页面 + 7 个 API 端点重查一遍 | 全部 200，**零 5xx**、零空正文；首页 40 条可开链接、今日日报第 10 期 14 条、关于页 666 == `stats.sources` 666 |
| 判定吞吐 | 分钟桶与小时桶对照改动前的带 | 21:20–21:29 每分钟 6–79，21:00 那一小时（只跑了 22 分钟）已有 227 条 ⇒ **没有掉**，比上轮量的 45–132 篇/时高 |
| 数据一致性 | `stats` 与页面同读 | items 40,963 / selected 4,296 / dailies 280 |
| 副作用 | 今天新增的终态 `failed` 是谁造成的 | 只有 4 条 `receipt … outcome unknown`，而这三条能看到的收据 **created 21:00–21:04、超时在 21:04–21:08**，都早于 21:14 的重启；它们是 `step-5-preview` 走桥的既有背景类（按天：10-13 有 2、10-09 有 1、10-07 有 2、10-06 有 5），不是本轮代价 |

## 四、我自己踩的坑（写下来免得再踩）

手工跑仓库脚本时我用了 `bash -c 'set -a; . /opt/geohot/app/.env'` 灌环境变量，
结果 `LLM_EXTRA_JSON={"enable_thinking": false}` 被 shell 在空格处截断，五条判定全部白报
`LLM_EXTRA_JSON must be a JSON object`。**线上单元不受影响**（systemd 的 `EnvironmentFile` 是逐行字面读的）。
正解是仓库文档本来就写的那一条：`node --env-file=/opt/geohot/app/.env …`。
第二条：我的旁路调用撞上 `Budget for agnes-cn exhausted (minute)`——那 4 条条目 `processing_attempts` 仍是 0、
状态仍 `new`，说明熔断是在发请求**之前**拦的，不烧条目也不烧钱；但这也说明剩下的 7 扇里
agnes 两门与 dots 已经贴着自己的分钟窗跑，旁路实测要按"会被熔断"来预期。

## 五、出刊连续性到哪一步了

`backfill-papers.ts` 对 2026-01-01 → 2026-10-13 的整段 DRY-RUN（335 期计划）读数：

| 分类 | 期数 | 含义 |
| --- | --- | --- |
| 已有可读刊期 | 98 | 已经出给读者的 |
| **已判完、但当天 0 条精选** | **5** | 2026-01-01、01-26、03-02、05-18、07-20：`candidates()` 的第一条谓词就是 `p.selected`，所以这几期**按设计出不来**，不是漏印 |
| 还没判完 | 231 期 | 落在 **181 天**上，合计 **1,250 条**未结算（按 `settled-days.ts` 的正定义：`new` 或 `analyzed` 却缺投影；231 是期次数，因为周报月报也挂在同一些日子上） |
| 区间外 | 3 | weekly **W01**（区间下界挡住，本轮已单独补出，见下）/ W42（本周未关窗）、monthly 2026-10（10 月未完） |

关键一格是硬判据 `settled_days_unprinted_with_material = 0`：**没有任何"判完了、有料、却没印"的日子**，
`blank_editions` 也是 0。所以缺口全在队列那一头：1,250 条待判按当前节奏约两三小时排空，
排空过程中档案周期自己的 papers 阶段会把结算出来的日子逐日补刊。
最接近出刊的两天是 2026-08-27 与 08-31，各差 2 条。

### 周报与月报逐期点过一遍（22:04）

按周个数：`2026-W02 … W41` 全有期次，**只有 `2026-W01`（窗口 2025-12-29→2026-01-04）漏着**——
它已关窗、有 24 条素材（落在 12-31、01-02、01-03、01-04、01-05 这五天），但回填的区间下界写的是
`2026-01-01`，所以周期那一路永远不会回头看它。这一期用站点自己的脚本补了出来：
`backfill-papers.ts --from=2025-12-29 --to=2026-01-04 --kinds=weekly --apply` ⇒
`weekly 2026-W01 entries=24 / 已出刊`，现在 `/geohot/weekly` 与 `/api/site/reports/weekly` 都列得到
（周报 41 期，最早 `2026-W01`，该期 10 条）。**这一发同时是删门之后 `report_weekly` 第一次真跑通**：
服务它的是保留下来的 `workbuddy / hy3`，`status=completed`。

月报：`2026-01 … 2026-09` 各一期都在（各月精选 200–609 条）；`2026-10` 未出是没关窗（1,349 条精选还在往里长）；
`2025-12` 只有 4 条精选且整月落在采集起点之前，按设计不单独成期。`2026-W42`（本周）同理，等周一关窗由实时路径出。

## 六、其余几路验证（21:41–21:57）

| 路 | 命令/判据 | 结果 |
| --- | --- | --- |
| 仓库质量闸门 | `npm run typecheck`；`npm test`（`geohot_test`）；`node --test apps/web/tests/*.test.ts` | 类型检查 7 个项目零错；**546/546 通过**；web **58/58**。池子那族单独也绿：`model-pool` 13/13、`receipt-pool-recovery` 23/23、`receipts` 7/7、`workbuddy-headroom` 全过。没有一条测试抄生产 `.env` 的成员表（`npm test` 根本不带 `--env-file`，两个池子测试还在 import 时删掉 `MODEL_POOL` 与所有 `*_MODEL`） |
| 唯一的红 | `tests/default-model.test.ts` 单独跑时 `Budget for llm exhausted (minute)` | **不是本轮改动**：它自己不抬那把共享的分钟窗（`model-pool.test.ts` 会抬到 500 再还原），被我自己的整轮跑留下的 25 次尝试占满；窗口清空后单跑 1/1 通过。这是一条既有的共享预算顺序依赖 |
| 部署验收 | `deploy/geohot/verify-deploy.sh` | **ALL CHECKS PASSED**（含两个邻居站首页哈希与根 sitemap 未变、`smoke.ts` 全绿、跨出口一致 280 indexed / 280 listed by v1、六路读者文本"都有中文标题"） |
| 后台与鉴权面 | `/geohot/api/admin/runs`、`/api/admin/models` 未登录 | 均 **401**（没有免登录路径被这次重启带出来） |
| 两条桥与 brain | `:3065/v1/models`、`:3066/v1/models`、`:3055/healthz` | 200 / 200 / `ok:true` —— 桥没重启、凭据没动，与摘掉的那三条 WorkBuddy 成员无关 |
| 六个单元内存 | `MemoryCurrent` | web 30 MB、api 80 MB、worker 105 MB、brain 10 MB、两条桥 33/23 MB，都远没顶到各自的 `MemoryMax` |
| 当月连续性 | 2026-10-01…10-14 逐日期次 | 全在、无缺日；期号连着 1…10。10-04/05/06 那三期是 10-13 补印的（`issue_no` 空 = 回填期次不领号，按设计） |
| 排空趋势 | `processing_state='new'` | 21:29 1,762 → 21:41 1,636 → 21:55 **1,532**（≈450–600 条/时）；`papers` 阶段在 21:45 那轮 exit=0 却没出新期，与"判完了、有精选、却没期次"的日子数 = **0 行** 完全一致——它不是没干活，是还没有料可排 |

## 七、顺手查出来的两件事（都不归本轮改动，归站长拍）

1. **早于窗口的进口**：`publications` 里有 **1,700 行**的期次日早于 2026-01-01（最早 2001-01-01），其中 **139 行已经是精选**。
   `backfill-papers` 的区间从 2026-01-01 起 ⇒ 这 139 条永远不会进任何一期，判定钱是白花的；
   集中在比格洛海洋实验室(301)、Leventhal 地图中心(239)、人民网时政/国际(各 100)、NGA(94)、
   Dialogues in Human Geography(89)、IGN France(76)、One Ecosystem(69)。
   修法形状是给这些门在 `industry/sources.json` 的 config 里补 `_aihot.initialBackfillMonths`（首导按月份封顶）。
   **必须说清的反面**：同一条查询里 `d > current_date` 数出的 1,703 行**不是缺陷**——
   日报窗本来就是 `[D-1 08:00, D 08:00)`，北京时间 08:00 之后发的条目属于"下一期"的标签，别照着这个数字去"修"。
2. **档案周期的出刊窗口末端是写死的**：`/etc/geohot/archive-cycle.conf` 里 `GEOHOT_ARCHIVE_FROM=2026-01-01`、
   `GEOHOT_ARCHIVE_TO=2026-10-10`。今天 10-11…10-14 靠的是实时侧 `catchUpReports`（覆盖最近七天），所以当月没缺日；
   但这个 `TO` 不会自己往前挪，拖久了"迟到的档案条目"就再也回不到它们自己的那几天。要改的是这台机上的 conf（仓库外），归站长。

