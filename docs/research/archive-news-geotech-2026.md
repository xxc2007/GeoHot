# 2026 年地理信息技术历史候选核验

核验日：2026-10-10（Asia/Shanghai）。范围：2026-01-01 至 2026-10-10。只新增本报告及对应 JSONL，未写生产库、未改信源清单、未生成评分夹具。

本文件配套 `tooling/corpus/archive-news-geotech-2026.jsonl`，共 30 条候选：QGIS 官方博客 13 条、OpenStreetMap 官方博客 12 条、GDAL 正式版本 5 条。各条的原文标题、原文链接、明确发布日期和读取方法保留在 JSONL 的 raw.provenance 中。正文是读取官方原材料后的中文忠实摘述，不转载全文。所有 sourceId 均来自当场读取的 industry/sources.json。

候选并不意味着精选。招聘、筹资、会议和治理消息故意保留其原始性质，应由原有预筛、两次独立评分与发布工作流判定，不能人工直接授予高分。GIS、开放地图、遥感格式和数据处理库均有覆盖；未声称这一组穷尽导航、卫星观测、所有软件版本或全部日期。

## 日期与正文核验

- QGIS：官方 WordPress 历史 API 返回 posts[].date（显式 +08:00）及完整文章材料。保留时间戳，另记 visiblePublicationDate。例如 3 月 9 日发布页的 API 时间在北京时间已是 3 月 10 日，不能只取 API 字符串前十位来否定原页面日期。原文更新日与发布日分别记录，不以 modified 冒充 published。
- OSM：官方 WordPress REST API 的 date_gmt 加 Z 作为 publishedAt，原站显示日期另存。8 月发表的 3 月会议回顾仍在 8 月发布，不伪装为 3 月快讯。2027 会议征集是 2026 年发布的计划消息。
- GDAL：GitHub Atom 只有 updated，故没有直接用它冒充发布时间。逐个正式版本 HTML 的 relative-time.no-wrap 发布戳独立核验，再读取该版本固定标签 NEWS.md。排除 RC 预发布版本。GitHub 匿名 REST 返回共享出口限流，该问题没有通过重试伪称解决。
- 大会举行日期、申请截止日、计划上线日、拟成为 LTR 的日期均在摘述中标记为计划或事件日期。10 月 QGIS LTR 公告提及 2027-03-05 是预期安排，并非未来事实入库。

## 可持续的历史接口

1. QGIS 官方 WordPress 历史接口： https://public-api.wordpress.com/rest/v1.1/sites/blog.qgis.org/posts/?number=100&after=2026-01-01&before=2026-10-11 。本轮成功读取 13 条，日期过滤能穿透近期 RSS 窗口。超过一页时按 API 分页，避免以当前 RSS 代替全年。
2. OSM 官方 WP REST 历史接口： https://blog.openstreetmap.org/wp-json/wp/v2/posts?after=2026-01-01T00:00:00&before=2026-10-10T23:59:59&per_page=100 。本轮成功读取 12 条。后续按 page 分页并检查总页数；HTML 月归档可作日期复核。
3. GDAL 历史正式发布： https://github.com/OSGeo/gdal/releases ，以及 GitHub /repos/OSGeo/gdal/releases 的分页 REST（本轮匿名限流）。当前 releases.atom 仅覆盖近期约十个版本，不能当成全年。固定标签的 https://raw.githubusercontent.com/OSGeo/gdal/vVERSION/NEWS.md 用于内容核验。发行页逐项发布时间与固定标签说明结合，避免拿代码提交日代替发行日。
4. QGIS 官方博客 /YYYY/MM/ 月归档和 OSM /YYYY/MM/ 归档均可作为列表与原页面的补充。此报告不新增在线采集器，不改 sourceId，历史 API 的接入应由主控统一实现，走现有预算、回执和编辑筛选。

## 本轮候选清单

| 发布时间（按原始时间戳） | 已登记信源 | 原文标题与链接 |
| --- | --- | --- |
| 2026-01-08T14:35:00+08:00 | rss-qgis-blog | [QGIS User Conference 2026 in LAAX](https://blog.qgis.org/2026/01/08/qgis-user-conference-2026-in-laax/) |
| 2026-02-03T10:00:00Z | rss-osm-blog | [Announcing SotM 2026 Travel Grant Program](https://blog.openstreetmap.org/2026/02/03/announcing-sotm-2026-travel-grant-program/) |
| 2026-02-04T00:49:23+08:00 | rss-qgis-blog | [Documentation and Infrastructure Report 2025](https://blog.qgis.org/2026/02/03/documentation-and-infrastructure-report-2025/) |
| 2026-02-24T10:00:00Z | rss-osm-blog | [Announcing SotM 2026 Call for Participation](https://blog.openstreetmap.org/2026/02/24/announcing-sotm-2026-call-for-participation/) |
| 2026-03-06T05:23:24+08:00 | rss-qgis-blog | [Call for contributions: QGIS User Conference & Contributor Meeting 2026](https://blog.qgis.org/2026/03/05/call-for-contributions-qgis-user-conference-contributor-meeting-2026/) |
| 2026-03-10T04:00:45+08:00 | rss-qgis-blog | [QGIS 4.0 Norrköping is released!](https://blog.qgis.org/2026/03/09/qgis-4-0-norrkoping-is-released/) |
| 2026-03-16T01:24:20+08:00 | rss-qgis-blog | [Reports from the winning grant proposals 2025](https://blog.qgis.org/2026/03/15/reports-from-the-winning-grant-proposals-2025/) |
| 2026-03-17T01:10:26+08:00 | rss-qgis-blog | [QGIS Grants #11: Call for Grant Proposals 2026](https://blog.qgis.org/2026/03/16/qgis-grants-11-call-for-grant-proposals-2026/) |
| 2026-03-17T17:00:00+08:00 | rss-qgis-blog | [Welcoming our latest flagship sustaining member – COSS](https://blog.qgis.org/2026/03/17/welcoming-our-latest-flagship-sustaining-member-coss/) |
| 2026-03-18T08:45:27+08:00 | rss-qgis-blog | [QGIS Sustaining Member Campaign 2026](https://blog.qgis.org/2026/03/18/qgis-sustaining-member-campaign-2026/) |
| 2026-04-13T16:06:32+08:00 | rss-qgis-blog | [We’re Hiring! QGIS Administrative Assistant Wanted](https://blog.qgis.org/2026/04/13/were-hiring-qgis-administrative-assistant-wanted/) |
| 2026-04-23T21:29:52+08:00 | rss-qgis-blog | [Plugin Repository Security Enhancements](https://blog.qgis.org/2026/04/23/plugin-repository-security-enhancements/) |
| 2026-04-24T13:30:41Z | atom-gdal-releases | [GDAL 3.12.4](https://github.com/OSGeo/gdal/releases/tag/v3.12.4) |
| 2026-05-08T10:55:44Z | atom-gdal-releases | [GDAL 3.13.0 "Iowa City"](https://github.com/OSGeo/gdal/releases/tag/v3.13.0) |
| 2026-05-11T08:00:00Z | rss-osm-blog | [State of the Map 2027 – Call for Venues is now open](https://blog.openstreetmap.org/2026/05/11/state-of-the-map-2027-call-for-venues-is-now-open/) |
| 2026-05-17T18:28:29+08:00 | rss-qgis-blog | [QGIS Grant Programme 2026 Results](https://blog.qgis.org/2026/05/17/qgis-grant-programme-2026-results/) |
| 2026-05-31T17:35:06Z | rss-osm-blog | [OSMF at the Geospatial World Forum 2026](https://blog.openstreetmap.org/2026/05/31/osmf-at-the-geospatial-world-forum-2026/) |
| 2026-06-05T11:02:34Z | atom-gdal-releases | [GDAL 3.13.1](https://github.com/OSGeo/gdal/releases/tag/v3.13.1) |
| 2026-06-19T22:24:32Z | rss-osm-blog | [2026 Board Face-to-Face (F2F) in Madrid, Spain](https://blog.openstreetmap.org/2026/06/19/2026-board-face-to-face-f2f-in-madrid-spain/) |
| 2026-06-30T10:00:00Z | rss-osm-blog | [State of the Map 2026: Call for Posters](https://blog.openstreetmap.org/2026/06/30/state-of-the-map-2026-call-for-posters/) |
| 2026-07-06T20:41:13+08:00 | rss-qgis-blog | [Coming soon: QGIS Plugins Website v4.0.0](https://blog.qgis.org/2026/07/06/coming-soon-qgis-plugins-website-v4-0-0/) |
| 2026-07-10T10:01:28Z | rss-osm-blog | [OpenStreetMap Foundation and European projects: an invitation to collaborate](https://blog.openstreetmap.org/2026/07/10/openstreetmap-foundation-and-european-projects-an-invitation-to-collaborate/) |
| 2026-07-22T12:45:49Z | atom-gdal-releases | [GDAL 3.13.2](https://github.com/OSGeo/gdal/releases/tag/v3.13.2) |
| 2026-08-18T09:39:09Z | atom-gdal-releases | [GDAL 3.13.3](https://github.com/OSGeo/gdal/releases/tag/v3.13.3) |
| 2026-08-20T18:38:34Z | rss-osm-blog | [A Recap of the March Local Chapters & Communities Congress](https://blog.openstreetmap.org/2026/08/20/a-recap-of-the-march-local-chapters-communities-congress/) |
| 2026-08-21T15:05:40Z | rss-osm-blog | [Thanking Proton, our newest Platinum sponsor](https://blog.openstreetmap.org/2026/08/21/thanking-proton-our-newest-platinum-sponsor/) |
| 2026-09-13T19:52:14Z | rss-osm-blog | [What’s in a name? Naming things in OpenStreetMap](https://blog.openstreetmap.org/2026/09/13/whats-in-a-name-naming-things-in-openstreetmap/) |
| 2026-10-01T09:19:40Z | rss-osm-blog | [Join the 31 Day OSM Challenge this October!](https://blog.openstreetmap.org/2026/10/01/join-the-31-day-osm-challenge-this-october/) |
| 2026-10-03T22:25:46+08:00 | rss-qgis-blog | [Release schedule changes for next QGIS LTR](https://blog.qgis.org/2026/10/03/release-schedule-changes-for-next-qgis-ltr/) |
| 2026-10-05T00:54:41Z | rss-osm-blog | [2026 Community Microgrants call for applications](https://blog.openstreetmap.org/2026/10/05/2026-community-microgrants-call-for-applications/) |

逐月候选数量（时间戳月份）：2026-01: 1, 2026-02: 3, 2026-03: 6, 2026-04: 3, 2026-05: 4, 2026-06: 3, 2026-07: 3, 2026-08: 3, 2026-09: 1, 2026-10: 3。这是条目分布，不能解释为每月所有信息均已完整覆盖。

验收：30 行 JSON 均可解析；30 个 URL 唯一；3 个 sourceId 全部已登记；日期处于任务范围；未写评分/强制精选字段。尚需主控进行生产管道去重、模型筛选、成刊和公开页面验收。
