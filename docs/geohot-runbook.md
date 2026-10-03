# GEOHOT 运营手册

给站长本人和以后接手这个站的 AI 助手。仓库根的 `../README.md` 讲"这是什么"，`docs/manual.md` 讲"怎么跑起来"，这份讲**每天怎么把它往前推**。所有命令都是本机（Windows 11 + Git Bash + Node v24.19.0）实际存在、逐项核对过的；没跑过的我会标出来。

约定的启动方式（下文所有命令都假设这四样在跑）：

```bash
npm run db:up -- --daemon                                              # 127.0.0.1:5433
npm run brain                                                          # 127.0.0.1:3055
node --env-file=.env --env-file=.env.pipeline apps/api/src/main.ts     # 127.0.0.1:3001
node --env-file=.env --env-file=.env.pipeline apps/worker/src/main.ts  # 队列与定时任务
npm run dev:web                                                        # http://localhost:3000
```

worker 不监听端口，所以 `netstat` 看不到它。判断它在不在，看队列有没有被消费：

```bash
node --input-type=module -e "
import p from 'postgres';
const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});
console.log('processing', JSON.stringify(await a.unsafe('select processing_state, count(*)::int n from articles group by 1')));
console.log('last analyzed', JSON.stringify(await a.unsafe('select max(created_at) t from analyses')));
await a.end();"
```

`analyses` 的最大时间戳在往前走 = worker 活着。定时任务的实际执行记录在后台 `/admin/runs`（表 `job_runs`）。

---

## 1. 每天 15 分钟的循环

1. `/admin/sources`：列表按健康度排序，**失败的在最前**。有红的就先处理（第 3 节）。
2. `/admin/content`：看今天进来了什么、哪些卡在"待分析"。
3. `curl "http://127.0.0.1:3055/__brain/log?limit=30"`：看 stub 今天替谁做了判断，哪些是 `rule:*`（= 没人策划过，走默认值）。
4. 想加内容就走第 4 节（补 fixture），想改标准就走第 6 节（gold + 评测）。
5. `/feedback` 有没有读者话（第 8 节）。
6. 每周一次第 9 节的清理与备份。

管道自己会做的事（`apps/worker/src/schedules.ts`，全部按 Asia/Shanghai）：`content.sweep` 每 5 分钟捞没处理的材料、`content.translate` 每 5 分钟、`hot.rank` 每 5 分钟、`hot.snapshot` 每小时第 2 分、`stories.status` 每小时第 7 分、`stories.links` 每小时第 12 分、**`reports.daily` 每天 08:00**、`reports.catch-up` 每小时第 15 分（只补**缺**的那期，已存在的不重算）、`ops.retention` 03:30、`sources.icons` 04:40、`ops.alerts` 每 10 分钟、`sources.schedule` 每分钟（只在 `COLLECT_ENABLED` 打开时注册，schedules.ts:81-88）。

---

## 2. 加信源

### 2.1 能轮询的（RSS / 网页列表 / JSON 接口）

**先在后台试，再写进文件。** 后台 `/admin/sources/new` 建一条（或直接在 `/admin/sources/<id>` 改），点"**预览抓取**"——它不落库，只告诉你抓到几条、长什么样。满意了再点"立即采集"。

想留档（下次 `scripts/seed.ts` 也认它），把这条追加进 `industry/sources.json` 的 `sources` 数组，然后：

```bash
node --env-file-if-exists=.env scripts/seed.ts
```

`seed.ts` 是 `ON CONFLICT (id) DO NOTHING`：**只增不改**，你在后台改过的东西不会被覆盖。

三条硬规矩（踩过就浪费时间）：

- `tier` 的合法值是 **`T1_5`**，不是 `T1.5`（`database/migrations/0001_core.sql:18` 的 CHECK）。写错 seed 直接失败。
- `config` 的键必须在白名单里（`packages/backend/src/sources/config-keys.ts`）。白名单外的键在保存、预览、seed 三处都会被**明确拒绝**，不会悄悄退回通用解析。`rss` 用 `feedUrl`，`web_list` 用 `url` + 选择器 + `publishedAtUtcOffset`，`json_list` 用 `url`/`itemsPath`/`titlePaths`/`urlTemplate`/`publishedAtPath`。
- `json_list` 的 `urlTemplate` **可以**写完整外部 URL：`packages/backend/src/sources/json-list.ts:29-40` 的 `renderTemplate()` 只对"被替换进模板的那个值"做 `encodeURIComponent`（并把 `%2F` 还原成 `/`），模板字面量原样输出；要原始值用 `{raw:路径}`。（本文早期草稿曾断言"只能写相对片段"，那是错的，已改正——以 `renderTemplate()` 的代码为准。）
- 盘点/文旅向的转载层登记成 **T2**，不要放 T1/T1_5。但要看清这一条到底兜住了什么：**门槛不是证明**（`docs/manual.md` 第 6 节已撤掉旧版"营销数学上不可能入选"的说法）——按字面算营销类噪声的天花板是 92–93 分，任何可用的门槛都关不住它。分级摆放只决定"这个源的信材用哪一档线去量"（T2 高、T1 低），**它挡不住 92–93 分的噪声**；真拦住这类材料的是 `industry/prompts/prefilter.md` 的 `BLOCK`。注意 stub 的预筛兜底是 PASS（`tooling/brain-stub.ts:615`），所以这一层目前只在有人写过 BLOCK 判断的材料上成立。

命令行立刻采一个源（不等调度）：

```bash
node --env-file=.env --env-file=.env.pipeline scripts/collect.ts json-usgs-quake-m45 rss-phys-org-earth
```

删源（`scripts/delete-sources.ts` 存在，参数是"理由 + 源 id"，id 用 `sources.id` 不是显示名）：

```bash
node --env-file=.env scripts/delete-sources.ts "源站已下线" <source-id> [<source-id>...]
```

它做的事（`scripts/delete-sources.ts:12-46`，全部在一个事务里删 `articles` + `sources`）：① 曾经进过精选的条目**先 `withdrawn`**（走 `admin/content` 的 `setVisibility`，会写审计与台账），所以 RSS/同步客户端能收到删除而不是"凭空消失"；② 把 `reports.content` 里指向被删条目的引用剪掉（日报里引用不到 id 的条目按"已发布"处理，不会留下破链）；③ 最后 `audit(actor="ops-script", "source.delete")`。控制台会打印删了几个源、几篇文章、撤回几条精选、改了几期日报。**这是不可逆操作**：删之前先跑 9.1 的整目录备份。不认识的 id 只会打印 `no such source`，不会报错退出。

### 2.2 采不到的（12379、民政部、自然资源部、地理学报、geodata、dili360、青藏科考、雪龙）

这一类已经登记为 `kind=external`，**当前全部 `participation_mode=isolated`，所以在站上不可见**——这是刻意的：没有人投递之前，一个空壳源不该出现在信源河上。要启用某一条：后台把它改成 `editorial`，然后开始投递。

投递接口 `POST /api/ingest/items`（没有 token 或值不对一律 401）：

```bash
# token 不用自己编：npm run env:init 已经写过一枚 48 位十六进制的 INGEST_TOKEN 进 .env
# （scripts/init-env.ts:72 的 randomBytes(24).toString("hex")），下面这条 curl 就是当场从 .env 读它。
curl -sS -X POST http://127.0.0.1:3001/api/ingest/items \
  -H "Authorization: Bearer $(node -e "console.log(require('fs').readFileSync('.env','utf8').match(/^INGEST_TOKEN=(.*)$/m)[1])")" \
  -H "Content-Type: application/json" \
  -d '{"sourceId":"ext-qtp-expedition","items":[{"title":"…","url":"https://…","publishedAt":"2026-09-30T09:00:00+08:00"}]}'
```

**别手工往 `.env` 里"加"一枚你现编的 token**（这一行以前就是这么写的）：`env:init` 写的那枚和你在别处发出去的那枚
一旦不同，接口就恒 401，而排查的人会先怀疑代码。要换值就换，但换完必须同一时间把新值同步给所有投递方，
并且只用一个来源读它（上面那种从 `.env` 现读，或者用 `--env-file` 让进程自己读）。

接口只送 `title/url/publishedAt/author/raw`，**正文靠回源抓取**；抓不到就只有标题。所以一手考察记录建议同时写进语料文件用 `npm run seed:curated` 带正文入库。批量与限速规则、48 小时陷阱、幂等语义都在 **`scripts/README-ingest.md`**。

### 2.3 重分级一个源（tier），它到底改了什么

在哪改：后台 `/admin/sources/<id>` 的"分级"（或直接 `PATCH /api/admin/sources/<id>`；可改字段的白名单是 `packages/backend/src/admin/sources.ts:86-100` 的 `EDITABLE`：`name`、`enabled`、`interval_minutes`、`tier`、`participation_mode`、`signal_group_id`、`first_party`、`owner_entity_id`、`site_fulltext`、`syndicate_fulltext`、`tags`、`config`）。合法值是 **`T1` / `T1_5` / `T2` / `EXCLUDE_MP`**（不是 `T1.5`）。改完会写 `audit`，冲突保护靠 `version`（`updated_at` 变了要刷新重改）。

保存以后**立刻**发生的事：`updateSource` 看到上面那六个"公开投影字段"之一真的变了，就往 `settings` 记一条 queued 并入队 `publication.republish-source`（`admin/sources.ts:119-125`）；worker 的 `republishSource`（`publication/publish.ts:339-357`）按 500 条一批把这个源的每条 `publications` 重新推导一遍，**不调模型、不花钱**。重推导会重算：是否还能进精选（`isSelectable`：`eligible && judgedSelected && tier !== "EXCLUDE_MP"`，`publication/rules.ts:38-39`）、`visibility`（`isolated` 一律 `withdrawn`）、全文/转载许可、`channel`。进度不在 `/admin/runs`（那里是定时任务），而是写在 `settings` 的 `republish.source:<id>` 一行里（`jobs/publication.ts:9-12`），`GET /api/admin/sources/<id>` 会把它随源信息一起返回（`admin/sources.ts:64-65`）；命令行看：`select value from settings where key = 'republish.source:<id>'`。中途停掉是安全的（重启后从头再推一遍）。

**它不会做的事，是这条操作里最容易误解的一点**：`analyses.selected` 是**分析当时**用当时的门槛算出来的布尔（`tierThreshold(source.tier)` 在 `editorial/analyze.ts:344` 读，判定在 `:380`），`republishSource` 只重放这个布尔，**不会拿新 tier 的门槛把 60 分的材料重判一次**。所以：

- 只是想让"已经判过的材料"按**新门槛**重新决定进不进精选 → 必须重跑分析：`node --env-file=.env --env-file=.env.pipeline scripts/enqueue-analysis.ts --all`（`--all` 会忽略"已经有 model 分析"的过滤）。**这条不会重新打 stub、也不产生账单**：回执按 `logical_key` 命中缓存（`providers/receipts.ts:71,110-116`），而 `logical_key` 里只有 service/purpose/model/提示词与输入的哈希 + `attemptTag`（**门槛和 tier 不在里面**），所以答案原样复用、判定按新 tier 重算，然后 `analyses` 插一行新的（`analyze.ts:437-452` 无条件 INSERT）。
- 想让**模型真的重新判断一次**（比如改了评分提示词）→ 单条用后台 `/admin/content/<id>` 的"重跑分析"（`admin/content.ts:158-176`，它会带上 `attemptTag: admin:<requestId>`，这才是新请求），批量就先删对应 `receipts` 行——但 9.2 里已经写过：`receipts` 是"重跑不重复花钱"的唯一凭据，删它等于让所有材料重新问一次，别顺手清库。
- `tier` 还影响**热度页**：事件页参与者列表按 tier 排"精选组/氛围组"（`events/hot.ts:148-151`、`hot-read.ts:33-34`），把某个转载层降成 `T2`、或把一手机构升成 `T1`，热度分值不变但事件页上谁露脸、谁排前面会变。
- `EXCLUDE_MP` = 完全不参与精选（只进"全部动态"），适合"想留档但不想它进精选"的源。

---

## 3. 看健康度

| 看什么 | 在哪看 | 底层 |
|---|---|---|
| 信源抓取失败、连续失败 | `/admin/sources`（列表按健康度排序） | 表 `sources`（`fail_count`）、`fetch_runs` |
| 定时任务最近一次的结果与耗时 | `/admin/runs` | 表 `job_runs` |
| 模型步骤的成功率、耗时、token | `/admin/models` | 表 `receipts`、`receipt_attempts` |
| 预算还剩多少、哪个服务被熔断 | `/admin/settings` → 预算 | 表 `budgets` |
| 队列里堆了多少材料没处理 | `/admin/content` | `articles.processing_state` |
| 每周信源体检报告 | `sourceHealthWeekly`（周一 09:00，只在配了飞书内部群时才发得出去） | `operations/reports.ts` |

一条命令看全局（只读）：

```bash
node --input-type=module -e "
import p from 'postgres';
const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});
console.log('sources enabled', JSON.stringify(await a.unsafe('select enabled, count(*)::int n from sources group by 1')));
console.log('processing', JSON.stringify(await a.unsafe('select processing_state, count(*)::int n from articles group by 1')));
console.log('failed fetches', JSON.stringify(await a.unsafe('select id, name, fail_count from sources where fail_count > 0 order by fail_count desc limit 10')));
console.log('receipts', JSON.stringify(await a.unsafe('select service, status, count(*)::int n from receipts group by 1,2')));
await a.end();"
```

### 3.1 特性门之后，后台到底还剩哪几页

侧栏是 `apps/web/app/routes/admin/layout.tsx:26-46` 写死的两张分组表，其中"Codex 重置"那一项被 `FEATURES.codexResetMonitor` 门掉了。本站（两个开关都 `false`）**看得见、点得动**的是这些：

| 路由 | 侧栏名 | 干什么 |
|---|---|---|
| `/admin` | （概览，从站名进） | 各计数与入口 |
| `/admin/content`、`/admin/content/<id>` | 内容诊断 | 队列状态、可见性、人工改归属、重跑 extract/analyze/group |
| `/admin/sources`、`/admin/sources/new`、`/admin/sources/<id>` | 信源 | 健康度排序、预览抓取、立即采集、改 tier/参与方式/频率/config |
| `/admin/feedback` | 反馈 | 逐条处理与拉黑 |
| `/admin/runs` | 运行 | `job_runs`：每个定时任务最近结果与耗时，含 republish 进度 |
| `/admin/models` | 模型与评测 | 每一步单独指定模型、成功率与 token（本站这一步是 stub，`/v1/models` 只回 `geohot-brain`） |
| `/admin/selectbench`、`/admin/selectbench/<runId>` | SelectBench | `scripts/eval-selection.ts` 每一版的对比与错例 |
| `/admin/settings` | 设置 | 预算熔断、安全项 |
| `/admin/audit` | 审计记录 | `audit` 表 |

还剩两个"关而没摘"的壳：**`/admin/monitor` 的路由与 `/api/admin/monitor/*` 七个端点仍然注册**（`apps/api/src/routes/admin.ts:99-105` 没跟着 `features.ts` 走），直接敲 URL 会渲染、接口会应答，只是底表已经被清空成 `monitor_*_bak_20260930`，所以看到的是空列表；`/leaderboard*` 与 `/codex-reset` 是真的 404（`apps/api/src/app.ts:67` 在 `FEATURES.leaderboard=false` 时根本不注册那条路由）。这两点已经写进 `docs/manual.md` 第 5、10 节，改代码的人请注意：要彻底关掉 `monitor`，得给它加同样的特性门。

---

## 4. 补内容（本站真正的"编辑工作"）

这个站今天的精选来自人工写的判断，不是模型。补内容的循环：

```bash
# 1) 先有材料。采集（第 2 节）或人工投递（2.2）都会把文章落进 articles
# 2) 在 tooling/fixtures/<能力>.jsonl 追加一行。不用重启：文件 mtime 变了就重载
# 3) 必跑：fixture 自检
npm run brain -- --lint            # 要求 fixturesWithProblems: 0
# 4) 让它被处理（worker 的 content.sweep 每 5 分钟也会自己捞；等不及就手工排队）
node --env-file=.env --env-file=.env.pipeline scripts/enqueue-analysis.ts
# 5) 看它到底答了什么
curl -s "http://127.0.0.1:3055/__brain/log?limit=50"
```

写 fixture 的四条会咬人的规矩（完整版在 `tooling/brain-README.md`）：

1. **打分请求里没有 URL、没有信源名**（`buildScoreInput` 只给时间 + 原始标题 + 正文），所以 `scores.jsonl` 只能用**原文标题或正文子串**做键。CENC 目录这类重名多的材料，用材料里唯一的 ID（如 `CD.20260929…`）而不是标题。
2. **摘要里的机构称谓必须和原文一致**。原文写 `USGS` 你写"美国地质调查局"，`enforceIdentity` 会把整段摘要丢掉，条目变 `relevance=unknown` 不发。给条目带上 `guard`（把你写稿依据的原文塞进去），`--lint` 会替你撞这条。
3. **标签必须逐字命中 `industry/taxonomy.ts` 的三个词表**，第一个必须是分类标签；不认识的会被 `normalizeTags` 静默丢弃。`subjects` 只认 `ENTITIES` 的 id。
4. **匹配是确定性的子串，第一行命中生效**（`includes`/`urlIncludes`/`titleIncludes`/`textIncludes`/`anyIncludes`/`notIncludes`，归组另有 `queryIncludes`/`candidateIncludes`）。只匹配 user 消息，绝不匹配 system。

撤掉一条判断：加 `"enabled": false`，**不要删**——历史精选要能解释。

想让打分自己变严或变松：改 `tooling/fixtures/scores.jsonl` 里的分数，或临时用 `BRAIN_SCORE_DEFAULT` 改默认值（`node tooling/brain-stub.ts` 读它，默认 20）。想换一批 fixture 目录做片段级检查：`BRAIN_FIXTURES_DIR=<目录> node tooling/brain-stub.ts --lint`。

### 4.1 补完 fixture 却"没反应"：receipts 缓存与强制重跑

**同一篇材料的同一个 revision 重跑分析，不会再打到 stub。** 回执的键是 `service:purpose:model:sha256(输入):attemptTag`（`providers/receipts.ts:71`），命中就直接把存好的答案还给你（`:110-116`），`enqueue-analysis.ts` 或 worker 再排多少次都一样。这不是 bug，它是"重跑不重复花钱"的机制（本部署不花钱，但账照样记）。三种"真的要重跑"的办法，按代价从小到大：

1. **让判定按新的 tier 重算，但答案复用**（改门槛/重分级以后就该跑这个，零新请求）：
   `node --env-file=.env --env-file=.env.pipeline scripts/enqueue-analysis.ts --all`
   它对每篇材料无条件 `INSERT` 一条新的 `analyses`（`editorial/analyze.ts:437-452`），`selected` 按**当前** tier 的门槛重算，而分数还是缓存里那两个。
2. **单条真新请求**：后台 `/admin/content/<id>` → "重跑分析"。它带 `attemptTag: admin:<requestId>`（`admin/content.ts:158-176`），新 tag = 新逻辑键 = **真打 stub**，同一个 requestId 重复提交不会付两次。
3. **改正文产生新 revision**：`revision` 是内容身份变了才 +1（`materials.ts` 的 identity），重新抽正文/改标题都会；这也走真请求。
4. 万不得已才删 `receipts` 行（`DELETE FROM receipts WHERE logical_key LIKE ...`）——它同时是审计与预算的依据，删了这批材料就全部重新问一遍；9.2 那条"不要手工删 receipts"仍然优先。

反过来，`__brain/log` 里看到 200 且 `reused` 为真 = 打的其实是缓存。**判断 fixture 到底生效了没有，看新那一行 `analyses` 的 `score`/`selected`，不是看日志**。

---

## 5. 重算归组（改了归组提示词、或者发现事件并错了）

`scripts/regroup-events.ts` 是四步，**每一步都可以重复执行**，都需要 worker 在跑（作业走 `events.group` 串行队列）：

```bash
node --env-file=.env --env-file=.env.pipeline scripts/regroup-events.ts plan \
  --since 2026-09-25T00:00:00+08:00 --snapshot .data/regroup.json

node --env-file=.env --env-file=.env.pipeline scripts/regroup-events.ts redirect --snapshot .data/regroup.json
node --env-file=.env --env-file=.env.pipeline scripts/regroup-events.ts finish   --snapshot .data/regroup.json

# 把"一份报道被 firmly 绑到多个事件"的那部分并掉（只判断不写就加 --dry-run）
node --env-file=.env --env-file=.env.pipeline scripts/regroup-events.ts consolidate --since 2026-09-25T00:00:00+08:00 --dry-run
```

- `plan`：**必须有 `--since`**。它先取消上一版还没跑的归组作业（正在跑的那条会先跑完），记下每份报道今天的归属，把窗口内的报道标成"等待中"（等待期间它不作为别人的证据，于是重算看到的是实时归组当时会看到的东西），然后每篇发一个归组作业。它挑的是"`participation_mode='editorial'` + 最新一条 `analyses.relevance='pass'` + `discovered_at >= since`"（`regroup-events.ts:62-69`）——`isolated`/`hot_signal` 的材料根本不在窗口里，被预筛 BLOCK 的也不在；它记下的人工归属（`fa.manual`）不进快照，所以重算不会覆盖你手工绑过的那部分。`--signals-hours`（默认 48）控制顺带重算的事件信号窗口，别把它当成"重算多少天的内容"——那是 `--since`。
- `redirect`：把丢了全部报道的事件重定向到多数报道去的那个事件（**旧事件页继续能用**，返回的是重定向而不是 404）。要在排空过程中反复跑。
- `finish`：等作业排空、重定向剩下的、请求新的综述、回填最热事件的逐小时热度、发布新的热点榜。
- 给 `redirect`/`finish` 传**自上次 `finish` 以来每一个 plan 的 snapshot**（多个 `--snapshot`）；不传时默认读 `regroup-snapshot.json`（`regroup-events.ts:38`），所以显式命名更安全。
- snapshot 写到 `.data/`（已被 `.gitignore` 排除）。
- `consolidate` 是把"活体归组里那套一份报道被 firm 绑到多个事件就合并"的规则，**补跑给某个时间之后已经做出的归组决定**；`--dry-run` 只打印会并什么、不写库（`regroup-events.ts:180-201`）。改了归组提示词之后 `plan → redirect → finish → consolidate --dry-run →（满意再去掉 --dry-run）`。

只想改单条归属：后台 `/admin/content/<id>`，人工改过的归属不会被重算覆盖。

---

## 6. 重跑打分（改门槛之前必须先做这个）

现值看 `industry/selection.ts:84,92`（Wave 4 重算后是 **56 / 59 / 62 + floor 46**，入选线之和 112 / 118 / 124），而它自己在 `:70-75` 就写着：这组数是**推出来的，不是校准出来的**。要变成校准过的：

1. **标样本。** 从自己的信源里挑 100–200 条，逐条标"该选 / 不该选 / 两可"，存 `.data/gold.jsonl`（一行一个 JSON，格式见 `docs/selection.md`；`industry/gold.example.jsonl` 里有 **12 条按真实信源形状编造的示意材料，不是人工标注**，只能用来验证命令通不通）。
2. **跑评测。** 需要 `MODEL_CALLS_ENABLED=true`，所以叠 `.env.pipeline`：

```bash
node --env-file=.env --env-file=.env.pipeline scripts/eval-selection.ts \
  --gold industry/gold.example.jsonl --label "门槛 56/59/62 的第一版"

# 你自己的标注集：
node --env-file=.env --env-file=.env.pipeline scripts/eval-selection.ts \
  --gold .data/gold.jsonl --split development --label "第一批标注"
```

   它做的是：对每条 gold 材料跑本站真实的精选步骤（预筛 + 两次评分，逐个 `--models`），按 gold 的分级取门槛判定，输出准确率/查准率/查全率、门槛扫描表、错例清单；报告写到 `.data/eval/`，并自动导入后台 SelectBench（不想导入加 `--no-import`）。**注意输入是 gold 文件本身，不是库里的行。**
3. **看错例改标准，先改 `prompts/selection-score.md`，再动 `selection.ts` 的数。** 门槛只能整体平移，解决不了"某一类判错"。
4. 改完 `npm run typecheck`、`node tooling/brain-stub.ts --lint`，并在 `industry/selection.ts` 的头注释里把新算式写清楚（那个文件现在就是这么写的，别把它清空）。

在后台 `/admin/selectbench` 里能看到每一版的对比。

---

## 7. 重出日报

日报期是按北京时间的天：`daily/<YYYY-MM-DD>` 覆盖 `[D-1 08:00, D 08:00)`。定时任务只补**缺**的那期（`compose.ts` 的 `catchUpReports` 里有 `if (!exists)`），已经存在但内容为空的期数**不会被自动重算**。

先看有哪些期：

```bash
node --input-type=module -e "
import p from 'postgres';
const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});
console.log(await a.unsafe('select kind, key, window_start, window_end, revision, generated_at from reports order by generated_at desc limit 12'));
await a.end();"
```

手工重出某一天（会 `revision + 1`，旧内容进 `report_revisions` 存档；`recentlyCovered` 会把**前 7 天已刊载过**的事实/条目去重掉，所以重跑同一期不一定补回旧条目）：

```bash
node --env-file=.env --env-file=.env.pipeline --input-type=module -e "
import { composeDaily } from '@aihot/backend/reports/compose';
import { closeDb } from '@aihot/backend/db';
console.log(await composeDaily('2026-09-30', 'manual'));   // 返回 { key, entries }
await closeDb();"
```

`entries: 0` 不是脚本坏了，是那一天窗口内**没有入选条目**。先回第 4 节补 fixture、或第 8 节确认那些材料没有被 48 小时闸门挡掉。周报/月报同理，入口是 `composeWeekly(isoWeekLabel)`、`composeMonthly('YYYY-MM')`。

改了 `industry/taxonomy.ts` 的 `section` 之后要重出：日报分节读的是它（`reports/compose.ts:20` 用 `SECTION_OF.industry` 找兜底分节，本站没有 `industry` 类别，所以未分类的资料落进**最后一节"实践"**——这就是 `taxonomy.ts:8-10` 说"最后一节必须留在数组末尾"的原因）。

---

## 8. 处理反馈

- 读者从 `/feedback` 提交（接口 `POST /api/site/feedback`，可带截图，`bodyLimit` 12 MB）。
- 本站 `FEISHU_INTERNAL_ENABLED=false`，所以**转发不会发出去**（`operations/feedback.ts:84-86` 直接 return），条目安静地留在库里等人工看。后台 `/admin/feedback` 逐条处理，可以拉黑（表 `feedback_bans`）。
- 反馈截图是**不备份**的（`operations/backup.ts:90` 的注释：隐私说明只保留飞书图片键）。
- 前台反馈页的示例文案已经换成地理（`routes/feedback.tsx:191`："我在搜索'黄河三角洲'时没找到想要的内容…"），要改措辞就改这一行。

---

## 9. 清理与备份

### 9.1 备份：这台机器上只有一条路

**embedded-postgres 的 bundle 里没有 `pg_dump.exe`，也没有 `psql.exe`**（`D:\geohot-embedded-postgres\windows-x64-17.10.0-beta.17\native\bin\` 实测只有 `initdb.exe`、`pg_ctl.exe`、`postgres.exe`）。所以：

- 应用自带的备份模块（`packages/backend/src/operations/backup.ts`）**在本机不可用**：它的 `runBackup()` 第 83 行调外部 `pg_dump`，而且只有配了 `DB_BACKUP_STORE_SECRET_ID/KEY/BUCKET/REGION` 才会注册 `ops.backup` 定时任务（`schedules.ts:74` + `backupConfigured()`）。
- 真正的备份 = **停库、整目录复制 `.pgdata`**（约 105 MB，机器可读的全部状态都在里面：文章、事件、精选台账、回执、日报）。

```bash
npm run db:down                                     # pg_ctl stop -m fast，必须干净停下
robocopy .pgdata  D:\geohot-backups\pgdata-$(date +%F)  /MIR         # Windows
# 上传目录与图片缓存（可能不存在，不存在就跳过）
robocopy .data    D:\geohot-backups\data-$(date +%F)  /MIR
npm run db:up -- --daemon                           # 回来
```

恢复 = 停库、把 `.pgdata` 换回去、`npm run db:up`。**换机器时要连带 `D:\geohot-embedded-postgres` 一起想清楚**：那个目录是二进制镜像，删了会被重建，但数据目录里存的是 initdb 时的 locale/编码，跨大版本直接换二进制可能起不来。

`.pgdata`、`.data`、`.env`、`node_modules` 都已在 `.gitignore` 里。仓库本身是唯一的版本记录，提交数不要抄文档（`git log --oneline | wc -l` 现场看；本文写下时是 2 个，本轮已是一串按波次推进的本地提交）。**每轮结束提交一次**，语料与 fixture 是文本文件，Git 就是你的第二层备份。

要一份"读者视角"的可读备份（不依赖数据库二进制），定期导出这四个出口就够：`/feed/all.xml`、`/api/v1/selected/snapshot`、`/openapi-v1.json`、`/llms.txt`。

### 9.2 清理

```bash
# 库里那些改名保留的备份表（12 张，确认不再需要再删）
node --input-type=module -e "
import p from 'postgres';
const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});
console.log(await a.unsafe(\"select table_name from information_schema.tables where table_schema='public' and table_name like '%_bak_20260930'\"));
await a.end();"
# 逐张 DROP TABLE <名字>;

# 回执与运行记录：ops.retention 每天 03:30 会按上游的保留策略清（schedules.ts:58），不要手工删 receipts，
# 它是"重跑不重复花钱/不重复调用"的唯一凭据，删了就等于让所有材料重新问一次 stub。
```

语料**已经在仓库里**（`tooling/corpus/`，2026-10-01 起）：`npm run seed:curated` 的默认输入是 `scripts/seed-curated.ts:41` 指向的 `tooling/corpus/curated-materials.jsonl`，行数以 `npm run seed:curated -- --dry-run --enforce-source` 打印的 `117 material line(s)` 为准（`wc -l` 因末尾空行会给 118）。早期版本在这里警告过"清理项目外的研究产物目录会打断重建演示数据"——那个坑已经随语料入库而消失，仓库外目录怎么删都不影响这条命令。

---

## 10. 故障排查表

| 症状 | 怎么确认 | 原因与处理 |
|---|---|---|
| 精选一条都没有；`__brain/log` 里打分全是 `rule:score-default` | `curl -s "http://127.0.0.1:3055/__brain/log?capability=scores&limit=20"` | 没人写过这条材料的分数 → 默认 `attentionScore=20`，两次之和 40，过不了任何门槛（最低档 T1 的入选线是"两次之和 ≥ 2×门槛"，现值看 `industry/selection.ts:84`，Wave 4 后是 112）。这是**设计**，不是故障。要它进精选就补 `tooling/fixtures/scores.jsonl`（第 4 节） |
| `/hot` 显示"还没有足够多来源共同讨论的事件"；事件页空 | `select backfill, backfill_reason, count(*) from articles group by 1,2` | 48 小时闸门：`isHistorical()` = `backfill` 且（没有来源时间 或 发现时已晚于 48 小时）（`content/materials.ts:62,91-93`）。历史材料**不成事件、不给热度**（`events/group.ts:625`）。注意 `backfill=true` 不等于历史：新源第一次导入但"今早才发布"的仍然是新闻。人工投喂用 `scripts/seed-curated.ts` 的默认时间重映射（或 `--as-of`），别用 `--keep-times` 灌几个月前的东西 |
| 改了 fixture、重跑分析，回答却没变 | `select status, count(*) from receipts group by 1` | 回执按 `logical_key` 命中缓存（`providers/receipts.ts:71,110-116`），同一 `revision` 不会再打到 stub。缓存的"身份"是 `{model, promptVersion, sha256(system), sha256(user), temperature, maxTokens}`（`providers/llm.ts:185`）——**改提示词、改正文、换模型都会换键（= 真新请求），而改门槛或改源的 tier 不会**。要强制重判按 4.1 那四条走（`scripts/regroup-events.ts`、`scripts/eval-selection.ts` 都不带 `attemptTag`，它们照样复用回执）。 |
| 中文搜索永远 0 结果；归组一个都不合并 | `node --input-type=module -e "import p from 'postgres';const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});console.log(await a.unsafe(\"select datcollate, datctype, datlocprovider, pg_encoding_to_char(encoding) enc from pg_database where datname=current_database()\"));console.log(await a.unsafe(\"select show_trgm('三角洲') tg, similarity('三角洲','河流三角洲') sim\"));await a.end()"` | 本机实测：`datlocprovider='i'`（ICU）、`enc=UTF8`、`similarity('三角洲','河流三角洲')=0.25`（**不是 0**）。一旦它是 0，说明集群是用 `lc_ctype=C` 建的，trigram 恒空、**静默**失效。`scripts/dev-db.ts:167` 的 `--locale-provider=icu --icu-locale=zh-CN --encoding=UTF8` 只在建集群时生效一次 → `npm run db:down`、删 `.pgdata`、`npm run db:up`，再 migrate + seed 重建。另外 `EMBEDDINGS_ENABLED=false` 时归组的候选召回退成词法相似（`events/group.ts:208-213`，阈值 0.25），召回本来就比向量窄 |
| `initdb` 或 `postgres` 崩：`FATAL: invalid byte sequence for encoding "UTF8": 0xb5` | `dir D:\geohot-embedded-postgres`；`dir node_modules\embedded-postgres\node_modules\@embedded-postgres` | 非 ASCII 二进制路径。`scripts/dev-db.ts:63-90` 把 win-x64 bundle 镜像到 ASCII 目录并用 junction 接回。**`npm ci` 会删掉那个 junction**（`dev-db.ts:14` 写明），下一次 `npm run db:up` 自动重建——所以顺序永远是 `npm ci` → `npm run db:up`，不要手动去动 junction。真找不到 ASCII 位置（比如项目在 `A:\` 之类）脚本会明确报错而不是硬试 |
| `npm run db:up` 说 `already listening`，但连接失败；或者端口没人听 | `netstat -ano \| grep 5433`；`type %TEMP%\geohot-dev-db.log`；`.pgdata/dev-db.pid` | 上一次进程被强杀，postgres 还在但 PID 文件是脏的 → `npm run db:down`（用 `pg_ctl stop -m fast`，只收 PID 文件指向、且确实是 node 的进程，`dev-db-down.ts:78-96`），再起。数据目录被占用/半截 initdb：`PG_VERSION` 是唯一的"集群存在"标记，缺了就重跑 initdb（会丢数据） |
| `json_list` 源的日期差 8 小时 | 对比某条 `articles.published_at` 与源站上显示的时间 | 无时区的日期字符串由 `Date.parse` 按**进程本地时区**解释（`sources/json-list.ts:52`），`epoch_ms/epoch_s/yyyymmdd` 不受影响。解决：用 `.env.pipeline` 启动（里面有 `TZ=Asia/Shanghai`），或在命令前显式加 `TZ=Asia/Shanghai`。`web_list` 有 `publishedAtUtcOffset` 配置可以补（`config-keys.ts:11-19`）。定时任务的 tz 参数已经是 `Asia/Shanghai`（`schedules.ts:103`） |
| 队列堆着不动，日志里有 `BudgetExceeded` / 任务显示等待 | 后台 `/admin/settings` 预算；`select service, count(*) from receipts group by 1` | 每个付费服务有每分钟/每小时/每天上限，超了就暂停（`providers/receipts.ts:98-102`，重试间隔分别 60/600/3600 秒）。填 0 表示立即停用该服务。本机模型是 stub、不花钱，但预算闸门照样生效：一次性灌太多材料时先调大预算或把 `ANALYZE_CONCURRENCY`（`.env`，现在 2）保持小值。`ReceiptBusyError` 是另一个原因——同一份回执正被别的进程占着，等它就行 |
| 某条内容后台能看到、站上找不到 | `select visibility from publications where article_id=…`; `select participation_mode from sources where id=…` | 三层闸门：① 信源是 `isolated` 就不进任何公开页面；② 非 `editorial` 信源的条目会被 `settleNonEditorial()`（`jobs/content.ts:86`）标成不分析、不进精选；③ `publications.visibility` 可能是 `summary-only` 或 `withdrawn`（`migrations/0001_core.sql:215`），预筛 `BLOCK` 的也永远不出现在任何公开页面。改法在后台 `/admin/sources/<id>`（参与方式）与 `/admin/content/<id>`（可见性） |
| 改了 `industry/prompts/*.md` 之后 stub 回 400 | `npm run brain -- --anchors`；`curl -s http://127.0.0.1:3055/healthz \| grep anchorProblems` | 能力识别靠提示词锚点行（不含 `{{}}` 且唯一属于某能力的整行）。锚点变了它**直接 400 拒绝回答，绝不猜**。stub 每 5 秒重读 prompts 与 taxonomy、按 mtime 重载 fixture，不用重启；但提示词被改坏（锚点撞车）就要改回措辞 |
| 精选卡片的摘要凭空没了、条目变成未发 | `__brain/log` 里看 `enforceIdentity`；`npm run brain -- --lint` 看该条 `problems` | 摘要里写了原文没有的机构名（`USGS` 写成"美国地质调查局"会撞上词表里的"地质调查局"=中国地质调查局），整段摘要丢弃。`summaryZh` 也建议 190 字、2–3 句内，否则被 `compactAnswerFirstSummary` 压缩（不报错，但你写的句子会没掉） |
| `npm test` 一跑就抛 `Invariant tests write rows` | 看报错里的库名 | `tests/setup.ts:10` 要求 `DATABASE_URL` 的库名以 `_test` 或 `_ci` 结尾。本机没有 `createdb`，用 `docs/manual.md` 第 8 节那条 `CREATE DATABASE` 语句建 `geohot_test` |
| `POST /api/ingest/items` 401 | `grep INGEST_TOKEN .env` | 本机 `.env` 里没有 `INGEST_TOKEN`（实测 401）。加一个 ≥16 位真值并重启 api；`changeme/placeholder/xxx/test/dev/your-token` 这类占位值会被 `apps/api/src/routes/ingest.ts` 直接拒绝（空值一律 401） |
| `/leaderboard`、`/codex-reset` 404 | `industry/features.ts` 两项都是 `false` | 不是故障：地理站关掉了这两个 AI 专属模块，导航入口、定时任务、接口和站点地图都跟着关（`schedules.ts:78-96`）。库里改名保留的 `lb_*`/`monitor_*` 备份表见 9.2 |
| 站点跑着但页面全是空状态 | `node scripts/smoke.ts --base http://localhost:3000` | `smoke.ts` 只验"能应答、类型对、带站名"，**不验有没有内容**。有没有货看第 3 节的健康度查询和 `/admin/runs` |

---

## 11. 这个站的三条底线（改任何东西之前）

1. **不要绕开裁决层。** 想改"什么算重要"，改 `industry/prompts/selection-score.md` 和 `industry/selection.ts`；不要改 `apps/`、`packages/` 里的评分/聚簇/成刊代码。想改"能不能进精选"，靠 `participation_mode`、`tier` 和 fixture，不要在读取层开后门。
2. **不要让 `.env` 的四个安全阀变 true。** 一次性验证用 `.env.pipeline`（`docs/manual.md` 第 3.5 节）。测试会继承 `.env`。
3. **不要把机器当作者。** stub 是 fixture；写进站上的每一条判断都得有人署名（fixture 的 `author` 字段）、能被 `__brain/log` 回溯。今天有多少精选，等于有多少人写过判断——这句话是整个项目的诚实之处。

---

## 12. 时间闸门与可见性（本站最贵的两个坑，写全在这里）

### 12.1 `STALE_ON_DISCOVERY_MS`：48 小时是从"事件时间"到"入库时间"的差

常量定义在 **`packages/backend/src/content/materials.ts:62`**（`48 * 3600 * 1000`），不在 `events/group.ts`——`group.ts:23` 只是 import 它。规则一共两步：

1. `decideTimeline()`（`materials.ts:74-84`）：入库时如果 `discoveredAt - publishedAt > 48h`，这条材料被打上 `backfill=true`、`backfill_reason='stale-on-discovery'`；来源时间超过未来 1 小时的直接不信（`FUTURE_TOLERANCE_MS`）。
2. `isHistorical()`（`materials.ts:91-93`）：`backfill` 且（**没有来源时间** 或 发现时已晚于 48 小时）⇒ 它是历史，不是新闻。

历史材料的后果是**结构性**的：不成事件、不给热度（`events/group.ts:624-625`），归组的候选 SQL 还有一条同样的时间闸门（`group.ts:782`：`NOT backfill OR discovered_at - published_at <= 48h`），热度、`/hot`、事件详情页一起空掉。**它照样会被分析、照样能进精选流**——所以"精选有货、热点榜空"就是这个组合的样子。

对运营的三条实际含义：

- **演示窗口是有保质期的。** 语料的 `discoveredAt` 钉在入库那一刻，48 小时之后它们全部变成历史材料。本机实测（2026-09-30）：272 条里 159 条已经被判历史。昨天跑通的 `/hot`，今天看不一定有货——这不是回归，是要重看就得重新入库（12.2）。
- **新源第一次导入不等于历史。** `backfill=true` 只是"补录"，今早发布的新闻昨天才接进来仍然是新闻；被挡的是"三个月前的东西今天才灌进来"。
- 查自己踩没踩：`select backfill, backfill_reason, count(*) from articles group by 1,2`；`select count(*) from articles where backfill and (published_at is null or discovered_at - published_at > make_interval(secs => 172800))`。

### 12.2 `scripts/seed-curated.ts` 会把整个语料库"重锚"到今天

正因为 12.1，这个脚本**默认不动正文、只动时间**（`seed-curated.ts:109-144`）：

- 判断要不要重锚：`anchor`（默认 = 现在，`--as-of <ISO>` 可指定）减掉最早一条的时间 > 48h，或语料自身跨度 > 45h（`STALE_MS - 3×LEAD_MS`），就重锚；只重锚后半段会把同一个事件的报道劈开，所以是**整库一次仿射映射**。
- 映射保持**顺序与相对间距**：最新一条落在 `anchor - 1h`（`LEAD_MS`，故意不贴着窗口边缘），其余按比例铺进 45h 的窗口里。
- `discoveredAt = 重锚后的事件时间 + 语料自带的发现间隔`（`gapOf()`：语料里 `publishedAt→discoveredAt` 的原始差，>48h 视为不可信），没有写就按身份键导出 3–26 分钟（`arrivalLagMs`，`parseInt(sha256(key)) % 23`）。**结果按构造永不 stale-on-discovery**，重跑一次完全相同。
- 原始时间不会丢：`raw._geohot` 里留着 `authoredPublishedAt/authoredDiscoveredAt/ingestedAsOf/input`。
- `--keep-times` 表示"照原文时间写"，脚本会打印有多少条因此落在实时窗口之外；`--dry-run` 输出里的 `historicalAfterIngest` 就是入库后会被判历史的条数（本机跑法：`npm run seed:curated -- --dry-run --enforce-source`）。
- **`--route http`（走 `POST /api/ingest/items`）做不到这件事**：webhook 只能送 `title/url/publishedAt/author/raw`，发现时间由服务端盖"现在"，所以 `--as-of` 配 `--route http` 会让回拨的材料全部变历史；脚本会在控制台打 `!!` 提醒（`seed-curated.ts:216-218`）。要重锚整批语料必须用默认的 `--route inproc`。
- 幂等：身份是规范化 URL（+ 标题），第二次跑不会新建文章、也不会重复排队分析。

### 12.3 `isolated` / `hot_signal` / `editorial`：三种参与方式是三道不同的门

| `participation_mode` | 会不会被分析 | 会不会公开 | 会不会当热度证据 | 会不会进归组窗口 |
|---|---|---|---|---|
| `editorial` | 会（正常队列） | 会（进精选与"全部动态"） | 会，而且是"至少 1 个编辑类参与者"里的那一类 | 会 |
| `hot_signal` | **不分析**（`jobs/content.ts:102-106` 走 `settleNonEditorial`） | 不单独展示 | 会（非历史才有票，`content.ts:93`） | 只作为信号 |
| `isolated` | 不分析 | **任何公开页面都没有**，连详情页都不给：`publish.ts:185` 直接把 `visibility` 写成 `withdrawn` | 不会 | 不会（`regroup-events.ts:62-69` 只选 editorial） |

所以"8 个 `external` 源在站上不可见"不是坏了，是 `isolated` 的定义（`docs/manual.md` 第 7 节第 1 条）。要它们出现：后台 `/admin/sources/<id>` 改 `editorial`（触发 2.3 的重推导）→ 材料带正文进站 → 分析 → 才有精选与事件。

改完之后还是"后台看得到、站上找不到"时，按顺序查三层：① 源的 `participation_mode`；② `publications.visibility`（`public` / `summary-only` / `withdrawn`，人工覆盖在 `/admin/content/<id>`）；③ 预筛 `BLOCK` 的材料永远不进任何公开出口（`analyze.ts:343` 在预筛这一步就返回了，后面根本不走）。这三层都在 `packages/backend/src/publication/` 这一个读取层里落地，没有旁路。
