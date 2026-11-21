# AUDIT-CHANGELOG · 更新日志覆盖审计

- 审计时间：2026-11-21（只读；未改动 `industry/changelog.json`、`MajorRelease.tsx`、`site/meta.ts`、`list-release-versions.mjs` 四个文件）
- 仓库状态：`main` == `origin/main` == `2e5edf22`（2026-11-21 01:51:39 +0800），工作树除未跟踪的 `docs/history/` 外干净
- 一句话结论：**7 个 major 全部有专题卡，标题逐字一致；最新日志之后的 6 个非合并提交里，1 个必须补日志、1 个建议补、1 个属边界、3 个不该硬造；另有 1 处数据完整性缺口——254 条里有 103 条没有 `kind`，在 `/changelog` 上类型标签是空的，侧栏还会多出一行「全部」。**

---

## 一、先纠正两处口径

1. **条目不是 252 条，是 254 条。** `industry/changelog.json` 的 `releases` 长 254，`latestVersion` 为 `2026-11-20T22:40`。多出的两条是 2026-11-20 发布的两个 major（7.0、8.0）。`git tag --list 'v*'` 也是 254 个，与脚本输出的 254 个版本号逐条相同。
2. **`MajorRelease.tsx` 里没有 `MAJOR_RELEASES` 这个标识符。** 卡片映射叫 `CARDS`（`apps/web/app/features/changelog/MajorRelease.tsx:283-294`）。`AGENTS.md:154` 仍写作「`MAJOR_RELEASES` 里按 `dateTtime` 键写文案」，与本文件实际名称不一致——文档漂移，不是代码问题。

---

## 二、跑过的核对（全部可复跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 版本号清单 | `node scripts/list-release-versions.mjs \| wc -l` | 254 行；`grep -P "^v\d+\.0\.0\t"` 得 8 个 `x.0.0`（v1.0.0 起） |
| 日志形状守卫 | `node --test tests/changelog.test.ts` | 2 pass / 0 fail（解析与新在前、标题 ≤22、正文 ≤3 行、每行 ≤80 字） |
| 两处版本算法是否一致 | 用 `node` 动态 import `packages/backend/src/site/meta.ts` 的 `withVersionNumbers`，与脚本输出逐行比对 | `meta.ts rows: 254 script rows: 254 mismatches: 0` |
| 版本 ↔ tag | `node scripts/list-release-versions.mjs \| cut -f1 \| sort` 与 `git tag --list 'v*' \| sort` 做 `diff` | `IDENTICAL: 254 versions == 254 tags` |
| 日志之后的改动面 | `git diff --stat 88ac8e45 HEAD` | 14 个文件，+1137 / −8 |
| 日志之后的提交 | `git rev-list --count --since='2026-11-20 22:40:00 +0800' HEAD` | 11 个（6 个非合并 + 5 个合并），与 `88ac8e45..HEAD` 同数 |

补充：`tests/` 里**没有**任何测试引用 `MajorRelease`、`CARDS` 或 `withVersionNumbers`（`grep -rn "withVersionNumbers\|list-release-versions" tests/` 无输出）。两处算法「必须保持一致」目前只有 `scripts/list-release-versions.mjs:3-4` 的注释，没有测试钉住。

---

## 三、每个 major 都有对应卡片（7/7，另加 1 张回顾卡）

`industry/changelog.json` 共 7 条 `major: true`；`CARDS` 有 8 个键——多出来的 `2026-10-01T22:40` 是 1.0 回顾卡，锚在「GEOHOT 正式上线并开源」这条公告上（`MajorRelease.tsx:291-293` 记录了这个选择：1.0.0 首条在 09-29 08:00，公告在 10-01 22:40）。`changelog.tsx:166-167` 把 7 个 major 动态渲染、1.0 固定渲染在最后。

| 版本（脚本算出） | 日志时间 | 卡片组件 | 定义行 | 卡片标题 = 条目标题 |
| --- | --- | --- | --- | --- |
| v8.0.0 | 2026-11-20T22:40 | `MajorEight` | `MajorRelease.tsx:264` | 是 |
| v7.0.0 | 2026-11-20T22:30 | `MajorSeven` | `:244` | 是 |
| v6.0.0 | 2026-11-15T13:00 | `MajorSix` | `:224` | 是 |
| v5.0.0 | 2026-11-15T12:50 | `MajorFive` | `:204` | 是 |
| v4.0.0 | 2026-11-15T12:40 | `MajorFour` | `:184` | 是 |
| v3.0.0 | 2026-11-01T23:59 | `MajorThree` | `:164` | 是 |
| v2.0.0 | 2026-10-24T07:30 | `MajorTwo` | `:124` | 是 |
| （v1.0.3，非 major） | 2026-10-01T22:40 | `MajorOne` | `:144` | 否，有意为之：1.0 是回顾卡，标题「地理热点上线：一套为地理而生的阅读站」对应条目「GEOHOT 正式上线并开源」 |

反向也查了：`CARDS` 里没有任何键在日志中找不到（`2026-10-01T22:40` 那条公告存在）。**就「卡片是否有」这一项，覆盖是完整的。**

---

## 四、最新条目 → HEAD：6 个非合并提交怎么判

窗口取 `88ac8e45`（22:35 发布 7.0/8.0 条目与卡片）到 HEAD，共 11 个提交（5 合并 + 6 非合并）。之所以不用 22:40 切：8.0 条目的时间是 22:40，而它落在 22:35 的提交里；22:46 那个提交只修剪了这两条的正文。

| # | 提交 | 时间 | 标题 | 实际改动 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `3ae5c0c2` | 22:46 | docs(changelog): keep 7.0/8.0 bodies within the three-line scan limit | 把 7.0/8.0 两条 body 各从 4 行并成 3 行（+4 / −6），只动措辞 | **不补**：它改的就是日志本身 |
| 2 | `574fa158` | 23:23 | fix(reserves): bind participation mode instead of quoting it as a column | `scripts/replenish-reserve-candidates.ts` 1 行 | **P1 建议补**：7.0「坏一个补一个」的写入路径 |
| 3 | `ec0ec174` | 00:26 | docs: record the reader API pool floor and the systemd override trap | `AGENTS.md` +1 行；记录的是生产连接池 2→8/3 | **P2 边界**：改动本身在服务器 `/etc`，不在仓库 |
| 4 | `41533a38` | 01:13 | feat(sources): multi-engine discovery with quality gate and review queue | 11 个文件 +1127；新增 `/admin/discovery` 页、`/api/admin/discovery*`、迁移 0126 | **P0 必须补**：管理员可感知的新功能 |
| 5 | `8b4d04c2` | 01:37 | fix(discovery): give Jina search the measured 35s budget | `search-engines.ts` 3 行，Jina 超时 20s→35s | **不单列**：只影响上面那个新页里的一个引擎，并入 P0 一句即可 |
| 6 | `8310405b` | 01:38 | docs(discovery): list the two remaining DSH engines and why they stay out | `UNSUPPORTED_ENGINES` 加两条说明（DeepSeek Official、知乎站内） | **不补**：后台常量里的「不支持及原因」文字 |

关于第 4 项是否算「用户可见」：`/api/admin/*` 全部走 `adminHandler`（session + CSRF，见 `apps/api/src/routes/admin.ts:1-2`），页面挂在后台布局下（`apps/web/app/routes/admin/layout.tsx:37` 新增「信源发现」导航）。**这是管理员可感知的新功能，不是读者可见。** 依据 `docs/release-sync-policy.md:24` 第 7 条，管理员可感知的功能同样必须同轮写日志；纯内部文档或流程约束则只进内部发布记录。

**在这 11 个提交涉及的 14 个文件里，没有读者页面或读者 API 的实现文件被改；`apps/web/app/routes.ts` 的唯一改动是注册那条后台路由。** 也就是说：8.0 之后没有「读者看得到但没写」的改动；缺口集中在后台。

---

## 五、建议新增条目（标题 ≤20 字、正文 ≤3 行、每行 ≤80 字）

实测字数已按 `String.length` 计（中文 1 字）。三条标题分别为 9 / 10 / 9 字，最长一行 58 字，均满足要求，也满足 `tests/changelog.test.ts:34-43` 的守卫。

### P0 · `41533a38` 多引擎信源发现（必须补）

> 标题：**后台多了信源发现页**（9 字）
>
> 1. 后台新增「信源发现」页：多个搜索 API 并行找候选，同站交叉验证后再现场抓 feed，过质量门的才进待审队列。（56）
> 2. 候选不会直接进正式池：管理员批准才写入，默认暂停；拒绝要写原因，每条都留着引擎证据。（42）
> 3. 不写文章、不调用模型、不产生费用；池满时先退役一个源，再批准。（31）

依据：`docs/source-discovery.md:5-9` 的五步流程与 `:40-44` 的成本边界；页面文案见 `apps/web/app/routes/admin/discovery.tsx:96`（「多引擎搜索 → 同站交叉验证 → 现场抓 feed → 人工批准。候选不会直接进正式池」）。

### P1 · `574fa158` 补位脚本的插入（建议补）

> 标题：**信源补位不再写不进库**（10 字）
>
> 1. 7.0 的补位脚本把参与方式当列名写进插入语句，候选转正时那一行写不进库。（37）
> 2. 改成按值绑定后，替换仍在同一事务里一停一启，失败源先进隔离区，再由已核验的候选顶上。（42）

依据：`scripts/replenish-reserve-candidates.ts:118` 的一行改动（`"editorial"` → `${"editorial"}`），该脚本与 7.0 条目在同一个提交 `88ac8e45` 里新增；提交标题自述为「bind participation mode instead of quoting it as a column」。**未验证的部分**：没有在数据库上执行过这条 SQL，也没法知道 22:30–23:23 之间是否真的跑过补位脚本；「写不进库」是从 SQL 把带引号的 `editorial` 当标识符读出来的结论，不是运行结果。

### P2 · `ec0ec174` 连接池（边界，建议写）

> 标题：**后台不再排队等连接**（9 字）
>
> 1. 读者 API 的连接池从 2 调到 8、调度队列的连接 3：健康探针不再超时，信源页从 40 秒回到 277 毫秒。（58）
> 2. 改完要逐台读回进程的真实环境变量，不能只看 .env——systemd 的配置文件会覆盖它。（46）

依据：`AGENTS.md:56`（2026-11-21 新增那一行，实测 `/api/health` 连续 `query_timeout`、`/admin/sources` 40 秒，改后 health 1ms、信源页 277ms）。**这条的性质要说清**：仓库里这个提交只改了一行文档，真正生效的是服务器上的 `/etc/geohot/database-pools-recovery-20261024.env`。如果团队把「环境变量调参」一律归为内部运维，这条就只进内部发布记录，不写日志——两种做法都说得通，但不要写成「代码修复」。

### 可直接粘贴的 JSON（放在 `releases` 数组最前，保持新在前）

```json
{
  "date": "2026-11-21",
  "time": "01:13",
  "major": false,
  "kind": "新增",
  "title": "后台多了信源发现页",
  "body": [
    "后台新增「信源发现」页：多个搜索 API 并行找候选，同站交叉验证后再现场抓 feed，过质量门的才进待审队列。",
    "候选不会直接进正式池：管理员批准才写入，默认暂停；拒绝要写原因，每条都留着引擎证据。",
    "不写文章、不调用模型、不产生费用；池满时先退役一个源，再批准。"
  ],
  "tags": ["sources", "admin", "discovery"]
}
```

**时间要落在 `2026-11-20T22:40` 之后。** 编号是从最旧往最新扫的（`packages/backend/src/site/meta.ts:31-39`）：加在最新端只会得到 v8.0.1，254 个已发布的版本号一个都不动；插到时间线中间，同一时代内比它新的条目会整体 +1，而 `sync-version-tags.yml:38` 遇到已存在的 tag 直接跳过，不会搬动那 254 个 tag。

---

## 六、不该硬造日志的提交

| 提交 | 为什么不该写 |
| --- | --- |
| `3ae5c0c2` 修剪 7.0/8.0 正文 | 改的是日志文件本身，读者感知不到；写一条「日志变短了」是噪音 |
| `8310405b` 补两条「不支持的引擎及原因」 | 只改后台常量 `UNSUPPORTED_ENGINES` 的说明文字（`packages/backend/src/sources/search-engines.ts:336`、`:340`，数组声明在 `:315`），没有新行为 |
| `8b4d04c2` Jina 超时 35s | 单独写会很怪（「一个搜索接口多等 15 秒」）；它属于 P0 那个页面的实现细节，并入即可 |
| `ec0ec174` 记录连接池下限 | 见 P2：写与不写都成立，取决于团队怎么归类环境变量调参；**但不要包装成产品功能** |

`docs/release-sync-policy.md:24` 给的分界正是这一条：「纯内部文档或流程约束由 Git 提交和内部发布记录说明，不伪造产品功能上线」。

---

## 七、同一份文件的其它缺口（超出本次三项指定核对，但会影响「日志能不能读」）

### 1. 103 条没有 `kind`，页面上的类型标签是空的

`node` 统计：254 条里 103 条没有 `kind` 字段，分布是「更新 31、优化 23、修复 65、新增 14、改进 5、content 1、ops 1、chore 1、fix 5、公告 4、调整 1」。而类型声明把它写成必填的封闭联合（`packages/backend/src/site/meta.ts:9`），JSON 在 `meta.ts:55` 是 `as` 强转进来的，类型检查不到。另有 28 条用了联合里没有的值（新增 14、改进 5、fix 5、content/ops/chore/调整 各 1），**103 + 28 = 131 条与 `ChangelogRelease` 的声明不符**。

页面上的后果，按代码路径推导（`changelog.tsx:192-195` 把 `{r.kind}` 直接渲染在类型那一格）：类型标签是空字符串，只剩一颗灰点（`kindDot(undefined)` → `bg-ink-2`）；侧栏 `[null, ...kinds]`（`:99`、`:123-134`）会因为 `kinds` 里含一个 `undefined`，多出一行 `key="all"`、标签「全部」、计数 254 的重复行——和真正的「全部」行同 key、同文案。我用 node 按同样逻辑跑了一遍数据，输出确实是两行 `key=all label=全部 count=254`。

这与 `docs/known-issues.md:1607-1615` 记的不是同一件事：那里处理的是**未知字符串**类型的兜底，这里是**字段缺失**。

### 2. 卡片映射没有守护，缺卡会静默变成 2.0

`MajorRelease.tsx:297` 是 `CARDS[...] ?? MajorTwo`。以后新增一个 `major: true` 条目却忘了加卡片，页面不会报错，而是把 2.0 的卡片再渲染一遍（`changelog.tsx:166` 按 major 逐条渲染）。`tests/` 里没有任何测试覆盖这层映射。建议补一条静态测试：读 JSON 的 major 时间戳，逐个断言 `CARDS` 有键且组件 `version` 与该条目的版本一致。

### 3. 注释与文档漂移

- `changelog.tsx:164-165` 仍写「三个大版本的专题卡，固定 3.0 → 2.0 → 1.0」，实际是 8 张（2.0–8.0 + 1.0）。
- `AGENTS.md:154` 的 `MAJOR_RELEASES` 与代码里的 `CARDS` 不一致。
- `meta.ts:13` 的注释说「2.0.0 = 2026-10-24 重大更新」，与实算一致，无需改。

### 4. 版本号重算与 tag 不同步的结构性风险

现有 254 个 tag 与 254 个版本号完全对齐，这是当前状态。但编号只依赖数组顺序（`meta.ts:31-39`），一旦补一条旧日期的日志（复盘、补记很常见），同一时代内比它新的条目会整体 +1，而 tag 已经推上去了。`sync-version-tags.yml:36-44` 遇到已存在的 tag 直接 `continue`，不会修正。审计时没发现已经发生的错位，这是提醒，不是现存缺口。

---

## 八、没做的

- 没有启动 web/api 去真机看 `/changelog` 的样子；第七节第 1 条的「空标签 + 两行全部」是按代码路径加数据模拟推出的，不是浏览器实测。
- 没有核实 11-21 的两个提交是否已经部署到生产（仓库侧只能确认已合并且 `HEAD == origin/main`）；按 `docs/release-sync-policy.md:24`，日志时间应填**实际上线时间**，不是提交时间。
- 没有执行过 `replenish-reserve-candidates.ts` 里那条 SQL（见 P1 的「未验证」说明）。
- 没有改任何被审计文件；本文件是唯一的写入。
