# GEOHOT 编辑大脑 stub（`tooling/brain-stub.ts`）

## 这是什么

一个本机的 OpenAI 兼容假接口。它不调用任何模型，而是按“这条材料是哪一步、是哪一篇”返回**人工撰写的地理编辑判断**（存在 `tooling/fixtures/*.jsonl`）。

背景：本部署没有 LLM API Key。`packages/backend/src/providers/llm.ts` 是在每次调用时才读 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 的，所以把这三个指向本服务，就能让**真实管道原封不动地跑完**：

```
预筛 → 两次独立打分 → 内容理解 → 结构抽取 → 事件归组 → 事件综述 → 日报/周报
```

门槛、五维评分规则、两次打分之和的判定、归组的三值关系、发布层读取路径，全都是 `packages/backend` + `industry/` 里的原代码在原规则下执行。stub 只替换“模型今天怎么想”，不替换“系统怎么裁决”。

**它不是站点的一部分。** 它是内容策划与开发用的工具：不在 `docker-compose.yml` 里，不写数据库，不含密钥，不进公开出口。交付时保留，但README 主文档会说明它只是本机的策划后端。

## 怎么开

```bash
npm run brain            # 前台，http://127.0.0.1:3055/v1
node tooling/brain-stub.ts --lint      # 只检查 fixture（改完稿必跑）
node tooling/brain-stub.ts --schema    # 打印每个能力的 JSON 契约
node tooling/brain-stub.ts --anchors   # 打印它是怎么从提示词认出能力的
```

`.env` 里（由主控维护）：

```ini
LLM_BASE_URL=http://127.0.0.1:3055/v1
LLM_API_KEY=brain-stub        # 只要非空即可，stub 不校验
LLM_MODEL=geohot-brain        # 只要非空即可，stub 忽略模型名
MODEL_CALLS_ENABLED=true      # 关掉时管道根本不发请求（框架的安全阀）
# 不要设 LLM_VISION=true：默认 false，内容理解只收文字，省得 fixture 里还要看图
```

`LLM_EXTRA_JSON`、`LLM_JSON_MODE` 对 stub 无影响（多余的请求字段一律忽略）。想让某一步走别家模型，仍然用 `PREFILTER_MODEL / SCORE_MODEL / …`（`editorial/models.ts` 的 CAPABILITIES 与 env 覆盖名不变）；指向本 stub 时它们都落到同一个 `default`。

自检与审计：

```bash
curl -s http://127.0.0.1:3055/healthz        # 能力数、锚点数、词表、fixture 数、默认策略
curl -s "http://127.0.0.1:3055/__brain/log?limit=20"       # 最近 20 次：认出哪一步、命中哪条 fixture、答了什么
curl -s "http://127.0.0.1:3055/__brain/log?capability=scores&since=120"
curl -s http://127.0.0.1:3055/v1/models
```

## 能力清单与契约

聊天请求体里没有“能力名”（所有能力共用一个模型），所以 stub 从**收到的提示词**反推是哪一步：启动时读 `industry/prompts/*.md`，取每个能力独有的整行文字做锚点（含 `{{占位符}}` 的行、被两个能力共享的行都排除）。提示词被改写后锚点会自动重算（每 5 秒检查一次）；认不出来时**直接 400 拒绝回答**，绝不猜。锚点也失效时才退回内置的调用方字面量兜底，日志里会标 `via:"markers:…"`。

| fixture 文件 | 能力（purpose） | 必须返回的 JSON |
|---|---|---|
| `prefilter.jsonl` | 预筛 `prefilter_article` | `{"label":"PASS"\|"BLOCK"\|"UNKNOWN","reason":"≤200"}` |
| `scores.jsonl` | 打分 `score_article`（**调两次**） | `{"attentionScore":0-100,"scoreSecond"?:0-100}` |
| `understand.jsonl` | 内容理解 `understand_article` | `{"itemType":ITEM_TYPES,"authorRole":"principal\|observer\|relayer","tags":[≤12],"editorialJudgment":"≤400","titleZh":"1-200","summaryZh":"1-4000"}` |
| `summarize.jsonl` | 标题摘要 `summarize_article` | **不是 JSON**：`title_zh: …\nsummary_zh: …`（可加 `body_zh: …`） |
| `structure.jsonl` | 结构抽取 `structure_article` | `{"category":CATEGORIES 的 key\|null,"tags":[≤12],"subjects":[ENTITIES id ≤6],"fact":{"title":"≤80","subject","action","object","occurredAt"}\|null}` |
| `group_batch.jsonl` | 归组 `group_article` | `{"query":"≤400","decisions":[{"candidateIncludes"\|"id","relation":"SAME_OCCURRENCE\|SAME_STORY\|UNRELATED\|ROUNDUP","confidence":0-1,"note":"≤400"}]}` |
| `group_signal.jsonl` | 帖子归组 `group_signal` | `{"decisions":[{"candidateIncludes"\|"id","relation","confidence"}]}` |
| `group_pair.jsonl` | 合并复核 `group_review` / `group_story(_review)` | `{"a","b","relation","difference","confidence":0-1}` |
| `digest.jsonl` | 事件综述 `story_digest` | `{"title":"≤120","digest":"10-2000","latest":"≤300"}` |
| `report_lead.jsonl` | 日报导语 `report_lead` | `{"title":"≤120","leadParagraph":"≤600","highlights":[≤6 个 1-based 编号]}` |
| `report_period.jsonl` | 周报/月报 `report_weekly\|monthly` | `{"headline":"≤60","overview":"≤1500","themes":[{"heading":"≤60","summary":"≤800","refs":[编号]}]}`（themes ≥1） |
| `translate_body.jsonl` | 全文翻译 `translate_body` | `{"t":["按 segments 顺序"]}` 或 `{"segmentMap":[{"includes":"片段关键片段","zh":"译文"}]}` |
| `translate_post.jsonl` | 引用帖翻译 `translate_quoted` | `{"t":["一条译文"]}` |

`monitor`（Codex 重置公告识别）不在地理站的功能面上（`industry/features.ts` 已关），所以没有 fixture 也没有默认策略：真收到就 400。

## fixture 格式

一行一条 JSON：

```json
{"id":"understand-eq-usgs-hokkaido","capability":"understand",
 "what":"示例形状：北海道东部海域 M7.1 主震（非已核验新闻）。",
 "match":{"urlIncludes":"us7000m4zq"},
 "guard":{"url":"https://earthquake.usgs.gov/earthquakes/eventpage/us7000m4zq","sourceKind":"json_list","sourceName":"USGS Earthquake Hazards Program","title":"M 7.1 earthquake off the east coast of Hokkaido, Japan","text":"The United States Geological Survey reports a magnitude 7.1 earthquake at 14:07 UTC on 24 September, epicentre 43.02N 145.21E, depth 51 km…"},
 "reply":{"itemType":"disaster_event","authorRole":"principal","tags":["灾害事件","地震","预警/响应","USGS"],"editorialJudgment":"…","titleZh":"USGS 测定：北海道东部海域 M7.1 地震，震源深度 51 公里","summaryZh":"USGS 测定 9 月 24 日 22 时 07 分（北京时间）…"},
 "author":"张三（地理策划）"}
```

**匹配策略（确定的、可肉眼核对的）**：按文件顺序取**第一条**满足条件的 fixture。所有条件都是“子串是否存在”，只做「去空白 + 转小写」归一，不哈希提示词、不看温度、不依赖候选顺序。

| 条件 | 在哪个范围里找 |
|---|---|
| `includes` / `urlIncludes` / `titleIncludes` / `textIncludes` | 整条 user 消息（= 材料本身）。这四个是**别名**，只是说明片段的来历 |
| `anyIncludes` | 同上，满足其一即可 |
| `notIncludes` | 同上，必须都不出现 |
| `queryIncludes` | 只有归组类有效：只在新报道/帖子那一段里找（第一个 `【候选 C1】` 之前） |
| `candidateIncludes` | 只在候选块文本里找 |

系统提示词永远不参与匹配——否则提示词里“主震与余震”这种措辞会误命中规则。**匹配只在 user 里，作用域只在归组上**。数组是“并且”，要“或者”就多写几行（或用 `anyIncludes`）。

三点写身份键的注意：

1. **打分步骤的请求里没有网址、没有信源名**（`buildScoreInput` 刻意只给时间+原始标题+正文），所以 `scores.jsonl` 只能用标题或正文片段做键。
2. 被打分的是**原文标题**（精选稿的中文标题是之后的事），键也请按原文写。
3. 翻译步骤的请求只有 `{"segments":[…]}`，没有标题没有网址，所以只能按片段文本写键；`t` 的长度必须等于片段数，否则调用方会把批次二分再问一次 —— **批量补稿优先用 `segmentMap`**（按片段寻址，切批也稳）。

## 三条会被真实守卫打回的规矩（`--lint` 会替你撞）

`--lint` 除了查契约形状，还会**加载调用方自己的代码**跑两件事：`normalizeTags`（词表过滤）和 `finalizeCopy`（answer-first 长度 + 身份守卫）。所以给 `understand`/`summarize` 的条目带上 `guard`（把你写稿时依据的原文塞进去）：

- **摘要里机构名的写法必须和原文一致。** 原文写 `USGS`，稿子写“美国地质调查局”会同时命中词表里的“地质调查局”（中国地质调查局），`enforceIdentity` 判定张冠李戴，**整段摘要被丢掉**，条目变成 `relevance=unknown` 不发。
- **`summaryZh` 写在 190 字、2–3 句内**，否则被 `compactAnswerFirstSummary` 压缩（不报错，但你写的句子会没掉）。
- **`tags` 必须是 `industry/taxonomy.ts` 三个词表里的写法**，第一个必须是分类标签；不认识的会被 `normalizeTags` 静默丢弃。`subjects` 只认 `ENTITIES` 的 id。

`itemType` / `category` 的词表来自 `industry/taxonomy.ts`，stub 每次启动和每 5 秒重读，改词表不用重启；写错时日志给出警告（真实的 zod 会在调用方拒绝）。

## 默认策略（没有 fixture 时）

| 能力 | 默认 | 为什么这样兜 |
|---|---|---|
| `prefilter` | `PASS`（reason 注明默认放行） | 宽召回；漏写不该让材料消失 |
| `scores` | `attentionScore=20`（`BRAIN_SCORE_DEFAULT` 可改） | **两次之和 40，任何门槛（60/65/76×2）都过不了** |
| `understand` | 用规则压缩的正文 + `ITEM_TYPES` 第一项 | 只在人工给了高分才会被走到；日志打 warning，提示该补稿 |
| `summarize` | 整句压缩正文前 3 句、标题原样（`BRAIN_SUMMARIZE_DEFAULT=condense\|echo\|empty`） | 只复述原文，不编造译名；`empty` 让条目停在等待态 |
| `structure` | `category:null,tags:[],subjects:[],fact:null` | 不猜分类，不进任何主题页 |
| `group_batch`/`group_signal` | 所有候选 `UNRELATED` | 不凭空把两件事并成一件（`BRAIN_GROUP_DEFAULT=lexical` 才按字面相似合并，且日志标 `rule:lexical`） |
| `group_pair` | `UNRELATED` | 合并两个事件风险最高，必须人工写过 |
| `digest` | 把请求里的报道行按时间列成编年句 | 只复述已有报道 |
| `report_lead`/`report_period` | 按列表复述条目数、分节分组、编号引用 | 素材只有当天已入选的内容 |
| `translate_*` | 片段原样返回（`rule:passthrough`） | 绝不假称已翻译 |

**为什么这套默认值结构上产不出假精选**：精选与否不由 stub 决定 —— `normalizeAnalysis` 要求 `scores.values` 两项之和 ≥ 2×`SELECTION.thresholds[tier]`，而默认分 20 与 60/65/76 的门槛差得很远；`understandFloor=50` 也够不着（默认 `sum=40`）。要让一篇材料进精选，必须有人在 `scores.jsonl` 里写下 ≥ 门槛的分数，并且（想让它有好文案的话）在 `understand.jsonl` 里写下稿子。日志里每条回答都带 `fixture` 与 `author`，可以逐条回溯到写这条判断的人；`rule:*` 的条目就是“没人策划过”的标记。

## 两次独立打分与 `scoreSecond`

框架对每篇材料**串行调用两次打分**，两次的请求体完全一样（只有回执的 `attemptTag` 不同，不体现在 HTTP 里）。stub 按 `(模型, 系统提示词, 用户消息)` 的哈希数第几次收到，返回 `attentionScore`（第 1 次）和 `scoreSecond ?? attentionScore`（第 2 次），并按 2 取模循环，所以重跑同一篇也拿到同一对分数。想模拟“两遍打分不一致”，就写 `scoreSecond`（示例里 `score-adcode-lanchuan` 是 71/55）。

注意：回执按逻辑键缓存。同一 `revision` 重跑分析会**复用已存的回答、不再打到 stub**；`scripts/` 里的重算入口会带新的 `attemptTag`，那才会真的发请求。

## 批量补稿流程（给策划）

1. 从 `industry/sources.json` 抓回来的真材料里挑出值得做的（先跑采集，文章会进 `articles`）。
2. 在对应 `tooling/fixtures/<capability>.jsonl` **追加一行**（不用重启：文件 mtime 变了就重载）。`match` 用这篇材料自己的网址或标题片段。
3. `node tooling/brain-stub.ts --lint` → 必须 `fixturesWithProblems: 0`（`guard` 写全才能查出身份守卫问题）。
4. 跑 worker，`curl "http://127.0.0.1:3055/__brain/log?limit=50"` 看它到底答了什么。
5. 想撤掉一条：加 `"enabled": false`，别删（历史精选要能解释）。

示例种子（9 篇材料、44 条判断）都带 `author:"tooling 示例（未核验）"` 与 `what:"示例形状…"`，只用来演示形状，**不是已核实的事实**，正式策划稿写完后请把它们改成 `enabled:false` 或替换掉。

## 以后换真模型

改 `.env` 里的 `LLM_BASE_URL`（+ `LLM_API_KEY`、`LLM_MODEL`）就是真模型，一行代码都不用动：管道的调用方、门槛、归组、成刊逻辑本来就按真接口写的。反过来，真模型上线后 stub 仍可留着当**回归基准** —— 同一批 fixture 可以比对模型给出的判断与人工判断的差距。

## 诚实的局限

- 它不是模型：没有理解、没有记忆、不会处理没见过的新材料（新材料一律走默认值，也就是不入选、不合并、不精选）。
- 内容必须有人写过。站上的“精选”有多少，取决于 `tooling/fixtures/` 里有多少条人工判断，而不是信源抓回多少篇。
- 打分是静态的：同一篇材料的分数与文案在 fixture 里写死，改材料（revision 变化、标题变化）后旧键可能不再命中，于是掉回默认低分 —— 这是**故意的**，但要知道。
- 归组/综述/日报的默认输出只复述请求里已有的句子，读起来像清单，不像编辑稿；想让日报有样子，得写 `report_lead`/`report_period`/`digest` 三条里对应的条目。
- 审计日志只在内存里（`BRAIN_LOG_SIZE`，默认 500 条），重启就没了。
- 不流式（`stream:true` 直接 400）、不鉴权（只听 127.0.0.1）、不返回图片。别把它放到公网。
- 端口 3055 只服务本进程，与站点 3000/3001、数据库 5433 互不相干；`--lint` 之外它不读写 `apps/`、`packages/`、`database/` 任何东西，也不碰 `.env`。
