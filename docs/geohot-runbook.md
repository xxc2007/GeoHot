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
| 队列堆着不动，日志里有 `BudgetExceeded` / 任务显示等待 | 后台 `/admin/settings` 预算；`select service, count(*) from receipts group by 1` | 每个付费服务有每分钟/每小时/每天上限，超了就暂停（`providers/receipts.ts:98-102`，重试间隔分别 60/600/3600 秒）。填 0 表示立即停用该服务。本机模型是 stub、不花钱，但预算闸门照样生效：一次性灌太多材料时先调大预算或把 `ANALYZE_CONCURRENCY`（`.env`，现在 2）保持小值。`ReceiptBusyError` 是另一个原因——同一份回执正被别的进程占着，等它就行 |
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
共 400 个信源×月份切片：152 片已完成、合出 199 条；248 片在跑、已出 803 条）：**每片实得 1.3–3.2 条，
所以 Jan→今的全量是约 1,800 条的量级，不是 2.3 万条**。为什么每刊每月只有这几条，本轮没有查，
不要把这句当结论用——`archive_ingest.seen` 存在的意义就是把估算换成实测数，现在换了。
按实测筛速，全部档案材料的**判定成本**是一天到两天的账而不是二十天的账——但这句话只说门口能装多少，
没说档案能分到多少：**分到 0**（2026-10-10 04:00 实测：`-1` 档压着 1,506 条、当天到 05:00 只被判定 3 条，
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
关门不是"换条门"是全站停摆；而 60 分钟比任何队列的重试预算都长——`events.group` 是
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

**回滚**：档案材料一律带 `backfill_reason = 'archive'` 且 `article_discoveries.via = 'import'`，一条 SQL 能整批摘掉，同时清 `archive_ingest`；期刊回到 `report_revisions` 的上一版。删之前先 `pg_dump`，与 `deploy/geohot/rollback.sh` 的约定一致。


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
- 排队面：`-1` 档常驻一千三百多条等待，按当前速率约 40 多小时排空，之后是 2,895 条 `new` 还没判。
- **出刊是自动的、但有闸门**：某一天的档案材料没判完时，`backfill-papers.ts` 会说"等 N 条判完"而不出刊
  （防的是同一天被印两遍）。所以历史报纸会在日子陆续"settle"之后成批出现——那时跑一次
  `node --env-file=.env scripts/backfill-papers.ts --from=2026-01-01 --apply --database-url=…` 即可（默认干跑）。
- **验收过的读者面**：2026-01-05 的两条、01-06 的一条档案材料已在线上可见——
  `/items/jhqc7apwkjn63zrnxafuscjxh`（《中国2010–2020年 1 km日尺度多层土壤温度空间自适应估算》）200，
  站内搜索 `/all?q=土壤温度` 也能搜到。
