# 2026 年自然地理、区域气候与水文历史新闻候选

核验日期：2026-10-10。共 30 条，均来自已登记的官方信源 `web-wmo-news`，属于候选材料，尚未经过生产模型双评分、归组和出刊，不代表入选。

## 来源与历史入口

[WMO News Portal](https://wmo.int/news) 支持 `?page=N` 翻页。本次连续读取第 0 至 15 页，提取 `a.group` 中新闻标题、详情链接和 `span.text-sm` 发布日期，仅选择 `/media/news/` 路径。索引得到 78 条二〇二六年官方新闻，抽取以下 30 条进行独立详情核验。顺序请求间隔 400–500 ms，无认证、无绕过访问限制。

每条详情均独立返回 HTTP 200，h1 与索引原文标题完全一致，具有实质正文。只有标题、日期、链接和忠实中文材料摘述进入 JSONL；未复制全文，没有评分、判断夹具或灾损推断。

## 月份覆盖

| 新闻发布日期月份 | 已核验候选数 |
| --- | ---: |
| 2026-01 | 3 |
| 2026-02 | 3 |
| 2026-03 | 3 |
| 2026-04 | 3 |
| 2026-05 | 3 |
| 2026-06 | 3 |
| 2026-07 | 3 |
| 2026-08 | 3 |
| 2026-09 | 4 |
| 2026-10 | 2 |

## 日期和入库边界

- `publishedAt` 为官网明确显示的日期，只精确到日，没有虚构时钟或发布时间区。
- `discoveredAt` 是本轮实际核验时刻。历史回填应显式采用 `--archive`，不得用重新锚定将旧新闻伪装为当前新闻。
- 同一报告可能有二〇二五年观测、二〇二六年发布两个年份；正文已逐条区分。季节预测只写为预测，不冒充后续已发生事件。
- 灾害报道的早期机制、伤亡和救援信息会修订。候选摘要尽量不重复阶段性数字，并保留初步性质。
- `sourceId` 精确指向现有登记；未修改 `industry/sources.json`，未运行采集或生产任务。

## 候选明细

| 新闻发布日期 | 原文标题 | 原文 |
| --- | --- | --- |
| 2026-01-13 | Climate Variability Emerges as Both Risk and Opportunity for the Global Energy Transition | [WMO](https://wmo.int/media/news/climate-variability-emerges-both-risk-and-opportunity-global-energy-transition) |
| 2026-01-14 | Ice Memory Foundation inaugurates Sanctuary in Antarctica | [WMO](https://wmo.int/media/news/ice-memory-foundation-inaugurates-sanctuary-antarctica) |
| 2026-01-14 | WMO confirms 2025 was one of warmest years on record | [WMO](https://wmo.int/media/news/wmo-confirms-2025-was-one-of-warmest-years-record) |
| 2026-02-10 | Extreme heat, cold, precipitation and fires mark the start of 2026 | [WMO](https://wmo.int/media/news/extreme-heat-cold-precipitation-and-fires-mark-start-of-2026) |
| 2026-02-13 | Tropical cyclone Gezani hits Madagascar and threatens Mozambique | [WMO](https://wmo.int/media/news/tropical-cyclone-gezani-hits-madagascar-and-threatens-mozambique) |
| 2026-02-20 | New initiatives launched to address extreme heat in South Asia | [WMO](https://wmo.int/media/news/new-initiatives-launched-address-extreme-heat-south-asia) |
| 2026-03-03 | ENSO neutral conditions expected as La Niña fades, but El Niño chances rise | [WMO](https://wmo.int/media/news/enso-neutral-conditions-expected-la-nina-fades-el-nino-chances-rise) |
| 2026-03-20 | World Day for Glaciers: Science must inform action | [WMO](https://wmo.int/media/news/world-day-glaciers-science-must-inform-action) |
| 2026-03-23 | Earth’s climate swings increasingly out of balance | [WMO](https://wmo.int/media/news/earths-climate-swings-increasingly-out-of-balance) |
| 2026-04-24 | WMO: Likelihood increases of El Niño | [WMO](https://wmo.int/media/news/wmo-likelihood-increases-of-el-nino) |
| 2026-04-29 | European State of the Climate 2025: record heatwaves from the Mediterranean to the Arctic, while glaciers shrink and snow cover declines | [WMO](https://wmo.int/media/news/european-state-of-climate-2025-record-heatwaves-from-mediterranean-arctic-while-glaciers-shrink-and) |
| 2026-04-30 | South Asia is expected to receive below average monsoon rainfall | [WMO](https://wmo.int/media/news/south-asia-expected-receive-below-average-monsoon-rainfall) |
| 2026-05-18 | Rising land and ocean temperatures, wilder water cycle, glacier retreat hit Latin America and Caribbean | [WMO](https://wmo.int/media/news/rising-land-and-ocean-temperatures-wilder-water-cycle-glacier-retreat-hit-latin-america-and) |
| 2026-05-22 | NOAA forecasts below-average hurricane season | [WMO](https://wmo.int/media/news/noaa-forecasts-below-average-hurricane-season) |
| 2026-05-28 | New report suggests more global temperature records ahead | [WMO](https://wmo.int/media/news/new-report-suggests-more-global-temperature-records-ahead) |
| 2026-06-02 | WMO: Prepare for El Niño | [WMO](https://wmo.int/media/news/wmo-prepare-el-nino) |
| 2026-06-17 | Extreme heat and rainfall, glacier loss and record ocean heat impact Asia in 2025 | [WMO](https://wmo.int/media/news/extreme-heat-and-rainfall-glacier-loss-and-record-ocean-heat-impact-asia-2025) |
| 2026-06-18 | Extreme weather and climate events impact millions in Africa in 2025 | [WMO](https://wmo.int/media/news/extreme-weather-and-climate-events-impact-millions-africa-2025) |
| 2026-07-07 | Ocean warming, marine heatwaves and sea-level rise | [WMO](https://wmo.int/media/news/ocean-warming-marine-heatwaves-and-sea-level-rise) |
| 2026-07-09 | Western Europe has hottest June on record | [WMO](https://wmo.int/media/news/western-europe-has-hottest-june-record) |
| 2026-07-10 | WMO highlights sand and dust storm hotspots, impacts and research | [WMO](https://wmo.int/media/news/AirborneDustBulletinJuly25) |
| 2026-08-12 | Record-breaking heat and extreme weather continue | [WMO](https://wmo.int/media/news/record-breaking-heat-and-extreme-weather-continue) |
| 2026-08-19 | El Niño impacts Greater Horn of Africa | [WMO](https://wmo.int/media/news/el-nino-impacts-greater-horn-of-africa) |
| 2026-08-27 | Flood tragedy in Nepal highlights cross-border and cascading risks | [WMO](https://wmo.int/media/news/flood-tragedy-nepal-highlights-cross-border-and-cascading-risks) |
| 2026-09-07 | WMO bulletin shows air quality and climate interlinkages | [WMO](https://wmo.int/media/news/wmo-bulletin-shows-air-quality-and-climate-interlinkages) |
| 2026-09-11 | Earth has hottest August on record | [WMO](https://wmo.int/media/news/earth-has-hottest-august-record) |
| 2026-09-17 | WMO: Recent water trends have serious future implications | [WMO](https://wmo.int/media/news/wmo-recent-water-trends-have-serious-future-implications) |
| 2026-09-25 | UN General Assembly adopts declaration on sea level rise | [WMO](https://wmo.int/media/news/un-general-assembly-adopts-declaration-sea-level-rise) |
| 2026-10-01 | El Niño will unleash multiple hazards in South-West Indian Ocean region | [WMO](https://wmo.int/media/news/el-nino-will-unleash-multiple-hazards-south-west-indian-ocean-region) |
| 2026-10-08 | Sea-surface temperatures reflect strengthening El Niño | [WMO](https://wmo.int/media/news/sea-surface-temperatures-reflect-strengthening-el-nino) |

## 未覆盖和未入选范围

这不是全年完整清单：其余 48 条索引结果没有纳入这份语料，其中包括机构会议、纪念活动和项目通告。本份清单未声称这些条目已核验正文或一定值得公开。未核验项、404 和未来日期没有混入。由于主任务还有其他研究分组，本组专注 WMO 官方自然、区域气候和水文新闻；跨机构交叉印证及其他区域覆盖须由总工作流继续补充。页面索引内容会随新发稿翻页移动，故 raw.provenance 同时保存原始日期、详情地址、核验时间与正文引导段哈希。
