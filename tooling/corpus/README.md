# tooling/corpus —— 演示语料的真源（人工策划，非新闻订阅）

这个目录是 GEOHOT 演示数据的**唯一真源**，从仓库外的研究草稿目录搬进来（2026-09-30），
目的是让 `npm run seed:curated` 与 `node tooling/merge-corpus.mjs` 在删掉仓库外的一切临时产物之后
仍然能原样重建站点内容。**删掉 `.brief/` 不会影响这里。**

## 这是什么 / 不是什么

- **是**：地理编辑（语料 agent）在 2026-09-29 至 2026-10-01 期间**逐条人工撰写**的判断与文案——
  预筛结论、五维关注度打分、中文标题与摘要、事实结构、归组与日/周/月报的头条与综述。
  每一行 brain 片段的 `author` 就是署名的人，`tooling/fixtures/*.jsonl` 现有 548 行、**每行都有署名**
  （0 行空 author），署名人共 9 位（另有 44 行是 `tooling 示例（未核验）`，即 stub 自带的样例，不是语料）：
  `GEOHOT 灾害事件策划（已核对信源原文）`、`地理编辑（气候与观测数据 beat）`、`GEOHOT 中国区域策划（已核对信源原文）`、
  `野外与考察语料 agent（2026-09-29 实抓核验）`、`GEOHOT 地理信息技术语料 agent（Wave 2）`、
  `地理编辑（研究与科学发现口）`、`覆盖补全 agent（2026-09-30 实抓核验）`、
  `GEOHOT 覆盖补全语料 agent（2026-10-01 逐条 curl 实抓核验）`、`值主编 GEOHOT 地理日报`。
  按 AGENTS.md 的所有权边界：读者看到的每一条"编辑判断"都能在这里回溯到署名的人；stub 不是作者。
- **材料的数字是真的**：`*-materials.jsonl` 的 `url` 与 `bodyText` 来自当天 `curl` 实抓并逐条验证过 HTTP 200
  的真实信源（USGS / CENC / GDACS / Copernicus C3S / WMO / Carbon Brief / Mongabay / ESA / NOAA / 水利部 /
  应急部 / 统计局 / 澎湃新闻 等，全部登记在 `industry/sources.json`），正文是抓取文本的逐字摘录，
  不是编造的样例。
- **不是**：实时新闻订阅。这是**演示 / 策展数据**——一次写好、时间线由 `scripts/seed-curated.ts` 重锚到
  入库当天，好让 48 小时热度窗口、事件归组、热点榜、日报都有内容可展示。
  它不会随时间更新，也不代表站点上线后的真实采集结果；接真实信源时整份语料可以删。

## 文件

| 文件 | 主题（分类口径） | 数据行（brain + materials） |
|---|---|---|
| `corpus-hazards-materials.jsonl` / `-brain.jsonl` | 灾害事件（自然地理 / disaster_event） | 142 + 25 |
| `corpus-china-materials.jsonl` / `-brain.jsonl` | 中国区域·政策·人文地理（区域/人文） | 71 + 18 |
| `corpus-climate-materials.jsonl` / `-brain.jsonl` | 气候与观测数据发布 | 71 + 13 |
| `corpus-fill-materials.jsonl` / `-brain.jsonl` | 覆盖补全桌（把缺口材料补进各分类） | 71 + 19 |
| `corpus-fieldwork-materials.jsonl` / `-brain.jsonl` | 野外与考察 + 观点与解读 | 56 + 14 |
| `corpus-geotech-materials.jsonl` / `-brain.jsonl` | 地理信息技术 | 46 + 15 |
| `corpus-science-materials.jsonl` / `-brain.jsonl` | 研究与科学发现 | 32 + 13 |
| `corpus-report-brain.jsonl` | 值主编：日报头条/导语/看点、周报月报、事件综述 | 15 + 0 |
| `curated-materials.jsonl` | **产物**，由 `merge-corpus.mjs` 写出，入库脚本的输入 | 117 |
| `merge-conflicts.md` | **产物**，`merge-corpus.mjs` 每次非 dry-run 重写的冲突账本（见下） | — |

片段合计 621 行数据（判断 504 行 + 材料 117 行）；`tooling/fixtures/*.jsonl` 合并去重后 548 行。

## 现在跑合并是什么结果（以及怎么自己核对）

```bash
node tooling/merge-corpus.mjs --report           # 期望退出码 0
node tooling/merge-corpus.mjs --strict           # 期望退出码 0
node tooling/merge-corpus.mjs --dry-run --report # 期望退出码 0（不落盘，只校验）
npm run brain -- --lint                          # 期望退出码 0
```

2026-10-01 实测的当前数（`--dry-run --report` 最后那行「静默失败账」）：
`warned=0 shadowed=0 collision=0 noteDrift=0 死键告警=0 无署名=0 fixture自查=0 分级漂移=20`，
材料「解析 117 行 → 接受 117 行 → 写出 117 行」，`REJECTED（0）`。
片段与 fixture 现在逐行一致：`node tooling/merge-corpus.mjs --rebuild --dry-run --report` 同样退 0，
把 rebuild 的产物与仓库里的 fixture 逐行对拍，**548 行逐字相同**（只差行序），没有任何一行被当孤儿丢掉。
只剩一类非 0 是**有意保留的账目**，不是待修的缺陷：

- `分级漂移=20`：材料片段自己抄了一份 `sourceTier`，与 `industry/sources.json` 漂开。**登记表是唯一真值**，
  合并输出与候选表复算都用登记表那一档，这 20 条只是点名让你知道片段的副本旧了。


## 退出码的两层闸门（2026-10-01 改过默认）

- **默认就退出码 1**：任何「有人写过、但运行时一行都不会生效」的判断被吞掉——
  即 `SHADOWED`（同一份材料被两行命中、被吞那行的 reply 与生效行不同）与身份键等价的两份不同人工判断。
  以前这两类只打印一行就继续写盘，所以从来没有人在拦；`--no-strict-shadows` 只留给排障（明知要吞、先出账本）。
- **`--strict` 再叠加**：`warned` / 同 id 的片段↔fixture 答案漂移 / 死键告警 / 日报周报死针 / 缺 author / 未解码 HTML 实体。
  这些都是「值得复核但内容没丢」，默认只写账本不拦。同 id 漂移动辄几十行，留在失败名单里会盖住真正被吞的那一条。

## merge-conflicts.md 是什么

`tooling/merge-corpus.mjs` 自己生成的八节机器可读账本（不是手写文档，不要手改，改了下次会被覆盖）：
一、同 URL 的材料副本与身份键死因；二、身份键等价的两份人工判断；二·b、`--rebuild` 顶掉的 fixture 旧副本；
二·c、同 id 只差 note/what 的账目漂移；三、first-match-wins 吞行；四、身份键命中 0 份材料；
五、日报/周报的键在复算候选表下能否触发；六、缺 author 的行；七、材料层告警；八、候选表复算全文（每期的编号表）。
计数行与 `--strict` 命中数写在文件头。**`--dry-run` 不写这个文件**，所以它的正文是上一次真跑合并的结果。

## 2026-10-01 清掉的三类静默丢内容（每条都记了归属依据）

修前实测：`collision=31`、`SHADOWED 1 条`（吞掉一条 structure 人工判断）、材料「解析 118 → 接受 117」，
另有 6 行 brain 被拒，退出码 1。处置与依据：

1. **24 行片段 ↔ fixture 的答案级漂移**（9 行 prefilter + 15 行 scores）：**以 fixture 为准**，把片段同步成现判定。
   依据是算术与门槛，不是"谁新"：Wave 4 把门槛重算成 T1=56/T1_5=59/T2=62 之后，fixture 那 15 行的 `note`
   五轴加权与 `attentionScore` 自洽（例：score-cb-amazon 的 note 算出 69、行里就存 69），
   而片段那 15 行存的是 68/70/61 这类**与自己 note 对不上**的旧值，note 还引 126/116 这类旧门槛；
   prefilter 的 9 行片段还是 PASS/BLOCK 未定稿前的短理由，fixture 是逐条核对过第①—⑤类的那版
   （其中 3 行是 PASS→BLOCK 的定稿翻转，与 GEOHOT-BRIEF §1 决策 5 的补充规则一致）。
   `--strict` 会重新拦住这类漂移（collision-drift），所以漂回去不会再被放过。
   同一批同步还并掉了 **83 行只差 `note`/`what` 的片段**（`noteDrift` 84→0）：那些 note 引的还是 Wave 4 之前的
   门槛 58/63/72 与入选线 116/126/144，不并的话 `--rebuild` 会把它们从片段里复活——实测修前
   `--rebuild --dry-run` 因这 29 条旧门槛结论退 1，现在退 0。
2. **7 行以片段为准**（5 行 structure 的 `subjects` + 卡利甘达基滑坡的 prefilter/understand）：
   `subjects:["mwr"]`/`["stats"]` 现在成立——`industry/taxonomy.ts` 的 ENTITIES 已经有 `mwr` 与 `stats` 两个 id
   （fixture 那版留空、并在 `what` 里写「ENTITIES 里没有国家统计局」，那条说明现在是过期的）；
   覆盖补全桌把三行的身份键统一成材料 URL 里逐字连续的 `kaligandaki-river-landslide-1`。
3. **两份"同一份材料被两个桌各写一遍"的重复判断**——规则是**谁的桌 owns 那份入库材料谁答题**，
   另一桌的判断不删内容、并进胜出行的 `dissent` 留档（`dissent` 不答题，stub 从不读它）：
   - `https://eos.org/thelandslideblog/kaligandaki-river-landslide-1`：标准件在 `corpus-fill-materials.jsonl#L15`
     （科学桌那份同 URL 副本被合并判重丢弃，已删），且覆盖补全桌为它配齐了 prefilter/understand/structure/scores 四行；
     于是删掉研究桌的 `structure-b2`、`score-b2`，把两份判断（`physical` 53/55 胜、`comment` 41/41 存档）写进
     `structure-fill-eos-kaligandaki-landslide` 与 `score-fill-eos-kaligandaki-landslide` 的 `dissent`。
     科学桌把发生日读成博客发文日 09-29，而文章自己写 «On 27 September 2026, a large landslide occurred»，
     这是采本桌的实质理由；两桌结论都是不入选，读者侧的差别只在展示的分数与均值。
     这两行原本只存在于 fixture、片段里没有（`--rebuild` 会把它们当孤儿丢掉），现在已回填进 `corpus-fill-brain.jsonl`。
   - 《Geographical》2026 年 10 月刊目录预告：野外桌写 `prefilter-noise-geographical-magpreview` 时这份材料
     还没进语料（该行自己的 `pendingMaterial` 就写着「本期策划语料未收」），身份键按英文题名钉；
     覆盖补全桌 09-30 实抓入库后按 URL 重钉了一行同为 BLOCK 的判断。删掉野外桌那行（它在新材料集上是死键），
     原判断进 `prefilter-fill-noise-geo-magpreview` 的 `dissent`。
4. **5 行 understand 的 `summaryZh` 有 4 个句读**（契约 2–3 句，`SENTENCES` 把 `；` 也算一次断句）：
   把分号/句号并成逗号改写了一处连接，**事实、数字、口径一个字没删**，字数不变（184/151/181/166/155 字，都在 200 内）。

## 从仓库内重建（片段 → fixtures → 入库）

```bash
npm run db:up -- --daemon                    # embedded PostgreSQL, 127.0.0.1:5433
node tooling/merge-corpus.mjs --dry-run --report   # 先看校验，不写盘（期望 0）
node tooling/merge-corpus.mjs --report             # 写 tooling/fixtures/*.jsonl + 本目录 curated-materials.jsonl（期望 0）
npm run brain -- --lint                            # 提示词锚点与 fixture 对得上（期望 0）
npm run seed:curated -- --dry-run --enforce-source # 入库预演（默认输入就是本目录的 curated-materials.jsonl）
npm run seed:curated -- --enforce-source           # 真入库：走 upsertMaterial + queueProcessing
```

三个默认路径都在仓库内，不再依赖仓库外目录：`--corpus-dir` 默认 `tooling/corpus`，
`--out` 默认 `tooling/corpus/curated-materials.jsonl`，`--fixtures-dir` 默认 `tooling/fixtures`；
`scripts/seed-curated.ts` 的 `--input` 默认 `tooling/corpus/curated-materials.jsonl`。
**片段是语料的唯一真源**：改过片段之后要用 `node tooling/merge-corpus.mjs --rebuild`，
否则 fixture 里的旧副本会继续答题（追加模式不覆盖同 id 的既有行，`--rebuild` 才让片段说了算）。
`--rebuild` 有一道守卫：片段与 fixture 的**答案**（除 note/what）不同时它硬失败，防止把已定稿的判断换回旧副本——
所以整修片段的正确顺序是先让两边一致（上面第 1、2 条那种同步），再 rebuild。
`curated-materials.jsonl` 的 `discoveredAt` 在 `--discovered-at=auto`（默认）下按墙上时钟算，所以每次重新合并
这一列会变；要字节可复就传 `--discovered-at=<ISO>`。`tooling/fixtures/*.jsonl` 与时间无关，重跑字节不变（已实测幂等）。
