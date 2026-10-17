# GEOHOT 运营手册

给站长本人和以后接手这个站的 AI 助手。仓库根的 `../README.md` 讲"这是什么"，`docs/manual.md` 讲"怎么跑起来"，这份讲**每天怎么把它往前推**。所有命令都是本机（Windows 11 + Git Bash + Node v24.19.0）实际存在、逐项核对过的；没跑过的我会标出来。

约定的启动方式（下文所有命令都假设这四样在跑）：

```bash
npm run db:up -- --daemon                                              # 127.0.0.1:5433
npm run brain                                                          # 127.0.0.1:3055
# 实际长驻的那套栈还叠了第三层 --env-file=.env.ports（AGENTS.md 第 18/28 条），api 因此在 3199 而不是下面这行写的 3001：
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
- `config` 的键必须在白名单里（`packages/backend/src/sources/config-keys.ts`）。白名单外的键在保存、预览、seed 三处都会被**明确拒绝**，不会悄悄退回通用解析。`rss` 用 `feedUrl`，`web_list` 用 `url` + 选择器 + `publishedAtUtcOffset`，`json_list` 用 `url`/`itemsPath`/`titlePaths`/`urlTemplate`/`publishedAtPath`。日期两个键都归 `sources/dates.ts` 解释：`publishedAtUtcOffset` 决定不带时区的时间串按哪个偏移读，`publishedAtDateOrder`（`dmy`/`mdy`）决定年写在最后的那种数字日期（`07.10.2026`）哪个数是日、哪个数是月——不声明就没有日期，不做猜测。
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

现值看 `industry/selection.ts`（2026-10-06 站长拍板重标定后是 **46 / 49 / 52 + floor 36**，入选线之和 92 / 98 / 104），而它自己在文件头就写着：这组数是**推出来的，不是校准出来的**（连上一版 56/59/62 也是）。要变成校准过的：

1. **标样本。** 从自己的信源里挑 100–200 条，逐条标"该选 / 不该选 / 两可"，存 `.data/gold.jsonl`（一行一个 JSON，格式见 `docs/selection.md`；`industry/gold.example.jsonl` 里有 **12 条按真实信源形状编造的示意材料，不是人工标注**，只能用来验证命令通不通）。
2. **跑评测。** 需要 `MODEL_CALLS_ENABLED=true`，所以叠 `.env.pipeline`：

```bash
node --env-file=.env --env-file=.env.pipeline scripts/eval-selection.ts \
  --gold industry/gold.example.jsonl --label "门槛 46/49/52 的第一版"

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

改了 `industry/taxonomy.ts` 的 `section` 之后要重出：日报分节读的是它（`reports/compose.ts:18-21` 用 `SECTION_ORDER` 取分节顺序、`DEFAULT_SECTION` 取兜底分节；本站分类只剩**两节**「学科」「技术」，兜底就是**最后一节「技术」**——这就是 `taxonomy.ts` 说"最后一节必须留在数组末尾"的原因。2026-10-03 删掉「野外与考察」「观点与解读」两个分类之前，兜底是当年最后一节「实践」，所以 10-02、10-03 两期冻结的历史成刊里还留着「实践」分节，那是快照、不重写）。

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

# 运行记录：ops.retention 每天 03:30 清 job_runs（成功 30 天 / 失败 90 天）、过期的 delivery_leases、
# stored_files 与图片/OG 缓存（operations/retention.ts）；**receipts 与 deliveries 不在清理之列**
# （保留窗口是站长未决事项，见 docs/known-issues.md 的保留期工单）。不要手工删 receipts，
# 它是"重跑不重复花钱/不重复调用"的唯一凭据，删了就等于让所有材料重新问一次模型。
```

语料**已经在仓库里**（`tooling/corpus/`，2026-10-01 起）：`npm run seed:curated` 的默认输入是 `scripts/seed-curated.ts:41` 指向的 `tooling/corpus/curated-materials.jsonl`，行数以 `npm run seed:curated -- --dry-run --enforce-source` 打印的 `117 material line(s)` 为准
（2026-10-04 复核：`wc -l tooling/corpus/curated-materials.jsonl` 现在也是 **117**——文件以 `}` + 换行结尾、
中间没有空行，早先写的"`wc -l` 因末尾空行会给 118"那档差一已经不成立）。早期版本在这里警告过"清理项目外的研究产物目录会打断重建演示数据"——那个坑已经随语料入库而消失，仓库外目录怎么删都不影响这条命令。

---

## 10. 故障排查表

| 症状 | 怎么确认 | 原因与处理 |
|---|---|---|
| 精选一条都没有；`__brain/log` 里打分全是 `rule:score-default` | `curl -s "http://127.0.0.1:3055/__brain/log?capability=scores&limit=20"` | 没人写过这条材料的分数 → 默认 `attentionScore=20`，两次之和 40，过不了任何门槛（最低档 T1 的入选线是"两次之和 ≥ 2×门槛"，现值看 `industry/selection.ts` 的 `SELECTION.thresholds`：站长 2026-10-06 拍板为 T1 46 / T1_5 49 / T2 52，即之和 92 / 98 / 104；Wave 4 那版的 112 已被它取代）。这是**设计**，不是故障。要它进精选就补 `tooling/fixtures/scores.jsonl`（第 4 节） |
| `/hot` 显示"还没有足够多来源共同讨论的事件"；事件页空 | `select backfill, backfill_reason, count(*) from articles group by 1,2` | 48 小时闸门：`isHistorical()` = `backfill` 且（没有来源时间 或 发现时已晚于 48 小时）（`content/materials.ts:62,91-93`）。历史材料**不成事件、不给热度**（`events/group.ts:625`）。注意 `backfill=true` 不等于历史：新源第一次导入但"今早才发布"的仍然是新闻。人工投喂用 `scripts/seed-curated.ts` 的默认时间重映射（或 `--as-of`），别用 `--keep-times` 灌几个月前的东西 |
| 改了 fixture、重跑分析，回答却没变 | `select status, count(*) from receipts group by 1` | 回执按 `logical_key` 命中缓存（`providers/receipts.ts:71,110-116`），同一 `revision` 不会再打到 stub。缓存的"身份"是 `{model, promptVersion, sha256(system), sha256(user), temperature, maxTokens}`（`providers/llm.ts:185`）——**改提示词、改正文、换模型都会换键（= 真新请求），而改门槛或改源的 tier 不会**。要强制重判按 4.1 那四条走（`scripts/regroup-events.ts`、`scripts/eval-selection.ts` 都不带 `attemptTag`，它们照样复用回执）。 |
| 中文搜索永远 0 结果；归组一个都不合并 | `node --input-type=module -e "import p from 'postgres';const a=p('postgres://geohot:geohot@127.0.0.1:5433/geohot',{max:1});console.log(await a.unsafe(\"select datcollate, datctype, datlocprovider, pg_encoding_to_char(encoding) enc from pg_database where datname=current_database()\"));console.log(await a.unsafe(\"select show_trgm('三角洲') tg, similarity('三角洲','河流三角洲') sim\"));await a.end()"` | 本机实测：`datlocprovider='i'`（ICU）、`enc=UTF8`、`similarity('三角洲','河流三角洲')=0.25`（**不是 0**）。一旦它是 0，说明集群是用 `lc_ctype=C` 建的，trigram 恒空、**静默**失效。`scripts/dev-db.ts:167` 的 `--locale-provider=icu --icu-locale=zh-CN --encoding=UTF8` 只在建集群时生效一次 → `npm run db:down`、删 `.pgdata`、`npm run db:up`，再 migrate + seed 重建。另外 `EMBEDDINGS_ENABLED=false` 时归组的候选召回退成词法相似（`events/group.ts:208-213`，阈值 0.25），召回本来就比向量窄 |
| `initdb` 或 `postgres` 崩：`FATAL: invalid byte sequence for encoding "UTF8": 0xb5` | `dir D:\geohot-embedded-postgres`；`dir node_modules\embedded-postgres\node_modules\@embedded-postgres` | 非 ASCII 二进制路径。`scripts/dev-db.ts:63-90` 把 win-x64 bundle 镜像到 ASCII 目录并用 junction 接回。**`npm ci` 会删掉那个 junction**（`dev-db.ts:14` 写明），下一次 `npm run db:up` 自动重建——所以顺序永远是 `npm ci` → `npm run db:up`，不要手动去动 junction。真找不到 ASCII 位置（比如项目在 `A:\` 之类）脚本会明确报错而不是硬试 |
| `npm run db:up` 说 `already listening`，但连接失败；或者端口没人听 | `netstat -ano \| grep 5433`；`type %TEMP%\geohot-dev-db.log`；`.pgdata/dev-db.pid` | 上一次进程被强杀，postgres 还在但 PID 文件是脏的 → `npm run db:down`（用 `pg_ctl stop -m fast`，只收 PID 文件指向、且确实是 node 的进程，`dev-db-down.ts:78-96`），再起。数据目录被占用/半截 initdb：`PG_VERSION` 是唯一的"集群存在"标记，缺了就重跑 initdb（会丢数据） |
| `json_list` 源的日期差 8 小时 | 对比某条 `articles.published_at` 与源站上显示的时间 | 无时区的日期字符串由 `Date.parse` 按**进程本地时区**解释（`sources/json-list.ts:52`），`epoch_ms/epoch_s/yyyymmdd` 不受影响。解决：用 `.env.pipeline` 启动（里面有 `TZ=Asia/Shanghai`），或在命令前显式加 `TZ=Asia/Shanghai`。`web_list` 有 `publishedAtUtcOffset` 配置可以补（`config-keys.ts:11-19`）。定时任务的 tz 参数已经是 `Asia/Shanghai`（`schedules.ts:103`） |
| 队列堆着不动，日志里有 `BudgetExceeded` / 任务显示等待 | 后台 `/admin/settings` 预算；`select service, count(*) from receipts group by 1` | 每个付费服务有每分钟/每小时/每天上限，超了就暂停（`providers/receipts.ts:98-102`，重试间隔分别 60/600/3600 秒）。填 0 表示立即停用该服务。本机模型是 stub、不花钱，但预算闸门照样生效：一次性灌太多材料时先调大预算或把 `ANALYZE_CONCURRENCY`（`.env`；`.env.example` 配的是 2，生产现值是 4，理由见第 14 节）保持小值。`ReceiptBusyError` 是另一个原因——同一份回执正被别的进程占着，等它就行 |
| 某条内容后台能看到、站上找不到 | `select visibility from publications where article_id=…`; `select participation_mode from sources where id=…` | 三层闸门：① 信源是 `isolated` 就不进任何公开页面；② 非 `editorial` 信源的条目会被 `settleNonEditorial()`（`jobs/content.ts:86`）标成不分析、不进精选；③ `publications.visibility`（`migrations/0001_core.sql:215`）**分两档**：`withdrawn` 哪里都没有；`summary-only` 不进列表、feed、sitemap（`items.ts:119/129` 要 `= 'public'`），但**条目页仍可打开、事件页的时间线与报道数仍列它、日报周报仍可引用它**（`rules.itemHasPage` 只排除 `withdrawn`）。预筛 `BLOCK` 的也永远不出现在任何公开页面。改法在后台 `/admin/sources/<id>`（参与方式）与 `/admin/content/<id>`（可见性） |
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

改完之后还是"后台看得到、站上找不到"时，按顺序查三层：① 源的 `participation_mode`；② `publications.visibility`（`public` / `summary-only` / `withdrawn`，人工覆盖在 `/admin/content/<id>`；`summary-only` 只是不上列表与 feed，条目页、事件时间线与报纸引用都还在，只有 `withdrawn` 才是全站消失）；③ 预筛 `BLOCK` 的材料永远不进任何公开出口（`analyze.ts:343` 在预筛这一步就返回了，后面根本不走）。这三层都在 `packages/backend/src/publication/` 这一个读取层里落地，没有旁路。

## 13. 档案回填：把覆盖从"最近几天"推到指定月份

站点只有几天覆盖，根因不是采集频率，而是信源本身——RSS/Atom 只给最近十几条，任何日期窗口之外的内容都不在它们的应答里。所以要往回捞得换一条**按出版日期检索**的路：先用登记库 Crossref，它按 ISSN + `from-pub-date`/`until-pub-date` 返回 DOI、标题、摘要、作者、出版日期，覆盖到位。两个日期参数必须拆开写——单一区间那种写法（`date-A,B`）实测 HTTP 400 `date-not-valid`（2026-10-09）。Crossref 装不下的那一族走另一条，见下面「两扇门」。

它给的是论文而不是新闻：正文就是出版方登记的那段摘要，链接指向 DOI 落地页，没有全文、没有图。它进哪个板块由判定自己说，这条路不设限制（档案材料不写 `defaultCategory`，也没有任何代码按 `backfill_reason` 限定板块）。

**两扇门，不是一扇**。Crossref 按 ISSN 走，而 `config.issn` 只发给 `rss` 源——包里唯一按 `web_list` 收的中文期刊《地理研究》因此整条在档案门外（这是第六十三轮之前的实情；第六十五轮起中文期刊目录源已有七家，《测绘学报》之外六家都开出了过刊门）。这不是"少了几条"：先前实测过的八条中文期刊候选里，6 个印在刊面上的 ISSN Crossref 根本没登记，登记着的两条里有一条属于另一本刊。所以这条路攒下的 1,927 条档案材料里**中文标题为零**，而站点其余部分是 55% 中文。

第二条门是期刊自己的过刊页（`sources/archive-site.ts`）。《地理研究》的 `/CN/archive_by_issues` 挂着 1982 年至今 331 期，每期一行 `<div class="gk_qi">`：锚点指向期次页，锚点旁边印着出版日期；一张期次页给 15–18 条文章链接。这两页的形状与采集器每天在读的目录页同一种（一个容器、容器里一个链接、旁边一个日期），所以这条路**不新增一份 HTML 解析**：把 `fetchWebList` 的 `url` 换成过刊索引，按 `archiveIssueItemSelector` + `archiveIssueDateRegex` 读出「期次 → 日期」，再用这条源本来就有的 `itemSelector` 与 `allowUrlPrefixes` 读期次页里的文章。只有允许前缀那一步换成过刊索引自己的源站，因为包里写的是 `/CN/10.`，那条名单会挡掉所有 `/CN/Y…` 期次链接。三个键都带 `archive` 前缀、只有这条路读，轮询看不见它们——写给付刊的日期规则不该顺手改掉当期目录的判读。

日期落在哪一天单独说，因为那是读者看得见的差别：`dates.ts` 把不带时间也不带时区的 2026-01-10 读成 UTC 零点（机器时间戳这样读是对的），而 UTC 零点＝北京 08:00＝**当日报纸的收稿时刻**，于是一期 1 月 10 日的刊会排进 1 月 11 日那一期。这条路把日期取成"刊方所说那一天的开始"（`beijingMidnight(beijingDate(…))`，与 `web-list.ts` 的 `headingDate` 为变更日志日期标题做的同一件事）。2026-10-10 在本机库里核对过：`timeline_at = 2026-01-09T16:00Z`，日报 2026-01-10 的窗口 [1-09 00:00Z, 1-10 00:00Z) 含它——1 月 10 日的刊进 1 月 10 日的报。

正文一律留 `body_status='pending'`：`jobs/content.ts` 的 `route()` 对 `web_list` 源本来就会先取正文，这条路不必自己抓第二遍正文，也就不必维护第二个抽取器。

```bash
# ① 认定 ISSN：只读，输出 JSON。必须在采集机上跑（本机 DNS 与它不一致，见 docs/manual.md 第 3 节）
sudo -u geohot bash -lc 'cd /opt/geohot/app && node --env-file=.env scripts/archive-issn.ts > /tmp/issn.json'
# ② 只把 status=match 的行并进 industry/sources.json 的 config.issn，再按 2.3 那条 pack→DB 同步
node --env-file=.env scripts/sync-source-config.ts --apply --database-url=…
# ③ 回填，一个（信源，月份）一片；默认 DRY-RUN，写库要 --apply 且显式给 --database-url
node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-03 --max-items=2000
node --env-file=.env scripts/backfill-archive.ts --from=2026-01 --to=2026-03 --apply --database-url="$DATABASE_URL" --max-items=2000
# 过刊这一路先单独量一个月，看它到底给出几条（--source 只筛信源，两扇门都筛）
node --env-file=.env scripts/backfill-archive.ts --source=web-dlyj-toc --from=2026-01 --to=2026-01
# ④ 出刊：把已经到手的日子排成日报/周报/月报。默认只出计划，写库同样要 --apply 且显式给库
node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01
node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01 --to=2026-03-31 --apply --database-url="$DATABASE_URL"
```

第④步存在的原因是 `catchUpReports()` 只兜最近 7 天 + 上个星期 + 上个月——那是活站需要的口径，而档案的意思是把 1 月排出来。
两个顺序要求都来自 `reports/compose.ts`，不是风格问题：
**必须按时间正序跑**（`recentlyCovered("daily", key)` 只往回看七天内的**旧期次**，倒着跑会让 1 月的报纸重印 3 月已经登过的同一件事）；
**要等那一天判完再出**（还压着未分析文章的时候出刊，排出来的期次会在几分钟后再变一次，读者看到的"当天报纸"就不是当天定稿的那张；
`--force` 可以先出，之后用 `scripts/recompose-report.ts` 重排，旧版进 `report_revisions`）。补刊不占期号序列：
`nextIssueNo` 见后面已有编号期次就返回 null，所以 1 月那几张是"没编号的一期"，不会把 10 月的第 N 期改成第 N-k 期。
`tests/archive-paper-rule.test.ts` 把这条链钉住：同一条档案文章要真的出现在它自己那天的日报、那一周的周报、那一月的月报里，
且已编号的期次号码不动。

第①步只认两处都对得上的 ISSN：信源自己 feed 的刊名（或包里的拉丁名）与 Crossref 期刊库里**同名**记录的 ISSN。名字像但不是同一个刊一律不写（`ambiguous` / `no-match` 都留在报告里由人判）。这不是过分谨慎——ISSN 认错会把 A 刊的文章挂在 B 刊名下，读者侧完全看不出来。

**续跑**：`archive_ingest`（迁移 0051）一行一个（信源，月份），游标存 Crossref 的深翻页 `next-cursor`，`seen`/`items` 区分"这个月真的没有"和"只取到一半"。Ctrl-C、重启、对方超时，代价是一片而不是整轮。身份键：Crossref 那扇门是 `doi:<doi>`，过刊那扇门是文章 URL 归一化出来的 `url:` 键——所以当期目录已经收过的那几篇不会第二次入库、也不会重判一遍，`note` 里的 `dup=` 就是它们。**过刊这一路的切片没有游标**（一期一次抓完），而且**当月那一片不判 done**：过刊索引在期刊挂出新一期之前不会多出那一行，把它钉成 done 等于永远关掉这个月。

**代价的实测口径（2026-10-09）**：

| 量 | 值 | 怎么来的 |
|---|---|---|
| 每篇文章的模型调用 | **5.3 次**（5,411 次 / 1,028 篇 = 5.26，四舍五入到 5.3） | 2026-10-10 数生产回执：近 24 小时管道五步 5,411 次 / 1,028 篇分析。结构上是预筛 1 + 评分 2 + 写作 1 + 结构 1 = 5，多出的 0.26 是理解失败回落再问一次的尾巴（全部用途合起来是 6.09） |
| 主端点 Agnes `.com` | 当日文字额度用尽后**每分钟 1 次** | 429 原文 "used up today's text quota … limited to 1 request every 1 minutes" |
| 国内端点 Agnes `.cn` | **稳态每分钟成功 5–13 次**，实测落定在每分钟 9 次 | 按分钟数它自己的回执（2026-10-10 01:22–01:33）：成功数高的那几分钟失败为 0；一旦发到 30–40 次/分钟，就有 27–34 次被打回 429。0053 试探 14 次/分钟：成功占比从 85% 掉到 57%，而**成功数没有变多**（6 分钟 46 次成功 = 7.7/分钟），于是按 0053 自己写的判据回收到 9 |
| 熔断行 | `llm` 8/420/6000；`agnes-cn` **9/540/12000** | 0050 起的是 40/2400/30000——那来自"8 路并发不 429"，证明的是**能并行**，不是每分钟能接 40 个；0052 降到 10/550，0054 按上面的试探落定 9/540 |

这一条要记住：**并发压测验不出稳态吞吐**。把 `per_minute` 抬到对方真能接的数量之上买不到吞吐，只买到重试——每个 429 都占一次预算、一段退避，并把文章往后推。

换算到回填：理论上限是熔断那一行的算术（9 次/分钟 = 540 次/小时、`per_day` 12,000，÷ 5.3 ≈ 102 篇/小时、2,260 篇/天）。
实测是两个**不同窗口**的数，不要相乘：一个 40 分钟的干净窗口（2026-10-10 02:05–02:45）外推是**每小时 61.5 篇**，
同一天的整 24 小时合计是 **1,089 篇**（≈ 每小时 45 篇——40 分钟那段正好是快的时段）。同一小时里
`prefilter_article` 155 次成功对 `score_article` 64 次——大多数算力花在"先筛掉"那一步，这正是设计如此），
而回执里失败（429）占到的份额要吃掉近一半额度。用实测数算：**约 1,000–1,500 篇/天**。

"2.3 万篇"是**估**的（按包内期刊数 × 每刊月发文量），不是查出来的。现在查过了（2026-10-10，`archive_ingest`
共 400 个信源×月份切片：152 片已完成、合出 199 条；248 片未完成、已出 803 条）。这些是当时读取到的页级结果，
未完成切片还会续读，新信源也会扩大范围，不能用其均值外推 Jan→今的全量或完工日期。
2026-10-11 13:20 的只读观察已是 done=658、pending=271，目标窗口内 archive 仍有 7,204 条 new；
因此原先据约 1,800 条估计推得的“一到两天”不成立。实际余量、有效成稿率、实时任务占用及模型额度必须分别核验，
不以理论请求上限承诺完成时间。旧调度还曾出现档案**分到 0**（2026-10-10 04:00 实测：`-1` 档压着 1,506 条、当天到 05:00 只被判定 3 条，
而实时档常驻几十条，严格更低的档在 pg-boss 的 `priority DESC, created_on` 前永远轮空）。要动这个数只有两条路：
抬 `agnes-cn` 的 `per_minute`（抬之前先按分钟数成功/失败，别拿并发压测当依据——0053/0054 已经踩过一次，
本轮量出来是 9 次/分钟时 8.2 次被接受，已经贴着膝盖，抬它多半只是多收 429），
或者给档案做一把真正按速率分配的份额门（下面那段记了上午那把为什么撤、以及要做对需要什么）。实时与档案共用
同一个 service 的额度，所以现值仍取保守一侧：不把线上实时更新挤死。

**报纸**：档案材料的 `timeline_at` 是它自己的出版日，所以它进**属于它那一天**的报纸；它的 `visible_after` 是入库当天，放开晚到那条分支就会让今晚的报纸塞满几年前的论文。`reports/compose.ts` 的 `candidates()` 因此把两种归属分开写死，两个方向都由 `tests/archive-paper-rule.test.ts` 上锁。整段区间的补刊由 `scripts/backfill-papers.ts` 出计划（默认不写库），它只做两件调度之外的事：按**日期正序**逐日 `composeDaily`，再补周报与月报。补历史期刊仍要**从旧到新**：`recentlyCovered("daily", key)` 只看**比它更早、且在 7 天之内**的期次用过的 fact key（`compose.ts:128-130`，是 7 天不是 7 期）。从旧到新重算，新的一期就会把刚重算过的旧期当"已报道过"而不去重；反过来先重算新的，旧期会重印新期已经发过的同一件事。周报与月报不走这条去重，顺序无所谓。`saveReport` 把旧版存进 `report_revisions`，所以重算有版本；补出的那一期 `issue_no` 为空（`nextIssueNo` 见到更大的 key 就返回 null）——按期页照常可读、有日期，只是**不显示"第 N 期"**（`features/report/format.ts:issueNumber` 取不到号码就不出这块），这与归档页对"那天根本没有可读的一期"给的「未出刊」标注是两件事，别混为一谈。

**队列顺序**（第六十二轮改过一次，改前这里写的是"档案排在队尾、只能等前面首导积压跑完"）：
`PRIORITY = { live: 0, liveSignal: -1, archive: -1, history: -2 }`。**实时仍然第一**，这一点没动也没有商量余地——
今天的报纸不能为一堆旧论文让路。动的是历史的**内部**顺序：`backfill_reason='archive'`（Crossref 记录）不再和
`stale-on-discovery`（发现时已晚于 48 小时的新闻）挤同一条队。理由是两件事的性质相反——
三月的论文十月判仍然是三月的论文，而且站长这一轮要的就是 1 月以来的报纸；迟到新闻则每天在贬值，实测
判过的迟到条目 0.8% 入选、普通条目 1.9%（2026-10-10，`analyses`×`publications`）。让不衰减的材料排在会衰减的
材料前面，读者侧唯一少等的是迟到新闻，而那本来是最不值钱的一档。`tests/signals.test.ts` 钉住两个数：
档案 -1、迟到 -2、实时 0。
已经压在 -2 的那批不会自己挪上来（新规则只管新单子），`scripts/rebalance-archive-queue.ts` 就是搬它的：
默认只报告有多少条，`--apply` 才改 `"pgboss"."job".priority`，改回 -2 即可撤销。

**第六十三轮量到的一条：最新到的档案材料是"双重排最后"**。`sweepUnprocessed()` 每轮补排的是
`processing_state='new'` 按 `discovered_at ASC LIMIT 500`（旧件优先，别让任何一条永久饿死），
而 pg-boss 在同一档内按 `created_on` 先旧后新发卡——两条规则各自都对，叠起来的效果是：
今天补进来的 149 条中文刊文排在约 2,200 条 Crossref 档案**后面，两次**。而这批 Crossref 档案是英文、
零中文标题（1,927 条里实测中文 0 条），每条要先花约 5 次调用判过门槛才谈得上"有没有中文稿可发"，
中文那批则已经有 721—920 字的中文正文。**所以门口那点带宽，先花在了离成刊更远的那一批上**。
要不要反过来排（抬中文这批、或让补排按"能否进报"排序）＝分配政策＝站长的决定，见工单 #116；
本轮只把账写在这里，没有动队列，也没有动 `--promote`（脚本第 16 行写着"只有站长可以动"）。

**这两把门第六十二轮都做出来过、又都撤了（`95ca304`），账留在这里免得再当新点子做一遍。**

先说成立的那半个观察：`-1` 档不是慢，是零——2026-10-10 02:00 前后测得 -1 档压着 1,790 条、45 分钟被服务 0 条，
同一时段实时档从 145 涨到 156（到达速率≈门口消耗速率，所以严格更低的档不是"排队"，是"永远排不到"）。
到 04:20 再看是 1,506 条、当天判定 3 条——同一个结论的两个时刻，别当成两个数在打架。

于是做了**份额门**（把至多 N 条档案抬进 `priority 0`，每 15 分钟补一次）。撤的理由是它的排序语义与文档相反：
被抬进去的作业带着它**原来的** `created_on`，而 pg-boss 取活是 `priority DESC, created_on`
（`node_modules/pg-boss/dist/plans.js:1803`），所以它排在所有比它新的实时条目**前面**——不是夹在中间，是插队。
按实测门口 61.5–96 篇/小时换算：N=12 每 15 分钟补满一轮 ≈ 65 次请求 ≈ 7 分钟，等于把当天约一半产能交给档案；
而唯一那道"实时积压就让开"的闸门取 `share×20`——N=12 要等实时从 156 涨到 241 才触发（按实测净涨 +15/小时，约 5.5 小时），
N=1–3 时上限只有 20–60，比实时常驻量还小，功能永远不动。**上限跟着份额一起涨，买得越多越难让开**，这是设计错误不是参数问题。
另附两条实现层缺陷：算带宽时只看 `state='created'`（`active`/`retry` 态的看不见，实际带宽是 N+2），
默认值 0 会被 `positiveInt` 判成非法值、每 15 分钟打一条 warn。要做对得换成**按速率分配**
（每小时放行固定篇数，让开条件看实时积压的绝对值），那是站长的额度决定，先记账。

也做了**quota 关门**（60 分钟内 ≥3 次 `error ILIKE '%quota%'` 就停止向该 service 发）。空转是真的：
10-09 这类请求 2,386 次＝当天全部请求的三分之一，10-10 到 05:00 又积 327 次。撤的理由在对端原话里：
`You have used up today's text quota and are now limited to 1 request every 1 minutes`（`code: rate_limit_exceeded`）
——**它是降速，不是拒绝**。实测 10-09 20:00–23:00 三个小时：1,382 发 / 403 接受 / 965 拒。关门等于为了少发 965 次
扔掉 403 次真产出，而真产出正是回填缺的东西。再加两条要命的：线上门型池只有一个成员
（`.env` `MODEL_POOL=agnes-3.0-flash-cn`，`editorial/models.ts` 的 `pickMember` 按分片选完就没有第二次机会），
关门不是"换条门"是全站停摆。**这条前提已经在 2026-10-14 21:14 变了**：那天按站长要求摘掉 10 扇死门与限速门之后，
三条变量行（`MODEL_POOL`/`UNDERSTAND_MODEL`/`TRANSLATE_MODEL`）填的是同一组 **7 个成员**
（`agnes-3.0-flash-cn, default, dots3-note-prev, workbuddy-hy3, workbuddy-step5-preview, workbuddy-cn-hy3, workbuddy-cn-step5-preview`），
所以"关门＝全站停摆"不再成立，摘掉一扇只是少一路复核（逐门依据与验证见 `docs/research/model-pool-slim-2026-10-14.md`）。
而上面那条 60 分钟比任何队列的重试预算都长——`events.group` 是
`retryLimit 4 / retryDelay 20 + backoff`（`jobs/queue.ts:34`），一小时里早就烧完了，条目会被单独成页并留在
**只有操作者脚本才清**的 `regroup_pending`，一个事件出两个页面；而且门关着的时候一次尝试都没有，
拒绝告警（要每小时 ≥3 次尝试）也就自己哑了。附带还查出 `admin/runs.ts` 的 `release()` 会把**操作者的自由文本**
写进 `receipt_attempts.error`，所以一句"quota 零点重置"就能凭空造出一张牌。

**真要省那 965 次空转，方向是按对端声明的节奏发**（把该 service 的 `per_minute` 降到它说的 1，接受率从 29% 回到接近 100%），
而不是关门——但那要先量清楚"少发的到底是空转还是产出"。眼下现值回到两把门之前：`per_minute` 触顶是唯一的速率保护，
quota 型与速率型的 429 走同一条重试阶梯；给档案一次性开闸仍然只有 `rebalance-archive-queue.ts --promote=N`，
它只搬一次、不续杯。

**2026-10-10 08:00 北京再量一次（三个回填进程仍在跑：2—5 月、6—10 月、中文刊各一路）**：
档案材料 **2,076 条**（`body_status='ok'` 2,076 条，全部落在 2026-01-01 之后），其中
`processing_state='new'` **2,064 条**——判定只走完了 12 条，这 12 条进了公开池、**入选 0 条**。
02:00–08:00 这六小时档案侧新增判定 13 次（按小时只有 02/04/05/06/07 五个桶有数，各 1/6/3/1/2 次），档位积压 `0` 档 29／`-1` 档 108／`-2` 档 2,272。
报纸侧现有 `daily` 15 期（2026-09-25…10-09）、`weekly` 2 期（W39—W40）、`monthly` 1 期（2026-09）。
**采集比判定快两个数量级**，这句是本轮之后所有"为什么还不出 1 月的报纸"的答案，不用重查。

**回滚**：档案材料一律带 `backfill_reason = 'archive'` 且 `article_discoveries.via = 'import'`，一条 SQL 能整批摘掉，同时清 `archive_ingest`；
期次那一层要退回 `report_revisions` 的上一版，**注意这一步没有现成脚本**（全仓 `grep` 没有任何把 `report_revisions.content` 写回 `reports` 的
INSERT/UPDATE，`scripts/recompose-report.ts:72` 那句"可回滚"是文案，113 轮已把它改成明说"回退要手写 SQL"），
手工回退的动作是 `UPDATE reports SET content=(那一版的 content), revision=revision+1 WHERE kind=$1 AND key=$2`，先把当前版也补一行归档再改。
删之前先 `pg_dump`，与 `deploy/geohot/rollback.sh` 的约定一致。


**第六十五轮的档案面（2026-10-10 11:20–11:30 北京，生产实测）**：中文过刊这扇门从一家变成七家
（新增《地理学报》《资源科学》《地球信息科学学报》《自然资源学报》《热带地理》《人文地理》，
逐条在采集机实测后才写进包）。当天六个进程各跑 2026-01→2026-10、`--per-month=12`，入库
**+504 条**（dqxxkx 108｜jnr 108｜resci 108｜geog 96（另有 12 条与实时重复）｜rddl 84），
档案材料总数 2,076 → **2,580**。**玛捷斯那批站会自己发 5xx**：《地理学报》索引在同一天里先 500 后 200
（同一台采集机、同一个爬虫 UA、204 KB 同样正文），所以 `sources/archive-site.ts` 对 5xx **补读一次**，
解析失败与 URL 被拒不重试；一直坏仍按"这一片没跑完"如实上报，该月切片留在 pending。
《测绘学报》只接实时目录：它的过刊索引锚链是 `../volumn/...`，从 `/CN/archive_by_issues` 解析出来是
`/volumn/...`（站上回 3.2 KB 空壳），页面无 `<base>`，配置层面无解。

**一条关于"验收工具自己"的教训（本轮差点误判）**：手工 `curl -s https://xxc2007.me/ | sha256sum`
**前后两次就不一样**（相差 0 字节，差在 Cloudflare 邮箱保护那串随机 token），这不是"动了隔壁站"。
`verify-deploy.sh` 早在本轮之前就把 `/cdn-cgi/l/email-protection#<token>` 归一化后才取哈希，
所以它的"邻居站未受影响"仍然可信。**比对邻居站请只用 `verify-deploy.sh`，不要用手搓哈希。**
本轮该检查 ALL CHECKS PASSED（含各出口 6 期一致、七个出口 reader copy 全中文）。

**第六十六轮把档案带推快了三倍，且"过不了门槛"那句已收回**（详见 `docs/known-issues.md` 第六十六轮的两次补记）：
- 档案材料**能过门槛**：已判 31 条里 3 条过 T1_5 的 49 分线并被选中（50/53/56，都是数据集与研究目录类），
  通过率约 10%。所以"1 月至今的报纸"不缺规则、缺的是判定量。
- 判定吞吐：档案带一小时从 ~10 条抬到 **~30 条**（10 分钟 5 条）。三件事一起起作用——
  四道模型门（dots / Agnes 国际 / OpenRouter 免费档 / OpenCode）、池子跳过正在整体失败的门、
  以及 `ANALYZE_CONCURRENCY` **3 → 6**（操作旋钮，不是分配政策；每条约 40–56 秒、五个串行调用，
  并发就是这条带的油门）。
  **【2026-10-17 更正这两句】**：一条链不是 40–56 秒而是 **70–100 秒**（预筛 8.9 s + 两次打分各 23.7 s 串行，结构并行），
  而且"6 并发"当天可用是因为那时实时带还没排起来；同日实测 6 槽会把读者面顶到守护的地板之外（见第 14 节），
  **现在 `.env` 里这一行的现值是守护降回来的 4**，别把上面这句当成可用配置。
- 排队面：`-1` 档常驻一千三百多条等待，按当前速率约 40 多小时排空，之后是 2,895 条 `new` 还没判。
- **出刊是自动的、但有闸门**：某一天的档案材料没判完时，`backfill-papers.ts` 会说"等 N 条判完"而不出刊
  （防的是同一天被印两遍）。所以历史报纸会在日子陆续"settle"之后成批出现——那时跑一次
  `node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01 --apply --database-url=…` 即可（默认干跑）。
- **验收过的读者面**：2026-01-05 的两条、01-06 的一条档案材料已在线上可见——
  `/items/jhqc7apwkjn63zrnxafuscjxh`（《中国2010–2020年 1 km日尺度多层土壤温度空间自适应估算》）200，
  站内搜索 `/all?q=土壤温度` 也能搜到。

**第六十八轮补充：油门位置不变，但先修了一个把整台机器拖垮的坑**（2026-10-10 下午实测）：
- **load 47 的事故**：档案回填的 fetch 循环跑出了**两代**（14 个 `backfill-archive` 进程），swap 1908/2047
  打满，全机 thrash，pg-boss 对每个队列群发 `timeout exceeded when trying to connect`。修法是每刊只留一进程
  （杀掉 8 个重复的），load → 24 继续回落、swap → 1230。**跑多条回填循环之前先 `ps` 数一遍同名进程**。
- **判定速率**：修完 load 后（`ANALYZE_CONCURRENCY=9`）实测 **106 条/小时**；再把并发提到 **15**，
  首个 5 分钟窗口 **~132 条/小时**（分析行 created_at 计数）。这条带的油门仍是并发——CPU 与内存都有富余，
  卡的是模型调用的往返。
- **死门仍在偷走槽位**：12 分钟里的 257 次尝试有 41 次落在两道死门上（OpenRouter 免费档 32 次全 429、
  Agnes 国内版 12 次里 9 次失败）。前者是**日额度**（`free-models-per-day`），池子的 60 秒 bench 对"日额度"
  这种失败太短——记在这里，改不改是下一轮的事（这轮实测总浪费 ~16%，不构成事故）。
- **当前排队面（同日 15:30）**：`content.analyze` 里 4,466 条排队 + 全库 6,740 条 `processing_state='new'`；
  档案材料共收 **2,944 条**、已判 156、已入选 10。按 130 条/小时直算排空约 34 小时——**历史报纸仍然只在
  排空之后成批出现**，到时跑一次上面那条 `backfill-papers.ts`（`catchUpReports` 的自动窗口只有 7 天，
  1–9 月要靠这条命令）。

### 读者面厚度尺：别等"排空"，按天量、按天出（第一百一十三轮，2026-10-17）

上面那句"**历史报纸仍然只在排空之后成批出现**"是 10-11 前后的口径，**今天被推到了一侧**：出刊腿的闸门是
**那一天判完没有**，不是整带排空没有 ⇒ **判完一天就能出一天**（`--refresh` 的门槛也是这个，见第 14 节试点）。
量这件事不要自己写 SQL 猜形状，直接用读者端那两份：

- **日报逐日件数**：`/geohot/api/site/reports/daily?limit=400` ⇒ 信封 `items[]`，每条 `{key, title, generatedAt, count, no}`。
  `count` 就是存档页那行"N 件大事"（**不含快讯**；`backfill-papers` 摘要里的 `entries` 是 `sections + flashes`，两个数会差几件）。
  2026-10-17 15:09 读数：一月逐日 `02=1 03=8 04=8 05=8 06=8 07=10 08=8 09=4 10=8 11=1 12=1 13=7 14=6 15=8 16=3 17=6 18=1 19=2 20=5 21=3 22=8 23=3 24=5 25=4 27=3 28=7 29=8 30=8 31=10`（一月 31 天出刊 29 期）。
- **薄天怎么数才有意义**：按 `count ≤ 2` 算，284 期里 **44 期**（1—10 月分别 5/3/5/5/4/7/3/5/6/1）。各月中位数 5—8 件。
  这尺子和第 92/137/173 号说的"薄天"是同一件事，但它是**读者真看到的数**，不是 `publications` 行数。
- **缺某天的期次先别当事故**：`compose.ts:91` 要 `p.selected` ⇒ 那天**一条精选都没有**就是按设计不出刊。
  今天 `2026-01-26` 就是这样（窗口内 27 行、`selected AND public = 0`、还有 20 行没判完）；`2026-01-01` 归第 159 号。
  分辨方法：`SELECT count(*) FILTER (WHERE p.selected AND p.visibility='public') FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.timeline_at >= (D-1) UTC AND < D UTC`。
- **周报月报别按日报形状数**：它们的顶层键是 `overview / storyOrder / themes / headline`，**没有 `sections`**；
  按 `sections` 数会得出"41 期周报 9 期月报全是 0 条"这种假结论（我今天踩过，记在第 14 节的量表里）。


## 14. 临时提速窗口：把判定槽从实时带转给回填带（第一百一十三轮，2026-10-17 实测）

先记两句被实测推翻的旧话：
① 上面第 13 节末尾"并发提到 15、CPU 与内存都有富余"（2026-10-10）**在这台机器上不成立**；
② 同节"五个串行调用、每条约 40–56 秒"也低了——今天按台账重算，一条链实际占槽约 70–100 秒。

**判定的唯一真尺是 `analyses` 台账**（`0001_core.sql:173`：一次判定一行、带 `article_id`/`input_revision`/`created_at`，写完不改）。
今天在这把尺上的三段对照（同一台 891 MB / 2 vCPU、同一个 15 分钟一轮的档案周期）：

| 段 | 配置 | `analyses` 行/时 | 档案带分到 |
|---|---|---|---|
| A 09:00–10:12 | 实时开、4 槽 | **168** | ≈1 条/72 分钟 |
| B 10:13–10:35 | 实时停、**6 槽** | **257** | 0 |
| C 10:37–11:05 | 实时停、4 槽 | **151** | 0（实时带还剩几十条） |

**所以提速只来自槽位，不来自暂停**：暂停实时不会让总量变大（C 段 151 ≈ A 段 168），它改变的是**这些槽给谁**。
总量 ≈ 槽数 × 每小时 36–42 篇（单条链 70–100 秒：预筛 8.9 s、两次打分各 23.7 s **且故意串行**——
`editorial/analyze.ts:252` 写明第二次要吃供应商的 prompt 缓存，改并行就是多花一倍钱换同一个答案；结构与打分并行，`analyze.ts:403-404`）。

**额度不是瓶颈，别再往那儿找**：五扇门的小时熔断窗合计 5,160 次/时，改动期间实测各门折算
workbuddy 445、workbuddy-cn 341、dots 218、agnes-cn 198、llm 120——全部在自己的窗内，`budget` 退回 0 条。
每篇约 8,500 个补全 token，门的生成速度按中位数量出 **70–86 token/秒** ⇒ 一条链几乎全在"等模型写字"。
**在 4 槽不动的前提下，剩下的乘数只有思考输出量（`providers/llm.ts` 的 `headroomFor` 表，站长的判断质量旋钮）**：
砍一半思考输出近似翻倍吞吐，代价是回填条目的打分与结构想得少一半。这张表不由我改。

**为什么回填真的需要暂停实时**：队列优先级按设计就是"今天的新闻先于历史"（`jobs/content.ts:76`
`live 0 > archive −1 > history −2`），实时带的 140–255 条/时把 4 个槽整条吃掉，
档案带只在实时带瞬时排空的缝里被服务（今天 06 点那一小时实时弱，档案就一口气拿到 58 篇——机制本身是通的）。
**产出率与优先级正好相反**（判完 → 进 `publications.selected`，同日同库实测）：
档案 20.2%（15,538 → 3,137）、首导 10.6%、迟到新闻 9.2%、实时 6.9%、无日期 1.6%。

做法（三步，都可逆；改前一定先备 `.env`）：

```bash
cd /opt/geohot/app && sudo cp -a .env /opt/geohot/backups/rNNN-pre-$(date -u +%Y%m%dT%H%M%SZ)
# 只改已存在的行：这个文件的最后一行可能没有换行符，追加会把新键粘进上一行的值里
sudo sed -i -e 's/^COLLECT_ENABLED=.*/COLLECT_ENABLED=false/' .env
sudo systemctl restart geohot-worker        # 阀门只影响 worker 的 schedules 与抽取消费者
sudo systemctl list-timers --all            # 档案 timer 与 api/web/brain 不受影响
```

复位交给一个**跑一次就自删**的定时器：`/opt/geohot/bin/<轮次>-restore-realtime.sh`
+ `geohot-<轮次>-restore.service/.timer`（`OnCalendar=*-*-* HH:MM:00 Asia/Shanghai`、`Persistent=true`、
脚本末尾 `disable --now` 自己的 timer 并落一个 `.done` 防重跑）。
**复位脚本要复位的东西见下面第 4 条，不止阀门一个。**

验证脚本（`<轮次>-restore-verify.sh`）跑在**另一个武装好的具名 timer** 上（本轮 17:42，`Persistent=true`），
它把 `/etc/geohot/r113-restore.done` 的 mtime 当恢复时刻、把改阀门那份 `.env` 备份的 mtime 当缺口起点，
所以站长提前手动复位也不会读错窗。
**为什么不用 `systemd-run --on-active` 排队**：不是它不能用——12:42 用 `/bin/touch` 等 95 秒复验，它确实开火了
（12:38 我只等 20 秒就判它"不 fire"，那是**我那把量具太急**，临时 timer 受 `AccuracySec` 默认 1 分钟取整影响）；
是具名 `OnCalendar` 的事后可审计性更好：`systemctl list-timers` 直接看得到"排没排上"，临时单元跑完就消失。
脚本的三把尺在 12:17 重做过，下一轮直接照这套判：
- **缺口补回来多少只能按 `published_at` 数，不能按 `timeline_at`**：实时条目的 `timeline_at` 恒等于
  `discovered_at`（`content/materials.ts:85` 的 `backfill && publishedAt ? publishedAt : discoveredAt`），
  旧判据「`timeline_at` 落在缺口内 + `discovered_at` 晚于恢复」是**不可满足式**，永远数出 0（同一份样本上
  实测：新尺 95 条、旧尺 0 条，而 15,358/15,358 条实时条目 `timeline_at = discovered_at`）。
- **常态对照**：昨天同期（20:00 恢复锚点、缺口 10:00–20:00）用新尺是 `rediscovered 2,050 / gap_recovered 95 / gap_judged 94 /
  editions 16`。今晚 17:30 之后 `gap_items_recovered` **应当明显高于 95**（七个多小时攒在 feed 里等重抓），
  只要它贴近 0 就说明重抓没接上，别把"阀门=true"当成"缺口补回来了"。
- **空读数 ≠ 零**：`psql` 的 stderr 现在一起进日志，查询一死会留下"读数为空"那一行，而不是伪装成一组 0。
- **复位那一分钟是守护最容易误伤的时刻**：worker 重启 + 666 个到期源挤在十几分钟内重抓 + 归档周期当轮补跑，
  三件事叠在一起；`geohot-conc-guard` 若此时判"读者面退化"，它会**再重启一次 worker**（把在飞条目钉住最多 30 分钟）
  并写 `conc-guard.tripped` 把自己**解除武装**，而它其实降无可降（4/3 就是地板）。所以 verify 会把
  `GUARD_TRIPPED=` 一起落账：读到 `yes` 就等于"保护已经不在了"，重新武装（`rm` 标记 + `start` 它的 timer）
  是站长的闸门、是一次有意的动作，脚本**不替人做**。

**七条必须知道的副作用**：

1. `COLLECT_ENABLED=false` 会连带**关掉正文抽取的消费者**：`registerExtractionJobs` 只在
   `jobs/sources.ts:30` 注册，而 `apps/worker/src/main.ts:23` 那一行在 `if (isCollectEnabled())` 后面，
   没有第二个注册点。于是 `body_status='pending'` 且需要抓页面的条目会先按标题/摘要判（与抽取最终失败同一口径）。
   ~~**这条保护不是全覆盖**：`jobs/content.ts:131` 会盖过阀门判断、把作业排进没有消费者的队列~~
   ——**这一条 12:19 被生产台账证伪，撤回**：`!result.output` 只有一个来源（`analyze.ts:493` 的 `waitsForPage`），
   而 `waitsForPage` 自己就带 `isCollectEnabled()`（`analyze.ts:211`，那一行的 `return isCollectEnabled() && …`），所以阀门关着时这条分支根本走不到；
   实测 `content.extract-body` 在 02:11:54Z 关阀之后**新建 0 个作业**，而同一个队列在关阀前 2 分钟还在正常完成
   （累计 41,713 个 `completed`，最新 10:09:31）⇒ 队列活着、只是没被喂。**别照着这段去"修"那个 131 行**，
   两处阀门判定（`route()` 与 `waitsForPage()`）都在，已经是双保险。
   当时看到的「一批 `new` 长期不动」也不是孤儿：那是**深积压的排队等待**——12:19 实测队列里 `created` 的判定作业
   已经等了 **53–58 小时**，且 16,876 个排队作业 ≈ 13,084 条档案 `new` + 3,786 条首导 `new`（一一对上，没有丢行）。
   正确的读法：`processing_queued_at` 老 ≠ 作业丢了，先比"排队作业数 vs `new` 行数"，再谈孤儿。
   2026-10-17 实测暴露面：全库 54 行 pending、其中实时带 26 行，档案带 13,212/13,218 已是 `ok` ⇒ 代价可控，
   但**每次关阀前都要先量这个数**；`isCollectEnabled` 的默认值是 **true**（`config.ts:79`），
   键不在 `.env` 里就等于开着，所以这个阀门必须显式写。
   档案脚本（`backfill-archive.ts`/`backfill-news.ts`/`backfill-papers.ts`）**不读这个阀门**，
   所以档案进口与历史出刊照跑（10:15:59、10:30:57 两轮在阀门关闭状态下全 phase `exit=0`；
   只有 `scripts/collect.ts` 会拒——它要 `--force-collect`，而档案周期不跑它）。
2. **暂停期漏掉的实时信息是可补的，但归期规则要说准**：`reports/compose.ts:101-105` 对非档案条目按
   **「到稿（`visible_after`）与发布（`timeline_at`）的较晚者」归期**——档案条目才纯粹按自己那一天归。
   日报窗口是 [D-1 08:00, D 08:00) 北京（`dailyWindow`，`compose.ts:307`）。
   ⇒ 恢复采集后重新发现的今天下午条目，`visible_after` 落在今天夜里 ⇒ **进明早那一期，不会去挤今天已封版的那一期**，
   这条链是通的（这一轮一开始我把它写成"成刊按发布时间取条目"，那是错的，2026-10-17 复核时改正）。
   两个会让"补回来"打折的事实也要知道：`compose.ts:95` 把 `backfill` 且理由不是 `archive` 的条目（首导、迟到 48 小时以上）
   **一律挡在日报之外**；`compose.ts:322-324` 每节 8 条、快讯 12 条是硬顶，超出的按分数丢掉——**补回来的条目不保证都印出来**。
   至于恢复本身：`scheduleDueSources` 每分钟一轮、`FETCH_SCHEDULE_BATCH=40`，666 个源里到期的会在十几分钟内被重抓，
   **不需要额外补跑**；真正会永久丢的只有 feed 只留十几条又隔得久的老源。**12:02 把这句量成了数**：
   只算实时带（档案门读的是过刊合订本，不轮转），386 个七天出过稿的源里 **26 个会丢**，
   整个 7.3 小时窗口估丢 **328 条原始条目**，按实时带七天精选率 9.73% 折算 ≈ **32 条精选**——
   占一天正常精选量（196–326 条）约一成，且日报每节 8 条 + 快讯 12 条的硬顶离这个量还远 ⇒ **不会造成薄天**。
   丢得最多的两族是 `json-nmc-weather-alarm`（29.1 条/时、feed 只留 40 条 ⇒ 估丢 172）和
   `cn-chinanews-scroll`（18.8 条/时、feed 30 ⇒ 估丢 107）：**要停实时就优先挑这两族的低峰**，
   它们的量决定了整个窗口的损失上限（两族合计 279 ∶26 源其余 49）。
3. 把并发抬到 `.env` 现值之上就是在赌读者面不退化，而**赌注由 `geohot-conc-guard` 收**：每 5 分钟探四个读者面，
   `slow≥2`（单样本 ≥5 s）或任一 ≥8 s、或 `MemAvailable<40 MB`、或 swap>1,400 MB、或 6 分钟内 5xx≥2、
   或一次探测里出现任何 5xx（`http5>=1` 单独算命中；`curl -m 20` 失败会被记成 20.0 s，一个卡死的页面就能触发 floor）。
   触发时它**分别**改写高于各自地板的那一路（`conc-guard.sh:71-72` 是两个独立条件，不是"一起降"），
   然后重启 worker、写 `/etc/geohot/conc-guard.tripped` **自锁**——不删掉它就不再保护，
   复位是 `rm /etc/geohot/conc-guard.tripped && sudo systemctl start geohot-conc-guard.timer`（脚本 19-20 行），
   之后再把 `.env` 里的值抬回去并重启 worker。**注意它的地板是写死的 4/3，而 `ANALYZE_CONCURRENCY` 的代码默认值是 6
   （`jobs/content.ts:180`）：如果这一行不在 `.env` 里，"只改已存在的行"的 sed 降不下任何东西，守护就管不到这一路。**
   2026-10-17 实测：10:35:10 探针 slow=2（首页 5.2 s、周报 6.3 s）⇒ 6 槽被自动降回 4；
   而 11:00:30 在**已经是 4 槽**时又报了一次 bad（首页 10,124 ms）——**尖峰不能记在提速账上**。
   于是 11:01 把 `geohot-archive.timer` 也 `stop`（保持 enabled，想验证"归档周期是根子"这句旧话——
   **当时写的"恢复脚本会 start 回来"是不实的，12:04 现场核对才发现脚本里根本没有这一条，已补**，见第 4 条）。
   **结果这句也不完整**：归档周期停掉之后，11:18–11:26 每 75 秒采四次读者面，首页仍出现 6.9 s（同刻 `MemAvailable` 45 MB），
   而守护自己在 11:05/11:10/11:15/11:20/11:25 五次探针全 `bad=0`——**慢样本与内存余量同向，与"谁在跑"只部分相关**。
   结论：**这台机器的读者面余量就是内存**，归档周期与判定并发都只是往上加压的人；
   **要更高并发必须先解决内存**（加内存，或把重活与读者高峰错峰），而不是改守护的阈值。
4. **自动复位的脚本必须枚举"本轮我手工停过的每一样东西"，不能只回最显眼的那个阀门**。12:04 现场抓到：
   `r113-restore-realtime.sh` 原本只做 `COLLECT_ENABLED=true` + 重启 worker，**没有**
   `systemctl start geohot-archive.timer`——照它跑完，实时恢复了、**回填却永久停着**：档案进口（`collect-*` 相位）
   与历史期次补刊（`papers` 相位，生产 `/etc/geohot/archive-cycle.conf` 里 `GEOHOT_ARCHIVE_APPLY=1`，
   11:00:46–11:01:45 那一轮 `exit=0` 就是它在写）都挂在这个定时器上，而"回填"正是这一轮的全部意义。
   **一处必须说准的边界（12:31 复核代码后改正——我原先写的"停掉它 ⇒ 日报静默停更"是把功记错了对象）**：
   **当期**期次（今天/本周/本月）由 worker 出——`schedules.ts` 里 `reports.daily` cron `0 8 * * *`、
   `reports.weekly` 周一 10:00、`reports.monthly` 每月 1 日 10:30、`reports.catch-up` 每小时 :15；
   今天 08:01:24 那期日报是 worker 那一枪出的（定时器 11:01 才停）。归档周期的 `papers` 补的是
   **结算了却从没印过的历史期次**。所以停一天它的后果是"回填与历史补刊停摆"，不是"明天读者看不到日报"。
   已补进脚本（旧版备份在 `/opt/geohot/backups/r113-restore-script-*`），并用 `bash -n` + 现场 `cat` + `grep -c` 三重确认只有一条。
   定时器是 `Persistent=true` + `OnCalendar=*:00/15`，一 `start` 补跑**一轮**（不是九十六轮）；
   `flock -n` 拿不到锁时那一轮只打一行 "another cycle holds the lock; skipped" 就 `exit 0` ⇒
   **别把"start 成功"当成"这轮真跑了"**，验证要看 `geohot-archive.service` 的 `ExecMainStartTimestamp`（verify 脚本已把它写进日志）。
   **做法**：写"到点自动恢复"的脚本前，先把这一轮手工执行过的所有 `stop`/`sed`/`restart` 列成清单，
   逐条对着清单写复位——只按"我要改什么"的记忆写，漏掉的必然是顺手做的那一下。
5. **窗口结束后实时带不会自己长出欠账，但 `failed` 带会**：12:06 实测 `processing_state='new'` 的实时条目 **0 条**
   （队列里 priority 0 的作业也 0 条），说明暂停期间实时带是真的排空、不是被压住——恢复后只需要等新稿。
   可是有 **219 条实时条目停在 `failed`**（安全网的门口只写 `processing_state = 'new'`（`jobs/content.ts:241`），
   `failed` 只能靠 `requeueFailed` 那一条 UPDATE 回到 `new`，而它还多一道"最近 30 天"的窗（`content.ts:290`））：
   76 条死门 403 `FreeTierError`（opencode，早已不在池里，重来会走活的门）、
   76 条付费写作产不出可用中文（54 条"无中文正文 / finish_reason: length"、22 条"中英混排"，即 #236 那一族）、
   10 条内容安全 403、~16 条 unusable output。按发现日摊在 10-04…10-16，最多的单日 58 条（10-10）。
   **要补这批只能显式 `requeueFailed`（`jobs/content.ts`，付费、且 priority 0 会插到档案前面约 1.3 小时槽位）**。
   **13:17 已按站长 13:06 的自主授权执行了一半——只重排"死门 403"那一族 76 条**（opencode 早已摘出池，
   重排后走的是活门，成功率高；实测 `active`/首导带不受影响、审计文件 root-only）：
   执行前 `failed` 实时带 219 → 执行后 143，`new` 实时带 0 → 76，两个数对得上（差 76 = 重排条数 + 那 1 分钟新判掉的）。
   **剩下三族故意不动**：77 条"付费写作产不出可用中文"（#236 未修，重来大概率原样再败）、
   10 条内容安全 403（`ProviderRejectedError` 不可重试 ⇒ 一次就回 `failed`，白花一次钱）、
   ~37 条 unusable output（多数仍指向在用的门，属于同一族的重复失败）。
   教训一条：**重排要按 `processing_error` 分族做，不是按"failed 一堆"整体做**——
   整体重排的账单里有一半是买第二次同样的失败。
   **但别把这句推广成"`failed` 全被永久钉死"**：`unknown` 收据那一族自带自动回路——
   `ops.recover` 每 10 分钟跑 `autoReleaseUnknownReceipts`（`admin/runs.ts:137`），放行时顺带把条目改回 `new` 并重排，
   `receipt_attempts.error LIKE '自动放行…'` 那条记录还兼作"只自动放行一次"的记号。
   本批 219 条按 `processing_error` 分族里**一条 `receipt … outcome unknown` 都没有**，所以"这一批不会自己回来"成立；
   反过来，下次看到一批 `failed`，先分族再决定要不要花钱重排。
6. **回填判出来的材料不会自己爬进已经印出的那一期**（这是"连贯"这件事上最容易漏的一环）：
   归档周期的 `papers` 相位对**已有期次一律跳过**——`scripts/backfill-papers.ts:174`
   `if (exists && !values.refresh)` 记一条跳过（**这一行有两个文案**：可读的记"已有可读刊期（未重排）"，
   不可读的记"已有不可读刊期（需 --refresh 复核）"），而周期脚本里
   `FINAL_REFRESH="${FINAL_REFRESH:-0}"`（`deploy/geohot/archive-cycle.sh:13`）只有设成 1 才带 `--refresh`
   （`:198`）。⇒ 生产现值下这一轮判完的档案条目**读者看得到，但只有两条路、且都不等于"进了期次"**（12:57 现场验的）：
   - **日页是真的有**：抽 6 条本轮判出来的档案条目，逐个用 `/api/site/pool?category=<它的分类>&date=<它那一天>` 查，
     **6/6 命中**；那一天该分类返回 14 条（DB 核对：14 条 public，其中 6 条精选 + 8 条未精选），
     且 14 条的 `timelineAt` 全落在那一天 ⇒ **日期筛选是诚实的，不是把别的日子混进来**。
     本轮升到公开可刊的档案条目实测 **79 条**（`publications` × `analyses` 连查）。
   - **分类时间流不会把它们顶到前面**：`/api/site/pool?category=physical`（不带日期）第一屏 40 条**全是 2026-10-17 的**，
     八月的档案条目要经月历卡/日期入口才到得了 ⇒ 报告时别写成"精选流里立刻可见"。
   - **已印出的 1—9 月期次不会因为多了几条就自己变厚**：必须显式 `backfill-papers --refresh --apply`（第 110 号工单）。
     **这一条今天已经走通了第一期**：14:07 的只读排程里 273 天中唯一 `waiting=0` 的 `2026-01-05`，14:19 重排后
     分节条目 4 → 8、`revision` 1 → 2、旧版整份进 `report_revisions`（**回退要手写 SQL，仓库里没有回退通道**，见下面"可回滚"那条改正），成本 **≈1 次 `report_lead` 调用 / 墙钟 ≈53 秒**，
     读者侧 8—9 分钟后在 `/geohot/daily/2026-01-05` 看得到（细节见本节末的试点记录）。⇒ "1—9 月全部重排"的**钱不是门槛**
     （273 期 ≈273 次调用），门槛是每条期次那一天最后一条判完。它仍是读者面可见的内容改写，**成片重排要站长点头**：
     常规做法是夜里把 `archive-cycle.conf` 的 `FINAL_REFRESH` 设成 1 让周期自己带 `--refresh`，而不是再手写一个循环。
   顺带一条同族的读表警戒：`backfill-papers.ts:138` 写明"`failed` 故意不算未完成……交给 `--refresh`"——
   所以"某一期ripe却不出刊"这类结论，先确认它卡在哪个状态，再决定是等队列还是重排。
7. **第 6 条的 `--refresh` 在队列按"入库先后"派发时是永远打不开的门——12:47 用只读排程实测：Jan–Sep 的
   273 天全部落在 `等 N 条判完` 那一支，`会重排` 0 期**。代码里的顺序就是原因：
   `consider()` 先 `if (waiting) return …'等 N 条判完'`，**再**判 `exists && !refresh`，
   所以只要那一天还有一条没判完，`--refresh` 连"要不要重排"都不会去问。
   ⇒ 这两件事是**串联**的：档案队列**派发起来不按新闻日期**（11:20–12:00 那一小时判完的档案条目落在
   8 月 20 ∶ 4 月 14 ∶ 5 月 11 ∶ 6 月 8 ∶ 7 月 8 ∶ 1 月 7，是散的；`sweepUnprocessed` 是按新闻日期挑的没错，
   可它**只负责新入队的那一批**——队里早就排好的那些作业按 `created_on` 派发，轮不到它挑），
   所以判定摊在 273 天上是"每天都薄一点"，没有一天过完、也就没有一期能被重排；
   而按 `timeline_at` 从旧到新排（`jobs/content.ts:251` 的 `reserved` 与 `:256-257` 的 `remainder` 两份档案都按
   `timeline_at, id` 取，只有 `:253` 的 `ordinary`（非档案）按 `discovered_at`——**别记成"只有那 100 条按新闻日期"**）
   ⇒ 我当时算的是"平均 48 条/天 ÷ 167 篇/时 ⇒ **每 ≈17 分钟真正过完一天**"。
   **这个预估被下午的实测否掉了，就地改口径**：重排之后 13:11→14:07 那 56 分钟里**只有 1 天归零**（2026-01-05），
   两个原因——① 167 篇/时是上午最好的一段，下午档案带独占也只有 60—133 篇/时（13 点整点 125 篇、其中档案 38 篇）；
   ② 各天的行数差得很远（1 月 2 日 62 行、1 月 5 日 124 行、1 月 29 日 189 行），"平均 48 条/天"把尾巴抹平了。
   还有第三个今天下午才看见的原因：**同一秒内并列的作业是谁先派发并不保证**——安全网每轮几百条只在几秒里入队，
   `created_on` 挤在同一秒，于是"天"是**成波浪结算**、不是一天走完才走下一天（14:07 那天 01-05 已归零、01-10 还欠 57 条就是这个形状）。
   **可用的算法**：`剩下可重排的天数 ≈ 判完数 ÷ 当天行数`，所以报 ETA 要报"每天大约 2—6 期过完"，别报"17 分钟一期"。
   改队列次序要动 pg-boss 的作业表（应用里没有受支持的 cancel 通道——**更正**：我 12:5x 写"grep cancelJob 只命中
   `http-fetch.ts` 的流取消"是错的，全仓 `cancelJob` **0 命中**；`lib/http-fetch.ts:100` 那句 `await res.body?.cancel()`
   只是响应流取消，跟作业取消没关系，也没有任何 `boss.cancel/deleteJob` 用法），
   属于对共享队列的批量写操作 ⇒ 先备好命令、收益与回滚（工单 #254），**13:06 站长授权"不用等拍板"之后，13:11 已实际执行**，
   过程与自证见下面那段执行记录。


### 第一百一十三轮 · 队列重排的实际执行记录（2026-10-17 13:11）

**先做 200 行的机制探针，再动整带。** 探针读数：删掉 200 个 `created` 档案作业并清标记后，**下一分钟安全网正好把这批补回来**，
携带的新闻日期是 **2026-01-01 → 2026-01-10** ⇒ `sweepUnprocessed` 的 `ORDER BY timeline_at` 是活的；
同时看清一件事：**派发是"入队时间 FIFO"**，所以只重排一部分没有用——那 200 条会排到队尾，
必须整带一起重排，才能让"入队顺序"变成"新闻日期顺序"。

```sql
BEGIN;
CREATE TEMP TABLE relay AS
  SELECT j.id AS job_id, j.data ->> 'articleId' AS aid
  FROM "pgboss".job j JOIN articles a ON a.id = j.data ->> 'articleId'
  WHERE j.name = 'content.analyze' AND j.state = 'created' AND j.priority = -1
    AND a.backfill_reason = 'archive';
DELETE FROM "pgboss".job j WHERE j.id IN (SELECT job_id FROM relay);
UPDATE articles SET processing_queued_at = NULL WHERE id IN (SELECT aid FROM relay);
COMMIT;
```

**动手前的安全门，逐条都要能自证**（这次实测值写在后面）：
① 只碰 `state='created'` ∩ `priority=-1` ∩ `backfill_reason='archive'`，`active`（在飞、已经花了钱的）一条不碰 ⇒ 前 4 后 4；
② 首导带 `-2` 不碰 ⇒ 前 3,786 后 3,786；
③ 先把整带的每一行落到 root-only 审计文件（`/root/r113-relay-audit-<UTC戳>.tsv`，13,009 行，`chmod 600`）；
④ **行没丢**：档案带 `new` 13,005 → 13,000，差的 5 条正是这 6 分钟真判掉的，不是少了一万三；
⑤ 前提要先证实再依赖：`content.sweep` 每分钟确实在跑（10 分钟内 9 次 `job_runs`）——
   安全网重排的速率（每轮 reserve 100 + remainder 补到 500）远快于派发（≈2.8 条/分），
   所以队列会自己长回来，最坏是浅队列，不会把档案带饿死。

**怎么确认它真的生效**（10 分钟以上的读数，别看瞬时值）：判完条目的新闻日期应当**从 1 月 1 日往上走**而不是散在十个月上；
再拿只读排程重跑一月，`等 N 条判完` 的 N 应当**开始有天变成 0**——那天就从"推不开的门"变成 `--refresh` 动得了的期次。

**13:13 的验证读数（重排后 2 分钟）**：队列深度回到 100（安全网按分钟在补，`created_on` 13:13:08–13:13:12），
新闻日期跨度 **2026-01-01 → 01-08**，**逐对检查入队顺序与新闻日期顺序的一致性：100 对里 0 对逆序**；
这两分钟判掉的 6 条落在 01-12 / 01-13 / 01-14 / 01-30（外加 2 条 2015-08-31 的越界旧料，属第 189 号那一族），
瞬时速率 **194 篇/时**、`active` 始终 4 ⇒ 重排没有把档案带饿着。
一月的只读排程：**2026-01-01 只剩 wait=1**（`--refresh` 第一次离"推得开"这么近），01-04=6、01-02=7、01-03=8，
全月 31 天合计还有 1,591 条未判 ⇒ 按 167 篇/时算，一月整月约 9.5 小时窗口判完，之后逐月往后推。

**上面那两句是错的，就地更正**（14:00 复量）：`backfill-papers` 的只读排程只把 `等 N 条判完` **按次数聚合**打印，
我 13:13 把聚合行当成按天序的行读了，于是 01-01/01-02/01-03/01-04 各自的 N 全部错位；而"一月 9.5 小时判完"
用的 1,591 与 167 篇/时两个数都不成立——167 是 11—12 点瞬时最好的一段，下午真实速率见下。
**按天的正解要用 `--summary-file` 那份 JSON**（聚合文本里没有日键），14:07 的读数：
`2026-01-05 waiting=0`（当天已判完、可以重排）、`01-01=1`、`01-02=2`、`01-03=1`、`01-04=1`、`03-02=1`、`07-19=1`、`07-20=1`、
`05-04=2`、`05-05=2`、`07-06=2`、`09-20=2`、`05-03=3`、`08-23=3`、`02-02=4`；一月—九月 273 天的 `waiting` **合计 14,232 条**。

### 第一百一十三轮 · 量具十处按现场改正（每一条都是我先错过一次）

| 错法 | 现场证据 | 正确读法 |
| --- | --- | --- |
| 用 `j.data->>'id'` 关联队列作业 | 12 条一月未完成行全部显示"没排队"、队首 8 行的 `articleId` 打印成空 ⇒ 键名根本不存在 | 入队写的是 `{ articleId }`（`jobs/content.ts:97`），关联要用 `data->>'articleId'` |
| 用会话时区的零点当"一天" | 我先用 `generate_series(date…)`（出来是 CST 零点）又改用 `AT TIME ZONE 'UTC'` 的 `[D 00:00, D+1 00:00)`，两版都跟出刊口径差一天 | `dailyWindow(D) = [D-1 00:00 UTC, D 00:00 UTC)`＝`[D-1 08:00, D 08:00)` 北京（`compose.ts:307-310`：`end = beijingMidnight(D)+8h`，`start = end-86400000`；`time.ts:18-20` 的 `beijingMidnight` 就是 `D00:00+08:00`）。SQL 里写 `timeline_at >= ((g::date - 1)::timestamp AT TIME ZONE 'UTC') AND timeline_at < (g::timestamp AT TIME ZONE 'UTC')`。**这条更正本身也是二次改正**：我 13:55 那一版按 `[D 00:00, D+1)` 数出来的"01-05 未判 15"其实是 01-06 的窗，正解见下面 14:07 的只读排程 |
| `SELECT … ) day,` | `ERROR: syntax error at or near "day"` | `day` 是保留字，别名换成 `dk` |
| 以为 `reports` 有 `readable` 列 | 查询直接报错 | 库里没有这一列，`readable` 是代码从 `content` 推的；要数期次厚度就取 `content->'sections'[*].items` 与 `content->'flashes'` 的长度 |
| 数 `content` 里有没有"导语"用 `content ? 'lede'` | 已重排的期次照样返回 `false` | 那份 JSON 的顶层键是 `date, flashes, generator, highlights, lead, metrics, sections, windowEnd, windowStart` ⇒ 导语叫 **`lead`**（里面是 `{title, leadParagraph}`），叫 `lede` 永远数不到 |
| **拿日报的形状去数周报与月报**（14:58 我自己踩的） | 一条 `sections[*].items` 的查询数出来"41 期周报、9 期月报**全是 0 条**"，差点被写成"周报月报都没有内容"这种大事 | 周报/月报根本没有 `sections`：顶层键是 `generator, headline, isoLabel 或 monthLabel, kind, metrics, overview, periodStart, periodEnd, storyOrder, themes, title`。**件数看 `storyOrder`（周报 40、月报 60），总述看 `overview`，分节看 `themes`**。现值（14:59）：周报 41 期里 36 期 `overview` ≥200 字、4 期没有、1 期 50 字；月报 9 期里 7 期 `overview` 341—443 字、`2026-03` 只有 35 字、`2026-04` 从来没有过 |
| 看到某期"今天 revision 涨了但总述是空"就断言"重排把总述写坏了" | `report_revisions` 里 `2026-04` 的 r1…r4 的 `overview` 长度**全是 -1**，最早一条是 10-13 ⇒ 它从来没被写过，"写坏"是编出来的因果 | **先数归档行再下结论**：把每期 `report_revisions` 各 revision 的 `length(content->>'overview')` 列出来，"从无到有"和"从有到无"长得完全不一样。顺带一条真结论：制造那些 revision 的是 `scripts/recompose-report.ts:74`（reason=`copy-refresh`），今天上午对 `2026-03/04` 连跑 6 次只把 03 从"无"变成"35 字"、04 六次全空手 ⇒ **同一期反复重排在概览撞回退门时是无效的付费动作**（成员被 `pickMember` 的 sha256 取模钉死，撞的就是同一扇门） |

| 在 `pgboss.job` 上做表达式关联 + 窗口函数 | `canceling statement due to statement timeout`（20 秒） | 只对 `name`/`state`/`priority` 过滤后取计数；一行一条的 `row_number()` 排在这台 2 核机上必然超时 |
| `GEOHOT_PHASE_SECONDS=280` 跑一次性重排 | 打印"本轮时间预算用完，这一期没开始"，零付费调用、零写入 | `CALL_HEADROOM_MS = 300_000`，任何 ≤300 的相位秒都会**开工前就耗尽预算**；手动跑要 `GEOHOT_PHASE_SECONDS=1800` 起步 |
| 一次性脚本里 `set -a; . ./.env` 之后再 `node --env-file=.env` | 出刊报 `LLM_EXTRA_JSON must be a JSON object`（`providers/llm.ts:49`），看着像代码坏 | **bash 会把带空格的值劈断**：同一条 `LLM_EXTRA_JSON`，source 之后长 23 字符且 JSON 解析失败，而 `node --env-file=.env` 自己读是 27 字符、`{reasoning_effort:…}` 正常成对象；而 `--env-file` **不覆盖已经在环境里的同名变量**，坏值赢。同类受害者还有 `.env` 第 53/56 行的两把 `WORKBUDDY*_CREDENTIAL_JSON`。跑法：要 SQL 就在子 shell 里 source（`DBU=$(set -a; . ./.env; printf '%s' "$DATABASE_URL")`），node 那份进程环境一律交给 `--env-file` |


### 第一百一十三轮 · 速率的真实上限与回填的时间账（14:00）

逐小时判完数（`analyses`，origin 全是 `model`）：**08 点 140、09 点 165、10 点 199、11 点 173、12 点 133、13 点 125**。
同一时段 `receipts` 稳定在每 30 分钟 305—405 次（≈700—800 次/时），**调用数没掉、判完数掉了** ⇒
瓶颈不在模型窗口，而在"一条判定要跑几次调用、其中两次打分串行等页"与 4 个内存槽位的乘积。
**调用次数按代码是 5 次，不是"4—6 次"**（12 智能体核引时抓出来的不精确处，已按源码改正）：
`prefilter_article`（`analyze.ts:224-233`）→ 两次 `score_article` 串行（`:47 SCORE_CALLS = 2`、`:253` 的循环，注释写明"第二次复用供应商的 prompt 缓存"）
→ `structure_article`（`:283`，与写作步并行）→ `writing` 步在 `understand_article` 与 `summarize_article` 里**只取其一**（`:313-319`）。
BLOCK 只花 1 次；没有配门槛（`threshold===null`）时不打分＝3 次。
13:20—13:50 那一段档案带是 0：不是我打断了它，是我 13:17 重排的 76 条实时条目在 `priority=0`，按设计压过整条档案带；
这批跑完（约 69 条）档案带才回到 60—96 篇/时。**这条要写死的教训：往实时带重排条目会立刻吃掉档案带的全部槽位，
窗口内的"加速"动作只能往档案带里加，不能往实时带里加。**

时间账（现值，16,512 个 `created` 作业 = 档案带 12,727 + 迟到新闻/首导带 3,785）：

**14:40 补一次"我们是不是已经顶到天花板"的取证**（结论：是）：60 秒 12 次采样里 `content.analyze` 的
`active` **一直是 4、`retry` 一直是 0**；近 30 分钟 53 个作业完成、4 个在飞，**单作业墙钟 avg 128.7 秒、p50 129.1 秒、p90 201.1 秒**
⇒ 理论上限 `4 × 3600 ÷ 128.7 ≈ 112 篇/时`，实测 106 篇/时——**没有排队空转，槽位满载**。
同一时段的逐门调用延迟反而**更低**（workbuddy 24.3 秒 vs 上午 33.8 秒、workbuddy-cn 44.6 vs 68.9），
失败面也小（13:00 后 `failed` 个位数，`completed` 是终态；把 `status<>'received'` 当失败率会把 963 条成功算成坏，
这条量具错也记在这里）。⇒ **上午 199 篇/时与下午 106 篇/时的差不是门变慢，是"一条判定要跑几次调用"变了**：
上午那批里有大量预筛就拦掉的便宜条目，下午是全链路的档案长文。报速率时要连着报**单作业秒数**，只报篇/时会误导。

- 只按档案带独占、130 篇/时算 ⇒ **≈98 小时 ≈ 4 天满速**；17:30 实时恢复后档案带只领剩下的槽位，
  所以"整带判完"是**多天到数周**的量级，不是一次窗口能干完的事。上一轮记的"≈42 小时"是队列只有 7,532 行时的账，
  进口在这几天又推进了一倍，引用那个数之前要先重数队列。
- 队列次序是干净的：`priority=-1` 带里新闻日期从 **2026-01-01 到 2026-09-21**，
  **排在队首那条之前的"更早的漏网行"只有 2 条** ⇒ 重排没有因为重试而回乱，不需要再来一次整带动作。
- `--refresh`（第 110 号）今天的门还是推不开，而且是**结构性的**：`consider()` 先算 `unsettled()` 再决定是否问 `--refresh`
  （`scripts/backfill-papers.ts:162-173`），只要那一天还剩一条没定，重排就永远不会被请求。273 天里 14:07 只有 **一天**过关（2026-01-05）。
  而 14:00 抓到的 19 条一月初未完成行里 **6 条属于"迟到新闻"带（−2）**——它们的新闻日期在一月，却要等 12,727 条档案带排空才轮得到（见第 257 号工单）。

### 第一百一十三轮 · 第一次真的重排了一期历史日报（2026-10-17 14:19，2026-01-05）

**这一期是唯一一天 `waiting=0`，就拿它当试点，一次只动一期。** 动手前把整份 `content` 落到 root-only 备份，动手后逐项对账：

| 对账项 | 前 | 后 |
| --- | --- | --- |
| `reports.revision` | 1 | **2** |
| 分节条目 `sections[*].items` | 4 | **8** |
| `generated_at` | 2026-10-13 07:36:52+08 | 2026-10-17 14:20:07+08 |
| `report_revisions` 归档行 | 0 | **1**（`reason='archive-backfill'`，`revision=1`，旧内容 4 条原样在里面 ⇒ 回退有据可依，但**要手写 SQL**，仓库里没有回退通道） |
| 读者侧 `/api/site/reports/daily/2026-01-05` | — | **200 / 0.94 s / 25 KB**，`readable=true`，`lead.title="调水调沙使黄河三角洲由退缩转为年均扩张 6–7 km²"`，导语是真中文（不是占位句） |

**重排一期的真实花费 ≈ 1 次付费调用**：那 80 秒窗口的账上有 15 次调用，其中属于出刊腿的只有 `workbuddy / report_lead` 一次，
其余 14 次是并行在跑的逐条判定（`score/structure/prefilter/understand/group/translate`）。⇒ 第 110 号工单的规模不再是钱的问题：
273 期 × 1 次 ≈ 273 次调用、单期实测墙钟 **≈53 秒**（含起进程），**全部挡住它的只有"那一天还没判完"**。
两次失败的试点都归我自己那把量具：`GEOHOT_PHASE_SECONDS=280`（见上表）、`set -a; . ./.env` 把 `LLM_EXTRA_JSON` 劈断（见上表），
`apply_rc=1` 那次没有写库、`revision` 仍是 1——失败路径确实不落地。

**两条跟着来的实测**（都影响"重排完读者什么时候看得见"）：

- **写库到读者看见有 8—9 分钟的源站延迟**：`generated_at=14:20:07` 落库后，14:28 抓 `/geohot/daily/2026-01-05` 拿到的还是旧那一版，
  14:29 才见到新导语。这不是 Cloudflare 的边缘缓存——这些路径的 `cf-cache-status` 一律是 `DYNAMIC`（日报页 `max-age=300, s-maxage=3600`、
  报表 API `max-age=120, s-maxage=120`），延迟出在源站 `geohot-web` 自己的 loader 缓存。**结论：验收重排效果要等 10 分钟再抓页面，
  或者直接用 `/api/site/reports/daily/<key>`（它的缓存更短）核对 `revision` 与条数。**
- **`--refresh` 会重复重写同一期**：14:29 那一轮里唯一 `waiting=0` 的还是 01-05，于是它被第二次重写（`revision` 又 +1、`report_revisions` 又多一行，
  条数没变、导语调用被复用没再花钱）。⇒ 逐日重排时**要把已经归零的那天从区间里挪出去**（`--from` 往后推一天），
  否则每一轮都在白重写同一期，还会把 `report_revisions` 撑长。
  **16:20 那一轮又犯了一次**：01-05 从 `rev=3` 被重写为 `rev=4`、条数仍是 8，`report_revisions` 现在挂着 3 行归档——
  这条已经不是推测，是同一个量具两次同一处失手的记录。

### 第一百一十三轮 · 一次跑完"所有已判完的那天"（2026-10-17 16:20，`--refresh --apply` 全区间）

把上一条的试点放大成"整段区间一趟"：`--from=2026-01-01 --to=2026-09-30 --kinds=daily --refresh --apply`，
外面套 `timeout 1000`，定时器 `r113-refresh-pass2.timer` 16:20:05 开火，**16:28:26 自己收工（8 分 21 秒）**，`rc=0`。

| 期次 | `revision` | 重排前（`report_revisions` 里那一行） | 重排后 |
| --- | --- | --- | --- |
| 2026-01-05 | 1 → **4** | items=4（10-17 07:36）| items=**8** |
| 2026-01-09 | 1 → **2** | items=4（今天 06:47 才第一次出刊）| items=**9** + flashes=**9**（合 18 条材料）|
| 2026-01-11 | 1 → **2** | items=1 | items=**7** |
| 2026-01-12 | 1 → **2** | items=1 | items=**4** |

`report_revisions` 逐行读回来的原值就是"重排前"的那一份：01-05 的归档链是 `rev=1 items=4 → rev=2 items=8 → rev=3 items=8`，
**第三行就是那次白重写留下的痕迹**（条数没变，只多一行归档）。四天合计：**分节条目 10 条 → 28 条**，另加 9 条快讯。

计划器同一趟报的是 `refreshed=4 / failed=0 / still_waiting_days=269` ⇒ **273 个历史日里真正"判完"的只有 4 天**，
其余 269 天各自还挂着 6—238 条未判，`--refresh` 对它们连问都不问（串联关系见 §14 第 7 条）。

**这一趟的真实成本**：16:00—16:28 账上 424 次付费调用里，属于出刊腿的 `report_lead` 只有 **3 次**
（4 期重写、01-11 没拿到导语 ⇒ 它的 `lead` 是空的，读者侧走的是第 112 轮补的那句诚实话术），其余 421 次是并行在跑的逐条判定。
⇒ 上一段"重排一期 ≈ 1 次调用"成立，但**它挡不住"白重写"**：01-05 那两次额外重写各花了一轮 compose（付费的是模型腿而非出刊腿，条数不变）。

**读者面在这 8 分钟里的实测**（24 次 GET，四条路径各 6 次）：全部 200，最差是首页冷启 **1.685 s**，其余 0.049—0.551 s，
`/geohot/daily/2026-01-09`（新重排的那一期，含 9 条快讯）打开 0.049—0.124 s。⇒ 单跑一趟逐期重排不会把读者面打穿；
`MemAvailable` 从开跑前 274 MB 掉到 116 MB（16:27 采到）、收工后回到 151 MB，守护没有触发。
**当天 08:01:24 的当日日报 `rev=1 / items=17 / flashes=12` 全程没有被这两趟重写碰过**——这是"历史重排不伤当期"的直接证据。

**三个表面对得上账**（16:45 复抓，写库已过 8—9 分钟的源站 loader 延迟）：

| 期次 | 库内 `sections[*].items` | 网页 `/geohot/daily/<key>` 里的条目链接（去重） | v1 `/api/v1/dailies/<key>` |
| --- | --- | --- | --- |
| 2026-01-05 | 8 | 8 | 8（sections=1，导语中文） |
| 2026-01-09 | 9 + 9 快讯 | 18 | 9 items + 9 flashes（sections=2） |
| 2026-01-11 | 7 | 7 | 7（`lead` 为空 ⇒ 头版走机械兜底，印的是真中文标题「夜间灯光动态揭示成渝都市圈城郊亮化与人口脱钩」+ 正文段，不是占位句） |
| 2026-01-12 | 4 | 4 | 4 |

⇒ **`lead=null` 不等于读者看到空页**：头版那块的取值链是
`ReportPaper.tsx:248` `title = report.lead?.title ?? leadStory?.title ?? headline(...)`、
`:250` `rawDek = report.lead?.leadParagraph ?? leadStory?.summary ?? report.overview`，而 `leadStory` 只在
**日报且 `report.lead` 为空**时才非空（`:193-195`：`if (report.lead || report.kind !== "daily") return null`，取的是 `highlights[0]`，
再退到第一个有条目的分节）。**`leadAbsentNote`（`format.ts:132-136`）的触发条件只有一个：`dek` 为假（`:266-269`）**——
跟标题空不空无关（标题永远还有 `headline()` 这一层机械兜底），也跟 `lead` 对象在不在无关：
`??` 不会跳过空串，所以**`lead` 存在但 `leadParagraph` 是空串**时 `rawDek` 就是 `""`、`leadStory` 又必然是 `null`，
那句话照样会印出来。周报/月报同理，只是它没有 `leadStory` 这一层，兜底只剩 `report.overview`。
验收"重排到底有没有兑现到读者脸上"，数**页面里的条目链接**和 v1 的 `sections` 就够，不必开浏览器。

### 第一百一十三轮 · 窗口全天的逐小时账（17:05 复量，把 106 那句快照补成整天的形状）

`analyses` / `translations` / `receipts` 按北京时间整点数出来的行（17 点那格只到 17:05，不参与结论）：

| 整点 | 判完（篇/时） | 译文新增（条/时） | 付费调用（次/时） | 折算 每次判定的调用数 |
| --- | --- | --- | --- | --- |
| 08 | 144 | — | 948 | 6.6 |
| 09 | 165 | 3 | 906 | 5.5 |
| 10 | **199** | 44 | 980 | 4.9 |
| 11 | 173 | 54 | 796 | 4.6 |
| 12 | 133 | 101 | 653 | 4.9 |
| 13 | 125 | 97 | 725 | 5.8 |
| 14 | 120 | **118** | 728 | 6.1 |
| 15 | 165 | 65 | 738 | 4.5 |
| 16 | 155 | **13** | 610 | 3.9 |

三张读法要按这张表改口径，之前各自都说过一半：

- **判完数不是"106 篇/时"一个数**：14:40 那次取证（单作业 128.7 秒、4 槽全满、`retry=0`、实测 106）是**下午全链路档案长文**那一段的形状；
  全天 4 槽在 120—173 篇/时之间摆，10 点那格 **199 是 6 槽时段的产物**（10:35:10 探针 slow=2 才被守护降回 4，见 §14 第 3 条）。
  ⇒ 报速率必须连着报"当时几槽、单作业几秒"，只报篇/时会被下一小时打脸。
- **翻译腿 16 点那一格 13 条是真的被挤了**：16:20—16:28 那趟逐期重排单独起了一个 node 进程（`--max-old-space-size=192`），
  `MemAvailable` 同时从 274 MB 掉到 116 MB；17 点头六分钟就回到 7 条（≈70 条/时）。⇒ **逐期重排和翻译腿抢的是同一份内存**，
  以后跑重排要么挑翻译的低峰，要么把那几轮翻译的失败当作预期，别记成"翻译坏了"。
- **调用数全天 610—980 次/时、没有一次撞熔断**：17:05 现值 `ANALYZE_CONCURRENCY=4`、`GEOHOT_TRANSLATE_CONCURRENCY=3`、
  `MODEL_CALLS_ENABLED=true`、`COLLECT_ENABLED=false`；`geohot-conc-guard.timer` 是 active+enabled、自锁标志
  `/etc/geohot/conc-guard.tripped` 不在 ⇒ 守护现在在正常巡逻。
  **但巡逻已经管不着最坏那一档**：16:55:27 那格 `slow=2 bad=1 why: slow=2 floor`（`/geohot/daily.data` 8,181 ms、`/geohot/weekly.data` 5,307 ms），
  而 `conc=4 translate=3` 就是它自己的地板 ⇒ **命中了却没东西可降**。⇒ 再开独占窗口时不能把"守护在"当成安全保证，
  它只能在 4/3 之上起作用；实时暂停期间出现的读者面尖峰也不全记在窗口账上（这一格就是窗口内出现的）。
- **两条量具坑（都记在这儿，别再犯）**：① 守护日志的时间戳是 `2026-10-17T15:59:00+08:00`（ISO 带 `T`），
  我拿 `grep -E "2026-10-17 (1[0-7]):"`（空格那档）去数当天 10 点以后的行，结果是 **0 命中**——
  这会被读成"今天没跑过"，正解是 `grep '2026-10-17T1[0-7]:'` 或 `journalctl -u geohot-conc-guard.service --since`。
  ② `trip_lines=7` 是**整个文件**的累计命中（33 KB 从建文件起），不是今天的次数——引用它之前要先按日期切。

### 第一百一十三轮 · 工单 #257 的量终于摆平了：1,380 条"迟到新闻"带横在早月前面（17:24）

17:24 一次性数出来的现值（Jan–Sep 未判完 = `new` 或 `analyzed 且无 publications 行`）：

| 带 | 条数 | 派发次序 |
| --- | --- | --- |
| 档案带（`priority=-1`，`backfill_reason='archive'`） | **12,379** | 我先验过它队首就是 **2026-01-01**（整带按新闻日期排好） |
| 迟到新闻/首导带（`priority=-2`） | **1,380** | 排在整条 −1 带**之后** |

那 1,380 条按新闻月份的分布：`2025-12 1 ∶ 1 月 48 ∶ 2 月 75 ∶ 3 月 92 ∶ 4 月 119 ∶ 5 月 111 ∶ 6 月 144 ∶ 7 月 186 ∶ 8 月 223 ∶ 9 月 381`。

⇒ **"判完一天重排一天"对早月有个硬前提**：`unsettled()`（`backfill-papers.ts:140-147`）数的是那一天窗口里的**全部**未判完行，
不分带。所以一月的日子哪怕档案带里那几十条判完了，只要它那 48 条还在 −2 带排队尾（要等 −1 带 12,379 条流干，按 106—160 篇/时 ≈ **78—117 小时**），
那一天就永远 `waiting>0`、`--refresh` 就不问。**这不是"少排几条"的误差，是早月能否结算的前件。**

**仓库里那条"受支持的通道"对这一族不管用**（17:36 逐行读过 `scripts/rebalance-archive-queue.ts` 才改的口）：
它的 `WHERE` 是 `state='created' AND priority < -1 AND data->>'articleId' IN (SELECT id FROM articles WHERE backfill_reason='archive')`
⇒ 它搬的是**已经排队的、`backfill_reason='archive'` 的**行（文件头 `:1` 就是"already waiting"，`:3-4` 那句
"That only applies to jobs created after the change"讲的是 `content.ts` 的入队次序改动、不是这个脚本的作用范围——
我 17:24 那一版把这两件事混了，已按源码改正）。**上面那 1,380 条按定义就不是 `archive`**，所以这个脚本一条都搬不到它们。
要把它们提进档案带，只剩两条路：改归类口径（`backfill_reason` 是谁写的、为什么这批迟到新闻没被打上 `archive`，属政策题），
或者做一条**仓库里不支持**的队列 `UPDATE`。⇒ 这条归站长拍，我不自行动共享队列；真要做还得配上我 13:11 那套 `created_on` 按 `timeline_at` 重排与逆序复量，
否则两批 `created_on` 混在一个带里，下午刚证的 0 逆序就作废。


