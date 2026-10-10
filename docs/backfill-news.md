# 非论文新闻历史采集

`scripts/backfill-news.ts` 是独立于 Crossref/期刊回填的入口，分页规则只写在 `industry/news-archives.json`。目前适配 WMO 新闻分页、Library of Congress Worlds Revealed 年月档案首页、国家数据局新闻分页，不表示全部信源都支持历史回填。上海统计候选已存在，但其历史分页尚未纳入此适配器。LOC 月档案如果增加分页，需要先核验并扩展适配器，当前工具不承诺月档案后续页覆盖。

先将对应来源正式登记至 `industry/sources.json` 并通过原有 seed 同步数据库；工具拒绝未登记来源。默认时间范围是 2026-01-01 至执行当天（Asia/Shanghai），默认只读预览，不连接数据库、不写断点、不触发模型。列表日期缺失的记录单独计数并跳过，绝不把采集日作为发布日期。使用来源解析器得到的真实时间，与北京时间的包含首尾日期范围比较；不猜测 URL 中的日期。

```powershell
node scripts/backfill-news.ts --sources=web-wmo-news,intl-loc-worlds-revealed --max-pages=10 --max-items=300 --sleep-ms=1000
node --env-file=.env --env-file=.env.pipeline scripts/backfill-news.ts --apply --database-url-env=DATABASE_URL --from=2026-01-01 --to=2026-10-10 --max-pages=100 --max-items=5000 --sleep-ms=1000
node --test scripts/backfill-news.test.ts
```

`--max-pages` 是本次总页面上限，`--max-items` 是本次符合日期范围且 URL 去重后的数量上限。每条只投 URL、标题和发布日期，使用 `upsertMaterial`，标记 `backfill='archive'`、`via='import'`、实际发现时间，正文保持 pending，后续交由网站原有正文抽取、预筛、打分、写作和归组流程。已有正文与摘要不会被列表短摘要覆盖。已处理完成或拒绝的重复记录不会启动新分析；还处于 new 的记录经过原有单例队列，修复先前入库后入队失败的窗口。

apply 的状态写入 `.data/backfill-news-state.json`（可通过 `--state` 指定 `.data/` 内路径），临时写入后原子改名、文件权限申请 600；Windows 实际保护仍由用户目录 ACL 与 `.gitignore` 提供。状态不包含数据库 URL、密钥或正文。只有整页成功入库并入队后才完成该页；失败页和因条数上限中断的页面重跑，数据库身份规则处理重复。日期范围改变使用独立断点键；dry-run 不读取已完成状态，因此每次都能重新检查来源页面。

工具对重复分页、全部记录均早于起点的分页停止；读取或入队失败输出错误并保留该页未完成状态，退出码 1。页面上限、断点页与 LOC 档案首页的边界需要结合输出计数审查，不能将一次运行的数量当作所有历史消息已覆盖。
