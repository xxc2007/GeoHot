# 官方订阅源发布主体补全记录

2026-10-20 核验。此次仅补全下列 14 个既有 RSS 来源的 `owner_entity_id`，不新增来源，不调整启用状态、评分、采集地址、分类或全文展示权限；启用数仍为 666。

| 发布主体 | 既有来源 ID | 官方依据 |
| --- | --- | --- |
| NASA | `us-nasa-iotd`、`us-nasa-center-hq`、`us-nasa-center-glenn`、`us-nasa-center-jpl`、`us-nasa-center-ames`、`us-nasa-center-kennedy` | [NASA RSS 目录](https://www.nasa.gov/rss-feeds/)明确列出今日图像、总部及这些中心的内容订阅；配置的来源地址均为 `www.nasa.gov` 的对应栏目。 |
| NOAA | `us-noaa-nhc-index-ep`、`us-noaa-nhc-gis-ep`、`us-noaa-nhc-index-ep-sp`、`us-noaa-aoml-home`、`us-noaa-spc-home`、`us-noaa-ncei` | [NOAA RSS 目录](https://www.noaa.gov/rss-feeds)列出 NWS、NHC 与 NCEI 频道；这组配置地址分别位于 `nhc.noaa.gov`、`aoml.noaa.gov`、`spc.noaa.gov`、`ncei.noaa.gov` 的官方发布域。归属判断同时与现有 `PUBLISHER_DOMAINS` 一致。 |
| USGS | `us-usgs-eq-all-day`、`us-usgs-eq-m25-week` | [USGS Feeds & Notifications](https://earthquake.usgs.gov/earthquakes/feed/v1.0/)列出地震数据订阅格式；现有配置使用该官方目录下的 `summary/all_day.atom`、`summary/2.5_week.atom`。 |

此处归属指机构发布渠道，不指单篇文章作者或文章中所有结论的提出者。NASA 各中心归入同一发布主体、NOAA 各频道归入同一发布主体；多个频道刊载同一材料不能算多家独立机构的交叉核证。USGS 不同震级/时间窗的订阅仍可能重叠，应由原始事件 URL/ID 与多来源观察记录处理。

上述官方目录与机构域可以支持发布主体归属，不能单独证明全文转载许可、每个订阅的持续可达性、每篇文章的地理相关性或精选质量。本次没有据此开启任何全文权限，也没有把第三方 RSS 镜像登记为原发布机构。

部署时应在来源注册容量与审核版本迁移已通过的前提下，使用现有来源 seed/审核更新机制同步数据库。仅发布 JSON 文件不会自动更新生产登记；同步后须读回这 14 条归属及启用总数。当前生产状态以实际数据库读回为准。
