# 非论文新闻历史采集

`scripts/backfill-news.ts` 是独立于 Crossref/期刊回填的入口，分页规则只写在 `industry/news-archives.json`。2026-10-10 当前登记 10 个适配器：WMO、Library of Congress Worlds Revealed、国家数据局、上海市政府、广州市政府、上海统计、UNFPA、IOM、ADB、ECLAC。登记和采集数量均不表示全部信源都支持历史回填。LOC 使用年月档案首页；若月份以后出现后续页，须先核验并扩展适配器，当前工具不承诺未检查的月内分页覆盖。

本轮已有 7 源、192 页、3,417 条符合日期条件的候选经过 canonical 入库流程，这是单次导入执行证据；当时未写入长期新闻 checkpoint，不能把该数字当作持续分页与完整覆盖证明。边界和后续断点必须由周期使用同一状态文件重新观察，数据库原有身份规则避免重复入库，已处理或拒绝记录不会重新启动付费分析。

先将对应来源正式登记至 `industry/sources.json` 并通过原有 seed 同步数据库；工具拒绝未登记来源。默认时间范围是 2026-01-01 至执行当天（Asia/Shanghai），默认只读预览，不连接数据库、不写断点、不触发模型。列表日期缺失的记录单独计数并跳过，绝不把采集日作为发布日期。使用来源解析器得到的真实时间，与北京时间的包含首尾日期范围比较；不猜测 URL 中的日期。

```powershell
node scripts/backfill-news.ts --sources=web-wmo-news,intl-loc-worlds-revealed --max-pages=10 --max-items=300 --sleep-ms=1000
node --env-file=.env --env-file=.env.pipeline scripts/backfill-news.ts --sources=web-wmo-news --apply --database-url-env=DATABASE_URL --from=2026-01-01 --to=2026-10-10 --max-pages=100 --max-items=1000 --sleep-ms=1200 --state=.data/backfill-news-state.json
node --test scripts/backfill-news.test.ts
```

`--max-pages` 是本次总页面上限，`--max-items` 是本次符合日期范围且 URL 去重后的数量上限。每条只投 URL、标题和发布日期，使用 `upsertMaterial`，标记 `backfill='archive'`、`via='import'`、实际发现时间，正文保持 pending，后续交由网站原有正文抽取、预筛、打分、写作和归组流程。已有正文与摘要不会被列表短摘要覆盖。已处理完成或拒绝的重复记录不会启动新分析；还处于 new 的记录经过原有单例队列，修复先前入库后入队失败的窗口。

apply 的状态写入 `.data/backfill-news-state.json`（可通过 `--state` 指定 `.data/` 内路径），临时写入后原子改名、文件权限申请 600；Windows 实际保护仍由用户目录 ACL 与 `.gitignore` 提供。状态不包含数据库 URL、密钥或正文。只有整页成功入库并入队后才完成该页；失败页和因条数上限中断的页面重跑，数据库身份规则处理重复。日期范围改变使用独立断点键；dry-run 不读取已完成状态，因此每次都能重新检查来源页面。

分页停止边界另外写入 state 的 `boundaries`，键包含准确的起止日期和来源；只有非空页面中每条记录都有有效日期、且全部早于起点，才能建立 older-boundary。重跑会重新读取该边界页，再次确认仍旧于起点才停止；如果新记录将旧分页向后推，则继续翻页。旧版本只有 completed、没有边界的状态会重读最后一个已确认页面，恢复实测边界，避免每次跳过旧边界后继续向更早年份爬。

改变起止日期使用新的断点与边界键，完整重新检查列表，不复用旧范围的停止位置；这会重复读取网页，但通过 canonical URL 身份去重避免重复材料和已完成分析。原子断点仍保留已确认 URL，单页条目上限中断可以继续。同一列表未知日期不能建立 older-boundary，空列表视为覆盖未知、保持未完成并报错；重复列表只表示分页异常，输出 limited，不当作范围已经完整覆盖。

生产每次采集必须由周期或同一个 `/opt/geohot/app/.data/archive-cycle/cycle.lock` 的 `flock` 串行保护，并复用 `/opt/geohot/app/.data/backfill-news-state.json`；禁止同时启动独立 CLI 与周期，也不需要额外 worker。单轮选一个来源，`--max-pages` 不超过 200、`--max-items` 不超过 1000，再轮换来源。原始日志放在私有 `.data/` 内。采集输出的 `candidates`、符合日期的 `eligible`、实际 `created`、队列 `queued` 与 `boundaries` 分别审查；older-boundary 是有序来源的观察边界，不能代替正文、筛选质量或出版完成证明。

读取或入队失败输出错误并保留该页未完成状态，退出码 1。页面上限、未知日期与 LOC 档案首页的边界需要结合输出计数审查，不能将一次运行的数量当作所有历史消息已覆盖。
